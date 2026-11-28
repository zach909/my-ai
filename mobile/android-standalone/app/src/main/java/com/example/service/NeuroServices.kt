package com.example.service

import android.accessibilityservice.AccessibilityService
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.IBinder
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.TextView
import com.example.MainActivity
import com.example.R

data class CapturedNotification(
    val packageName: String,
    val title: String,
    val text: String,
    val postTimeMs: Long
)

object NeuroServiceBridge {
    private val notifLock = Any()
    private val notifications = ArrayDeque<CapturedNotification>(30)

    @Volatile
    var isNotificationListenerConnected: Boolean = false

    @Volatile
    var accessibilityServiceInstance: NeuroAccessibilityService? = null

    @Volatile
    var isFloatingOrbRunning: Boolean = false

    fun recordNotification(item: CapturedNotification) = synchronized(notifLock) {
        if (notifications.size >= 30) notifications.removeFirst()
        notifications.addLast(item)
    }

    fun recentNotifications(limit: Int = 12): List<CapturedNotification> = synchronized(notifLock) {
        notifications.toList().takeLast(limit).reversed()
    }

    fun clearNotifications() = synchronized(notifLock) {
        notifications.clear()
    }
}

class NeuroNotificationListener : NotificationListenerService() {
    override fun onListenerConnected() {
        super.onListenerConnected()
        NeuroServiceBridge.isNotificationListenerConnected = true
    }

    override fun onListenerDisconnected() {
        NeuroServiceBridge.isNotificationListenerConnected = false
        super.onListenerDisconnected()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val extras = sbn?.notification?.extras ?: return
        val pkg = sbn.packageName ?: return
        if (pkg == packageName) return
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
        val body = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim().orEmpty()
        if (title.isNotEmpty() || body.isNotEmpty()) {
            NeuroServiceBridge.recordNotification(
                CapturedNotification(
                    packageName = pkg,
                    title = title,
                    text = body,
                    postTimeMs = sbn.postTime
                )
            )
        }
    }
}

class NeuroAccessibilityService : AccessibilityService() {
    @Volatile
    var lastPackageName: String = ""
        private set

    override fun onServiceConnected() {
        super.onServiceConnected()
        NeuroServiceBridge.accessibilityServiceInstance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val pkg = event?.packageName?.toString()
        if (!pkg.isNullOrBlank()) {
            lastPackageName = pkg
        }
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        if (NeuroServiceBridge.accessibilityServiceInstance === this) {
            NeuroServiceBridge.accessibilityServiceInstance = null
        }
        super.onDestroy()
    }

    fun inspectActiveScreenText(maxNodes: Int = 24): String {
        val root: AccessibilityNodeInfo = rootInActiveWindow ?: return "No active window root available."
        val collected = ArrayList<String>()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        while (queue.isNotEmpty() && collected.size < maxNodes) {
            val node = queue.removeFirst()
            val label = node.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }
                ?: node.contentDescription?.toString()?.trim()?.takeIf { it.isNotEmpty() }
            if (label != null) {
                collected.add(label.take(80))
            }
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { queue.add(it) }
            }
        }
        val pkg = root.packageName?.toString() ?: lastPackageName.ifBlank { "unknown" }
        return if (collected.isEmpty()) {
            "Active window: $pkg (no visible text nodes extracted)."
        } else {
            "Active window ($pkg): ${collected.joinToString(" | ")}"
        }
    }
}

/**
 * Draggable Floating Coral & Shoggoth Orb overlay matching the desktop ambient voice orb.
 */
class FloatingOrbService : Service() {
    companion object {
        private const val CHANNEL_ID = "neuroclaw_orb_channel"
        private const val NOTIF_ID = 4091
    }

    private var windowManager: WindowManager? = null
    private var orbView: View? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pending = PendingIntent.getActivity(this, 0, tapIntent, PendingIntent.FLAG_IMMUTABLE)
        val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
            .setContentTitle("NeuroClaw Orb Active")
            .setContentText("Tap floating Shoggoth orb to return to OneBrain")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(pending)
            .setOngoing(true)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, notification)
        }
        attachOrbView()
        NeuroServiceBridge.isFloatingOrbRunning = true
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun attachOrbView() {
        val wm = getSystemService(WINDOW_SERVICE) as WindowManager
        windowManager = wm
        val sizePx = (58 * resources.displayMetrics.density).toInt()
        val params = WindowManager.LayoutParams(
            sizePx,
            sizePx,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            } else {
                @Suppress("DEPRECATION")
                WindowManager.LayoutParams.TYPE_PHONE
            },
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 40
            y = 260
        }

        val badge = TextView(this).apply {
            text = "NC"
            textSize = 15f
            gravity = Gravity.CENTER
            setTextColor(Color.parseColor("#8FE3A8"))
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#E61B1216"))
                setStroke((2.5f * resources.displayMetrics.density).toInt(), Color.parseColor("#E3A99D"))
            }
            contentDescription = "NeuroClaw floating orb"
        }

        var initialX = 0
        var initialY = 0
        var initialTouchX = 0f
        var initialTouchY = 0f
        var moved = false

        badge.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    initialX = params.x
                    initialY = params.y
                    initialTouchX = event.rawX
                    initialTouchY = event.rawY
                    moved = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - initialTouchX).toInt()
                    val dy = (event.rawY - initialTouchY).toInt()
                    if (kotlin.math.abs(dx) > 10 || kotlin.math.abs(dy) > 10) moved = true
                    params.x = initialX + dx
                    params.y = initialY + dy
                    wm.updateViewLayout(badge, params)
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (!moved) {
                        val openIntent = Intent(this, MainActivity::class.java).apply {
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                        }
                        startActivity(openIntent)
                    }
                    true
                }
                else -> false
            }
        }

        runCatching {
            wm.addView(badge, params)
            orbView = badge
        }
    }

    override fun onDestroy() {
        orbView?.let { v ->
            runCatching { windowManager?.removeView(v) }
        }
        orbView = null
        NeuroServiceBridge.isFloatingOrbRunning = false
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            val ch = NotificationChannel(
                CHANNEL_ID,
                "NeuroClaw Floating Orb",
                NotificationManager.IMPORTANCE_LOW
            )
            nm.createNotificationChannel(ch)
        }
    }
}
