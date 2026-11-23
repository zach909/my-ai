package com.example.engine

import android.Manifest
import android.accessibilityservice.AccessibilityService
import android.annotation.SuppressLint
import android.app.AlarmManager
import android.bluetooth.BluetoothManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.PermissionInfo
import android.hardware.Sensor
import android.hardware.SensorManager
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.CalendarContract
import android.provider.CallLog
import android.provider.ContactsContract
import android.provider.DocumentsContract
import android.provider.Settings
import android.provider.Telephony
import android.telephony.SmsManager
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import com.example.service.FloatingOrbService
import com.example.service.NeuroServiceBridge
import java.text.DateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

data class PermissionAuditEntry(
    val permission: String,
    val shortName: String,
    val granted: Boolean,
    val isDangerous: Boolean
)

data class SpecialAccessStatus(
    val overlayGranted: Boolean,
    val accessibilityConnected: Boolean,
    val notificationListenerConnected: Boolean,
    val exactAlarmAllowed: Boolean,
    val floatingOrbRunning: Boolean
)

data class InstalledAppEntry(
    val label: String,
    val packageName: String
)

data class DeviceToolDescriptor(
    val name: String,
    val title: String,
    val description: String,
    val samplePrompt: String,
    val requiredPermission: String? = null
)

data class DeviceToolResult(
    val toolName: String,
    val success: Boolean,
    val summary: String,
    val promptSuggestion: String? = null
)

/**
 * Full-parity NeuroClaw DeviceTools module:
 * - Audits all declared normal, runtime, and special-access permissions
 * - Reads device telemetry, sensors, Wi-Fi, Bluetooth, telephony, SMS, call log, contacts, calendar
 * - Exposes installed app discovery + launcher (`QUERY_ALL_PACKAGES`)
 * - Inspects captured notifications (`NotificationListenerService`) & screen hierarchy (`AccessibilityService`)
 * - Performs global navigation (`Back`, `Home`, `Recents`), direct contact/calendar writes, haptic feedback,
 *   and SAF DocumentTree workspace browsing.
 */
class DeviceTools(private val context: Context) {

    @Volatile
    var linkedWorkspaceTreeUri: Uri? = null

    fun catalog(): List<DeviceToolDescriptor> = listOf(
        DeviceToolDescriptor("permission_audit", "Permission Audit", "Live audit of runtime & special-access permissions", "tool: permission_audit"),
        DeviceToolDescriptor("device_info", "Device Info", "Model, Android SDK, locale, and app version", "tool: device_info"),
        DeviceToolDescriptor("network_status", "Network & Wi-Fi", "Active transports, validation & Wi-Fi SSID/link info", "tool: network_status", Manifest.permission.ACCESS_NETWORK_STATE),
        DeviceToolDescriptor("battery_status", "Battery Status", "Battery level and charging state", "tool: battery_status"),
        DeviceToolDescriptor("sensor_status", "Sensors", "Hardware accelerometer, gyro, step, heart/body sensors", "tool: sensor_status"),
        DeviceToolDescriptor("get_location", "Location", "Last known GPS / network coordinates", "tool: get_location", Manifest.permission.ACCESS_COARSE_LOCATION),
        DeviceToolDescriptor("list_contacts", "Contacts", "Read local contacts", "tool: list_contacts", Manifest.permission.READ_CONTACTS),
        DeviceToolDescriptor("list_calendar_events", "Calendar Events", "Upcoming calendar entries", "tool: list_calendar_events", Manifest.permission.READ_CALENDAR),
        DeviceToolDescriptor("read_sms_inbox", "Read SMS Inbox", "Recent SMS messages (if READ_SMS granted)", "tool: read_sms_inbox", Manifest.permission.READ_SMS),
        DeviceToolDescriptor("read_call_log", "Read Call Log", "Recent calls (if READ_CALL_LOG granted)", "tool: read_call_log", Manifest.permission.READ_CALL_LOG),
        DeviceToolDescriptor("telephony_status", "Telephony State", "SIM operator, network type & call state", "tool: telephony_status", Manifest.permission.READ_PHONE_STATE),
        DeviceToolDescriptor("bluetooth_status", "Bluetooth", "Adapter state and bonded devices", "tool: bluetooth_status", if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) Manifest.permission.BLUETOOTH_CONNECT else null),
        DeviceToolDescriptor("list_notifications", "Notifications", "Recent notifications via NotificationListener", "tool: list_notifications"),
        DeviceToolDescriptor("inspect_screen", "Inspect Screen UI", "Read foreground window nodes via Accessibility", "tool: inspect_screen"),
        DeviceToolDescriptor("list_installed_apps", "Installed Apps", "Discover launchable apps on device", "tool: list_installed_apps"),
        DeviceToolDescriptor("list_workspace_files", "Workspace Files", "List files in linked SAF workspace folder", "tool: list_workspace_files"),
        DeviceToolDescriptor("vibrate_haptic", "Vibrate Pulse", "Trigger tactile confirmation pulse", "tool: vibrate_haptic"),
        DeviceToolDescriptor("open_app_settings", "App Settings", "Open Android system settings for NeuroClaw", "tool: open_app_settings")
    )

    fun specialAccessStatus(): SpecialAccessStatus {
        val overlay = Settings.canDrawOverlays(context)
        val a11y = NeuroServiceBridge.accessibilityServiceInstance != null
        val enabledListeners = runCatching {
            Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners").orEmpty()
        }.getOrDefault("")
        val notifConnected = NeuroServiceBridge.isNotificationListenerConnected ||
            enabledListeners.contains(context.packageName)
        val alarmAllowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
            am?.canScheduleExactAlarms() ?: true
        } else {
            true
        }
        return SpecialAccessStatus(
            overlayGranted = overlay,
            accessibilityConnected = a11y,
            notificationListenerConnected = notifConnected,
            exactAlarmAllowed = alarmAllowed,
            floatingOrbRunning = NeuroServiceBridge.isFloatingOrbRunning
        )
    }

    fun auditPermissions(): List<PermissionAuditEntry> {
        val pm = context.packageManager
        val pkgInfo: PackageInfo = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getPackageInfo(
                    context.packageName,
                    PackageManager.PackageInfoFlags.of(PackageManager.GET_PERMISSIONS.toLong())
                )
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
            }
        }.getOrNull() ?: return emptyList()

        val requested = pkgInfo.requestedPermissions ?: return emptyList()
        return requested.distinct().map { perm ->
            val granted = checkSpecialOrStandardGrant(perm)
            val isDangerous = isDangerousPermission(pm, perm)
            PermissionAuditEntry(
                permission = perm,
                shortName = perm.substringAfterLast('.'),
                granted = granted,
                isDangerous = isDangerous
            )
        }.sortedWith(compareByDescending<PermissionAuditEntry> { it.isDangerous }.thenBy { it.shortName })
    }

    private fun checkSpecialOrStandardGrant(perm: String): Boolean {
        return when (perm) {
            Manifest.permission.SYSTEM_ALERT_WINDOW -> Settings.canDrawOverlays(context)
            Manifest.permission.BIND_ACCESSIBILITY_SERVICE -> NeuroServiceBridge.accessibilityServiceInstance != null
            Manifest.permission.BIND_NOTIFICATION_LISTENER_SERVICE -> specialAccessStatus().notificationListenerConnected
            Manifest.permission.SCHEDULE_EXACT_ALARM -> specialAccessStatus().exactAlarmAllowed
            else -> ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED
        }
    }

    fun missingRuntimePermissions(): List<String> {
        return auditPermissions()
            .filter { entry ->
                entry.isDangerous &&
                    !entry.granted &&
                    entry.permission != Manifest.permission.ACCESS_BACKGROUND_LOCATION &&
                    isApplicableForCurrentSdk(entry.permission)
            }
            .map { it.permission }
    }

    private fun isApplicableForCurrentSdk(perm: String): Boolean = when (perm) {
        Manifest.permission.POST_NOTIFICATIONS -> Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        Manifest.permission.NEARBY_WIFI_DEVICES -> Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        Manifest.permission.BLUETOOTH_CONNECT,
        Manifest.permission.BLUETOOTH_SCAN,
        Manifest.permission.BLUETOOTH_ADVERTISE -> Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
        Manifest.permission.ACTIVITY_RECOGNITION,
        Manifest.permission.ACCESS_BACKGROUND_LOCATION -> Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        else -> true
    }

    private fun isDangerousPermission(pm: PackageManager, perm: String): Boolean {
        val info = runCatching {
            @Suppress("DEPRECATION")
            pm.getPermissionInfo(perm, 0)
        }.getOrNull() ?: return false
        val base = info.protectionLevel and PermissionInfo.PROTECTION_MASK_BASE
        return base == PermissionInfo.PROTECTION_DANGEROUS
    }

    fun listInstalledApps(query: String = "", limit: Int = 60): List<InstalledAppEntry> {
        val pm = context.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val resolved = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            pm.queryIntentActivities(intent, 0)
        }
        val cleanQuery = query.trim().lowercase()
        return resolved
            .mapNotNull { ri ->
                val pkg = ri.activityInfo?.packageName ?: return@mapNotNull null
                val label = ri.loadLabel(pm)?.toString()?.trim().orEmpty().ifBlank { pkg }
                InstalledAppEntry(label = label, packageName = pkg)
            }
            .distinctBy { it.packageName }
            .filter { cleanQuery.isEmpty() || it.label.lowercase().contains(cleanQuery) || it.packageName.lowercase().contains(cleanQuery) }
            .sortedBy { it.label.lowercase() }
            .take(limit)
    }

    fun tryHandleToolPrompt(message: String): DeviceToolResult? {
        val trimmed = message.trim()
        val lower = trimmed.lowercase()

        if (lower.startsWith("tool:")) {
            val body = trimmed.substringAfter(':').trim()
            val parts = body.split(' ', limit = 2)
            val toolName = parts[0].trim().lowercase()
            val arg = parts.getOrNull(1)?.trim().orEmpty()
            return execute(toolName, arg)
        }

        return when {
            lower.contains("audit permission") || lower.contains("check permission") || lower == "permissions" ->
                execute("permission_audit", "")
            lower.contains("device info") || lower.contains("phone model") ->
                execute("device_info", "")
            lower.contains("network status") || lower.contains("wifi status") ->
                execute("network_status", "")
            lower.contains("battery") ->
                execute("battery_status", "")
            lower.contains("sensors") || lower.contains("sensor status") ->
                execute("sensor_status", "")
            lower.contains("my location") || lower.contains("get location") || lower.contains("gps") ->
                execute("get_location", "")
            lower.contains("list contacts") || lower.contains("show contacts") ->
                execute("list_contacts", "")
            lower.contains("calendar events") || lower.contains("upcoming events") ->
                execute("list_calendar_events", "")
            lower.contains("read sms") || lower.contains("sms inbox") ->
                execute("read_sms_inbox", "")
            lower.contains("call log") || lower.contains("recent calls") ->
                execute("read_call_log", "")
            lower.contains("telephony") || lower.contains("carrier") ->
                execute("telephony_status", "")
            lower.contains("bluetooth") ->
                execute("bluetooth_status", "")
            lower.contains("notifications") ->
                execute("list_notifications", "")
            lower.contains("inspect screen") || lower.contains("read screen") ->
                execute("inspect_screen", "")
            lower.contains("installed apps") || lower.contains("list apps") ->
                execute("list_installed_apps", "")
            lower.contains("workspace files") || lower.contains("list files") ->
                execute("list_workspace_files", "")
            lower.startsWith("launch ") ->
                execute("launch_app", trimmed.substring(7).trim())
            lower.startsWith("dial ") ->
                execute("dial_number", trimmed.substring(5).trim())
            lower.startsWith("call ") ->
                execute("call_number", trimmed.substring(5).trim())
            lower.startsWith("sms ") ->
                execute("compose_sms", trimmed.substring(4).trim())
            lower.startsWith("email ") ->
                execute("compose_email", trimmed.substring(6).trim())
            else -> null
        }
    }

    fun execute(toolName: String, arg: String = ""): DeviceToolResult {
        return when (toolName.lowercase()) {
            "permission_audit" -> runPermissionAudit()
            "device_info" -> runDeviceInfo()
            "network_status" -> runNetworkStatus()
            "battery_status" -> runBatteryStatus()
            "sensor_status" -> runSensorStatus()
            "get_location" -> runLocation()
            "list_contacts" -> runContacts(arg)
            "add_contact" -> runAddContact(arg)
            "list_calendar_events" -> runCalendarEvents()
            "add_calendar_event" -> runAddCalendarEvent(arg)
            "read_sms_inbox" -> runReadSmsInbox()
            "send_sms_direct" -> runSendSmsDirect(arg)
            "read_call_log" -> runReadCallLog()
            "telephony_status" -> runTelephonyStatus()
            "bluetooth_status" -> runBluetoothStatus()
            "list_notifications" -> runListNotifications()
            "clear_notifications" -> {
                NeuroServiceBridge.clearNotifications()
                DeviceToolResult("clear_notifications", true, "Cleared captured notification buffer.")
            }
            "inspect_screen" -> runInspectScreen()
            "global_action" -> runGlobalAction(arg)
            "list_installed_apps" -> runListInstalledApps(arg)
            "launch_app" -> runLaunchApp(arg)
            "list_workspace_files" -> runListWorkspaceFiles()
            "read_workspace_file" -> runReadWorkspaceFile(arg)
            "vibrate_haptic" -> runVibrate()
            "dial_number" -> launchDialer(arg)
            "call_number" -> runDirectCall(arg)
            "compose_sms" -> launchSmsComposer(arg)
            "compose_email" -> launchEmailComposer(arg)
            "open_app_settings" -> launchAppSettings()
            "open_overlay_settings" -> launchSpecialSettings(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, "Overlay (Draw over apps)")
            "open_accessibility_settings" -> launchSimpleSettings(Settings.ACTION_ACCESSIBILITY_SETTINGS, "Accessibility Services")
            "open_notification_listener_settings" -> launchSimpleSettings("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS", "Notification Listener")
            "open_exact_alarm_settings" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                launchSpecialSettings(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, "Exact Alarms")
            } else {
                DeviceToolResult(toolName, true, "Exact alarms are automatically permitted on this Android version.")
            }
            "toggle_floating_orb" -> toggleFloatingOrb(arg.equals("on", ignoreCase = true) || arg.equals("true", ignoreCase = true))
            else -> DeviceToolResult(
                toolName = toolName,
                success = false,
                summary = "Unknown tool \"$toolName\". Try: ${catalog().joinToString(", ") { it.name }}."
            )
        }
    }

    private fun runPermissionAudit(): DeviceToolResult {
        val entries = auditPermissions().filter { isApplicableForCurrentSdk(it.permission) }
        val runtime = entries.filter { it.isDangerous }
        val grantedRuntime = runtime.count { it.granted }
        val special = specialAccessStatus()
        val missingNames = runtime.filter { !it.granted }.map { it.shortName }
        val summary = buildString {
            append("Runtime permissions: $grantedRuntime/${runtime.size} granted (${entries.size} total manifest permissions).\n")
            append("Special Access -> Overlay: ${flag(special.overlayGranted)}, Accessibility: ${flag(special.accessibilityConnected)}, Notifications: ${flag(special.notificationListenerConnected)}, ExactAlarms: ${flag(special.exactAlarmAllowed)}.")
            if (missingNames.isNotEmpty()) {
                append("\nPending runtime consent: ${missingNames.joinToString(", ")}.")
            }
        }
        return DeviceToolResult(
            toolName = "permission_audit",
            success = true,
            summary = summary,
            promptSuggestion = "[[ask: Installed apps | tool: list_installed_apps]] [[ask: Notifications | tool: list_notifications]] [[ask: Screen UI | tool: inspect_screen]]"
        )
    }

    private fun flag(v: Boolean): String = if (v) "ON" else "OFF"

    private fun runDeviceInfo(): DeviceToolResult {
        val pkgVersion = runCatching {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "1.0"
        }.getOrDefault("1.0")
        return DeviceToolResult(
            toolName = "device_info",
            success = true,
            summary = "Device: ${Build.MANUFACTURER} ${Build.MODEL} • Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}) • Locale ${Locale.getDefault().toLanguageTag()} • NeuroClaw v$pkgVersion",
            promptSuggestion = "[[ask: Battery | tool: battery_status]] [[ask: Network | tool: network_status]]"
        )
    }

    @Suppress("DEPRECATION")
    private fun runNetworkStatus(): DeviceToolResult {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return DeviceToolResult("network_status", false, "Connectivity service unavailable.")
        val network = cm.activeNetwork
        val caps = if (network != null) cm.getNetworkCapabilities(network) else null
        if (caps == null) {
            return DeviceToolResult("network_status", true, "Offline mode: no active network connection.")
        }
        val transports = buildList {
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) add("Wi-Fi")
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) add("Cellular")
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) add("Ethernet")
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) add("VPN")
        }.ifEmpty { listOf("Connected") }
        val validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val wifiDetail = runCatching {
            val info = wm?.connectionInfo
            if (info != null && info.networkId != -1) " • Link ${info.linkSpeed}Mbps RSSI ${info.rssi}dBm" else ""
        }.getOrDefault("")
        return DeviceToolResult("network_status", true, "Network: ${transports.joinToString(" + ")} • Validated=$validated$wifiDetail.")
    }

    private fun runBatteryStatus(): DeviceToolResult {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
            ?: return DeviceToolResult("battery_status", false, "Battery service unavailable.")
        val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return DeviceToolResult("battery_status", true, "Battery: $level% (${if (bm.isCharging) "charging" else "on battery"}). ")
    }

    private fun runSensorStatus(): DeviceToolResult {
        val sm = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
            ?: return DeviceToolResult("sensor_status", false, "SensorManager unavailable.")
        val sensors = sm.getSensorList(Sensor.TYPE_ALL)
        val preview = sensors.take(6).joinToString(", ") { it.name }
        return DeviceToolResult("sensor_status", true, "Detected ${sensors.size} sensors: $preview${if (sensors.size > 6) ", ..." else ""}")
    }

    @SuppressLint("MissingPermission")
    private fun runLocation(): DeviceToolResult {
        val fine = hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
        if (!fine && !coarse) {
            return DeviceToolResult("get_location", false, "Location permission not granted. Tap Grant Runtime Permissions in Commons.")
        }
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            ?: return DeviceToolResult("get_location", false, "LocationManager unavailable.")
        val loc = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .firstNotNullOfOrNull { p -> runCatching { lm.getLastKnownLocation(p) }.getOrNull() }
        return if (loc != null) {
            DeviceToolResult("get_location", true, "Location (${loc.provider}): lat=${"%.5f".format(loc.latitude)}, lon=${"%.5f".format(loc.longitude)}, acc=${loc.accuracy.toInt()}m.")
        } else {
            DeviceToolResult("get_location", true, "Location permission granted (${if (fine) "Precise" else "Coarse"}), no cached fix yet.")
        }
    }

    private fun runContacts(query: String): DeviceToolResult {
        if (!hasPermission(Manifest.permission.READ_CONTACTS)) {
            return DeviceToolResult("list_contacts", false, "READ_CONTACTS not granted yet.")
        }
        val names = ArrayList<String>()
        val sel = if (query.isNotBlank()) "${ContactsContract.Contacts.DISPLAY_NAME_PRIMARY} LIKE ?" else null
        val args = if (query.isNotBlank()) arrayOf("%$query%") else null
        runCatching {
            context.contentResolver.query(
                ContactsContract.Contacts.CONTENT_URI,
                arrayOf(ContactsContract.Contacts.DISPLAY_NAME_PRIMARY),
                sel,
                args,
                "${ContactsContract.Contacts.DISPLAY_NAME_PRIMARY} ASC"
            )?.use { c ->
                val idx = c.getColumnIndex(ContactsContract.Contacts.DISPLAY_NAME_PRIMARY)
                while (c.moveToNext() && names.size < 10) {
                    val name = if (idx >= 0) c.getString(idx) else null
                    if (!name.isNullOrBlank()) names.add(name)
                }
            }
        }
        return DeviceToolResult("list_contacts", true, if (names.isEmpty()) "0 matching contacts found." else "Contacts: ${names.joinToString(", ")}.")
    }

    private fun runAddContact(arg: String): DeviceToolResult {
        if (!hasPermission(Manifest.permission.WRITE_CONTACTS)) {
            return DeviceToolResult("add_contact", false, "WRITE_CONTACTS not granted yet.")
        }
        val parts = arg.split('|', limit = 2).map { it.trim() }
        val name = parts.getOrNull(0).orEmpty()
        val phone = parts.getOrNull(1).orEmpty()
        if (name.isEmpty()) {
            return DeviceToolResult("add_contact", false, "Usage: tool: add_contact Full Name | 555-0100")
        }
        val intent = Intent(Intent.ACTION_INSERT, ContactsContract.Contacts.CONTENT_URI).apply {
            putExtra(ContactsContract.Intents.Insert.NAME, name)
            if (phone.isNotEmpty()) putExtra(ContactsContract.Intents.Insert.PHONE, phone)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return launchExternalIntent("add_contact", intent, "Opened system contact creation pre-filled for $name.")
    }

    private fun runCalendarEvents(): DeviceToolResult {
        if (!hasPermission(Manifest.permission.READ_CALENDAR)) {
            return DeviceToolResult("list_calendar_events", false, "READ_CALENDAR not granted yet.")
        }
        val now = System.currentTimeMillis()
        val items = ArrayList<String>()
        val fmt = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
        runCatching {
            context.contentResolver.query(
                CalendarContract.Events.CONTENT_URI,
                arrayOf(CalendarContract.Events.TITLE, CalendarContract.Events.DTSTART),
                "${CalendarContract.Events.DTSTART} >= ?",
                arrayOf(now.toString()),
                "${CalendarContract.Events.DTSTART} ASC"
            )?.use { c ->
                val tIdx = c.getColumnIndex(CalendarContract.Events.TITLE)
                val sIdx = c.getColumnIndex(CalendarContract.Events.DTSTART)
                while (c.moveToNext() && items.size < 8) {
                    val title = if (tIdx >= 0) c.getString(tIdx) ?: "(untitled)" else "(untitled)"
                    val dt = if (sIdx >= 0) c.getLong(sIdx) else now
                    items.add("$title (${fmt.format(Date(dt))})")
                }
            }
        }
        return DeviceToolResult("list_calendar_events", true, if (items.isEmpty()) "No upcoming events found." else "Upcoming: ${items.joinToString("; ")}.")
    }

    private fun runAddCalendarEvent(arg: String): DeviceToolResult {
        if (!hasPermission(Manifest.permission.WRITE_CALENDAR)) {
            return DeviceToolResult("add_calendar_event", false, "WRITE_CALENDAR not granted yet.")
        }
        val title = arg.trim().ifBlank { "NeuroClaw Session" }
        val start = System.currentTimeMillis() + 3_600_000L
        val end = start + 1_800_000L
        val calId = runCatching {
            context.contentResolver.query(
                CalendarContract.Calendars.CONTENT_URI,
                arrayOf(CalendarContract.Calendars._ID),
                null,
                null,
                null
            )?.use { c -> if (c.moveToFirst()) c.getLong(0) else null }
        }.getOrNull() ?: return DeviceToolResult("add_calendar_event", false, "No writable local calendar account found on device.")
        val values = ContentValues().apply {
            put(CalendarContract.Events.DTSTART, start)
            put(CalendarContract.Events.DTEND, end)
            put(CalendarContract.Events.TITLE, title)
            put(CalendarContract.Events.CALENDAR_ID, calId)
            put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().id)
        }
        val inserted = runCatching { context.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values) }.getOrNull()
        return if (inserted != null) {
            DeviceToolResult("add_calendar_event", true, "Added calendar event \"$title\" 1 hour from now.")
        } else {
            DeviceToolResult("add_calendar_event", false, "Failed to insert calendar event.")
        }
    }

    private fun runReadSmsInbox(): DeviceToolResult {
        if (!hasPermission(Manifest.permission.READ_SMS)) {
            return DeviceToolResult("read_sms_inbox", false, "READ_SMS not granted yet. Tap Grant Runtime Permissions in Commons.")
        }
        val items = ArrayList<String>()
        runCatching {
            context.contentResolver.query(
                Telephony.Sms.Inbox.CONTENT_URI,
                arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY),
                null,
                null,
                "${Telephony.Sms.DATE} DESC"
            )?.use { c ->
                val aIdx = c.getColumnIndex(Telephony.Sms.ADDRESS)
                val bIdx = c.getColumnIndex(Telephony.Sms.BODY)
                while (c.moveToNext() && items.size < 6) {
                    val addr = if (aIdx >= 0) c.getString(aIdx) ?: "?" else "?"
                    val body = if (bIdx >= 0) c.getString(bIdx)?.take(60) ?: "" else ""
                    items.add("$addr: $body")
                }
            }
        }
        return DeviceToolResult("read_sms_inbox", true, if (items.isEmpty()) "SMS inbox is empty." else "Recent SMS:\n${items.joinToString("\n")}")
    }

    @Suppress("DEPRECATION")
    private fun runSendSmsDirect(arg: String): DeviceToolResult {
        if (!hasPermission(Manifest.permission.SEND_SMS)) {
            return DeviceToolResult("send_sms_direct", false, "SEND_SMS not granted yet.")
        }
        val parts = arg.split(' ', limit = 2)
        val number = parts.getOrNull(0)?.trim().orEmpty()
        val body = parts.getOrNull(1)?.trim().orEmpty()
        if (number.isEmpty() || body.isEmpty()) {
            return DeviceToolResult("send_sms_direct", false, "Usage: tool: send_sms_direct <number> <message>")
        }
        return try {
            val smsManager = context.getSystemService(SmsManager::class.java) ?: SmsManager.getDefault()
            smsManager.sendTextMessage(number, null, body, null, null)
            DeviceToolResult("send_sms_direct", true, "Dispatched SMS to $number.")
        } catch (e: Exception) {
            DeviceToolResult("send_sms_direct", false, "SMS dispatch failed: ${e.message}")
        }
    }

    private fun runReadCallLog(): DeviceToolResult {
        if (!hasPermission(Manifest.permission.READ_CALL_LOG)) {
            return DeviceToolResult("read_call_log", false, "READ_CALL_LOG not granted yet.")
        }
        val items = ArrayList<String>()
        runCatching {
            context.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                arrayOf(CallLog.Calls.CACHED_NAME, CallLog.Calls.NUMBER, CallLog.Calls.DURATION),
                null,
                null,
                "${CallLog.Calls.DATE} DESC"
            )?.use { c ->
                val nIdx = c.getColumnIndex(CallLog.Calls.CACHED_NAME)
                val numIdx = c.getColumnIndex(CallLog.Calls.NUMBER)
                val dIdx = c.getColumnIndex(CallLog.Calls.DURATION)
                while (c.moveToNext() && items.size < 6) {
                    val label = (if (nIdx >= 0) c.getString(nIdx) else null)
                        ?.takeIf { it.isNotBlank() }
                        ?: (if (numIdx >= 0) c.getString(numIdx) else "Unknown")
                    val dur = if (dIdx >= 0) c.getInt(dIdx) else 0
                    items.add("$label (${dur}s)")
                }
            }
        }
        return DeviceToolResult("read_call_log", true, if (items.isEmpty()) "No call log records found." else "Recent calls: ${items.joinToString(", ")}.")
    }

    @SuppressLint("MissingPermission")
    private fun runTelephonyStatus(): DeviceToolResult {
        if (!hasPermission(Manifest.permission.READ_PHONE_STATE)) {
            return DeviceToolResult("telephony_status", false, "READ_PHONE_STATE not granted yet.")
        }
        val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
            ?: return DeviceToolResult("telephony_status", true, "Telephony service unavailable.")
        val carrier = tm.networkOperatorName.ifBlank { "No SIM/carrier" }
        val country = tm.networkCountryIso.uppercase().ifBlank { "--" }
        return DeviceToolResult("telephony_status", true, "Carrier: $carrier ($country) • SimState=${tm.simState}.")
    }

    @SuppressLint("MissingPermission")
    private fun runBluetoothStatus(): DeviceToolResult {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !hasPermission(Manifest.permission.BLUETOOTH_CONNECT)) {
            return DeviceToolResult("bluetooth_status", false, "BLUETOOTH_CONNECT not granted yet.")
        }
        val bm = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter = bm?.adapter ?: return DeviceToolResult("bluetooth_status", true, "No Bluetooth adapter available.")
        val bonded = runCatching { adapter.bondedDevices?.size ?: 0 }.getOrDefault(0)
        return DeviceToolResult("bluetooth_status", true, "Bluetooth: ${if (adapter.isEnabled) "Enabled" else "Disabled"}, $bonded bonded device(s).")
    }

    private fun runListNotifications(): DeviceToolResult {
        if (!specialAccessStatus().notificationListenerConnected) {
            return DeviceToolResult(
                "list_notifications",
                false,
                "Notification Listener is not enabled yet. Tap Notification Access in Commons -> Special Access.",
                "[[ask: Open notification settings | tool: open_notification_listener_settings]]"
            )
        }
        val recent = NeuroServiceBridge.recentNotifications(8)
        if (recent.isEmpty()) {
            return DeviceToolResult("list_notifications", true, "Notification Listener active; no external notifications buffered yet.")
        }
        val lines = recent.joinToString("\n") { "[${it.packageName.substringAfterLast('.')}] ${it.title}: ${it.text}" }
        return DeviceToolResult("list_notifications", true, "Recent notifications:\n$lines")
    }

    private fun runInspectScreen(): DeviceToolResult {
        val svc = NeuroServiceBridge.accessibilityServiceInstance
            ?: return DeviceToolResult(
                "inspect_screen",
                false,
                "Accessibility Service is not enabled yet. Enable NeuroClaw in Accessibility Settings (Commons -> Special Access).",
                "[[ask: Open accessibility settings | tool: open_accessibility_settings]]"
            )
        return DeviceToolResult("inspect_screen", true, svc.inspectActiveScreenText())
    }

    private fun runGlobalAction(arg: String): DeviceToolResult {
        val svc = NeuroServiceBridge.accessibilityServiceInstance
            ?: return DeviceToolResult("global_action", false, "Accessibility Service is not enabled yet.")
        val actionId = when (arg.trim().lowercase()) {
            "home" -> AccessibilityService.GLOBAL_ACTION_HOME
            "recents" -> AccessibilityService.GLOBAL_ACTION_RECENTS
            "notifications" -> AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
            else -> AccessibilityService.GLOBAL_ACTION_BACK
        }
        val ok = svc.performGlobalAction(actionId)
        return DeviceToolResult("global_action", ok, if (ok) "Performed global action: ${arg.ifBlank { "back" }}." else "Global action failed.")
    }

    private fun runListInstalledApps(query: String): DeviceToolResult {
        val apps = listInstalledApps(query, limit = 20)
        if (apps.isEmpty()) {
            return DeviceToolResult("list_installed_apps", true, "No matching launchable apps found.")
        }
        val preview = apps.take(12).joinToString(", ") { it.label }
        return DeviceToolResult(
            "list_installed_apps",
            true,
            "Found ${apps.size} launchable app(s): $preview${if (apps.size > 12) ", ..." else ""}"
        )
    }

    private fun runLaunchApp(query: String): DeviceToolResult {
        if (query.isBlank()) return DeviceToolResult("launch_app", false, "Provide an app name or package, e.g. `tool: launch_app Settings`.")
        val match = listInstalledApps(query, limit = 1).firstOrNull()
            ?: return DeviceToolResult("launch_app", false, "No installed app matched \"$query\".")
        val launchIntent = context.packageManager.getLaunchIntentForPackage(match.packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        } ?: return DeviceToolResult("launch_app", false, "${match.label} has no launchable activity.")
        return launchExternalIntent("launch_app", launchIntent, "Launched ${match.label} (${match.packageName}).")
    }

    private fun runListWorkspaceFiles(): DeviceToolResult {
        val treeUri = linkedWorkspaceTreeUri ?: return DeviceToolResult(
            "list_workspace_files",
            false,
            "No Workspace Folder linked yet. Tap Link Folder in Commons or Settings to pick a folder."
        )
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
            treeUri,
            DocumentsContract.getTreeDocumentId(treeUri)
        )
        val entries = ArrayList<String>()
        runCatching {
            context.contentResolver.query(
                childrenUri,
                arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE),
                null,
                null,
                null
            )?.use { c ->
                val nameIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                val mimeIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
                while (c.moveToNext() && entries.size < 20) {
                    val name = if (nameIdx >= 0) c.getString(nameIdx) else "?"
                    val mime = if (mimeIdx >= 0) c.getString(mimeIdx) else ""
                    val tag = if (mime == DocumentsContract.Document.MIME_TYPE_DIR) "[DIR] " else ""
                    entries.add("$tag$name")
                }
            }
        }
        return DeviceToolResult(
            "list_workspace_files",
            true,
            if (entries.isEmpty()) "Linked workspace folder is empty." else "Workspace entries:\n${entries.joinToString("\n")}"
        )
    }

    private fun runReadWorkspaceFile(filename: String): DeviceToolResult {
        val treeUri = linkedWorkspaceTreeUri
            ?: return DeviceToolResult("read_workspace_file", false, "Link a workspace folder first.")
        if (filename.isBlank()) return DeviceToolResult("read_workspace_file", false, "Provide a filename.")
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
            treeUri,
            DocumentsContract.getTreeDocumentId(treeUri)
        )
        var targetDocId: String? = null
        runCatching {
            context.contentResolver.query(
                childrenUri,
                arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME),
                null,
                null,
                null
            )?.use { c ->
                val idIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                val nameIdx = c.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                while (c.moveToNext()) {
                    val name = if (nameIdx >= 0) c.getString(nameIdx) else ""
                    if (name.equals(filename.trim(), ignoreCase = true)) {
                        targetDocId = if (idIdx >= 0) c.getString(idIdx) else null
                        break
                    }
                }
            }
        }
        val docId = targetDocId ?: return DeviceToolResult("read_workspace_file", false, "File \"$filename\" not found in workspace.")
        val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)
        val preview = runCatching {
            context.contentResolver.openInputStream(docUri)?.use { s ->
                val buf = ByteArray(1500)
                val n = s.read(buf).coerceAtLeast(0)
                buf.copyOf(n).decodeToString()
            }
        }.getOrNull() ?: return DeviceToolResult("read_workspace_file", false, "Unable to read \"$filename\".")
        return DeviceToolResult("read_workspace_file", true, "$filename:\n$preview")
    }

    @Suppress("DEPRECATION")
    private fun runVibrate(): DeviceToolResult {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        } ?: return DeviceToolResult("vibrate_haptic", false, "Vibrator unavailable.")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(VibrationEffect.createOneShot(90L, VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            vibrator.vibrate(90L)
        }
        return DeviceToolResult("vibrate_haptic", true, "Triggered 90ms haptic pulse.")
    }

    private fun launchDialer(number: String): DeviceToolResult {
        val clean = number.filter { it.isDigit() || it == '+' || it == '*' || it == '#' }
        val intent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:$clean")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return launchExternalIntent("dial_number", intent, "Opened system dialer${if (clean.isNotEmpty()) " for $clean" else ""}.")
    }

    @SuppressLint("MissingPermission")
    private fun runDirectCall(number: String): DeviceToolResult {
        if (!hasPermission(Manifest.permission.CALL_PHONE)) {
            return launchDialer(number)
        }
        val clean = number.filter { it.isDigit() || it == '+' || it == '*' || it == '#' }
        if (clean.isEmpty()) return DeviceToolResult("call_number", false, "Provide a phone number to call.")
        val intent = Intent(Intent.ACTION_CALL, Uri.parse("tel:$clean")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return launchExternalIntent("call_number", intent, "Placing call to $clean.")
    }

    private fun launchSmsComposer(arg: String): DeviceToolResult {
        val parts = arg.split(' ', limit = 2)
        val phone = parts.getOrNull(0)?.trim().orEmpty()
        val body = parts.getOrNull(1)?.trim().orEmpty()
        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:${Uri.encode(phone)}")).apply {
            if (body.isNotEmpty()) putExtra("sms_body", body)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return launchExternalIntent("compose_sms", intent, "Opened SMS composer.")
    }

    private fun launchEmailComposer(arg: String): DeviceToolResult {
        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:${Uri.encode(arg.trim())}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return launchExternalIntent("compose_email", intent, "Opened email composer.")
    }

    private fun launchAppSettings(): DeviceToolResult {
        val intent = Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", context.packageName, null)
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return launchExternalIntent("open_app_settings", intent, "Opened NeuroClaw system permission settings.")
    }

    private fun launchSpecialSettings(action: String, label: String): DeviceToolResult {
        val intent = Intent(action, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return launchExternalIntent(action, intent, "Opened $label settings.")
    }

    private fun launchSimpleSettings(action: String, label: String): DeviceToolResult {
        val intent = Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return launchExternalIntent(action, intent, "Opened $label settings.")
    }

    fun toggleFloatingOrb(enable: Boolean): DeviceToolResult {
        val intent = Intent(context, FloatingOrbService::class.java)
        return if (enable) {
            if (!Settings.canDrawOverlays(context)) {
                launchSpecialSettings(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, "Draw Over Other Apps")
                DeviceToolResult("toggle_floating_orb", false, "Grant 'Display over other apps' first, then re-enable the Floating Orb.")
            } else {
                ContextCompat.startForegroundService(context, intent)
                DeviceToolResult("toggle_floating_orb", true, "Started Floating Shoggoth Orb overlay.")
            }
        } else {
            context.stopService(intent)
            DeviceToolResult("toggle_floating_orb", true, "Stopped Floating Shoggoth Orb overlay.")
        }
    }

    private fun hasPermission(perm: String): Boolean =
        ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED

    private fun launchExternalIntent(tool: String, intent: Intent, okMessage: String): DeviceToolResult {
        return try {
            context.startActivity(intent)
            DeviceToolResult(tool, true, okMessage)
        } catch (e: Exception) {
            DeviceToolResult(tool, false, "Unavailable: ${e.message ?: "no handler found"}")
        }
    }
}
