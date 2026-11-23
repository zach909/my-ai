package com.example.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.HealthAndSafety
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.example.model.AlignmentStanding
import com.example.ui.components.CoralPillButton
import com.example.ui.components.GlassPanel
import com.example.ui.components.PillTextField
import com.example.ui.components.SectionHeader
import com.example.ui.components.StatusChip
import com.example.ui.theme.NeuroColors
import com.example.ui.theme.NeuroCorner
import com.example.viewmodel.NeuroUiState

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CommonsScreen(
    state: NeuroUiState,
    missingRuntimePermissions: () -> Array<String>,
    onPermissionsUpdated: () -> Unit,
    onRunDeviceTool: (String, String) -> Unit,
    onPickDocument: (android.net.Uri) -> Unit,
    onLinkWorkspaceFolder: (android.net.Uri) -> Unit,
    onToggleFloatingOrb: (Boolean) -> Unit,
    onExportDelta: () -> Unit,
    onImportDeltaUri: (android.net.Uri) -> Unit,
    onImportDeltaText: (String) -> Unit,
    onToggleSandbox: (Boolean) -> Unit,
    onToggleAlignmentArmed: (Boolean) -> Unit,
    onSimulateRiskProbe: () -> Unit,
    onResetAlignment: () -> Unit,
    onRemoveAgent: (String) -> Unit,
    onRecreateAgent: () -> Unit,
    onRunSelfHealing: () -> Unit,
    onToggleDataDonor: (Boolean) -> Unit,
    onPauseDonorMinutes: (Int) -> Unit,
    onGrantLease: (String, Float, Int) -> Unit,
    onRevokeLease: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    var deletePhrase by remember { mutableStateOf("") }
    var leaseRecipient by remember { mutableStateOf("") }
    var leaseHours by remember { mutableStateOf("2") }
    var leaseUnits by remember { mutableStateOf("100") }
    var dialTarget by remember { mutableStateOf("") }
    var deltaPaste by remember { mutableStateOf("") }
    var showAllPermissions by remember { mutableStateOf(false) }

    val multiPermLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        onPermissionsUpdated()
        onRunDeviceTool("permission_audit", "")
    }

    val bgLocLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) {
        onPermissionsUpdated()
        onRunDeviceTool("permission_audit", "")
    }

    val docPickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) onPickDocument(uri)
    }

    val folderPickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri ->
        if (uri != null) onLinkWorkspaceFolder(uri)
    }

    val deltaPickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) onImportDeltaUri(uri)
    }

    val runtimePerms = state.permissionEntries.filter { it.isDangerous }
    val grantedRuntimeCount = runtimePerms.count { it.granted }
    val special = state.specialAccess

    Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .widthIn(max = 760.dp)
                .padding(horizontal = 16.dp),
            contentPadding = PaddingValues(top = 12.dp, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            item {
                SectionHeader(
                    title = "Commons, Permissions & Hive",
                    subtitle = "Full system permissions, Special Access, DeviceTools, Hive Delta sharing, and Danger Protocols"
                )
            }

            // Permissions & Imported Device Tools Panel
            item {
                GlassPanel(highlighted = true) {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.Build,
                                contentDescription = "Device Tools icon",
                                tint = NeuroColors.ShoggothGreen,
                                modifier = Modifier.size(20.dp)
                            )
                            Text(
                                text = "All Permissions & DeviceTools",
                                style = MaterialTheme.typography.titleMedium,
                                color = NeuroColors.CoralSoft
                            )
                        }

                        Text(
                            text = "Runtime: $grantedRuntimeCount/${runtimePerms.size} granted (${state.permissionEntries.size} declared). Special Access below opens OS toggles for Overlay, Accessibility, Notifications & Alarms.",
                            style = MaterialTheme.typography.bodySmall,
                            color = NeuroColors.InkDim
                        )

                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            CoralPillButton(
                                text = "Grant Runtime Permissions",
                                primary = true,
                                onClick = {
                                    val missing = missingRuntimePermissions()
                                    if (missing.isNotEmpty()) {
                                        multiPermLauncher.launch(missing)
                                    } else {
                                        onRunDeviceTool("permission_audit", "")
                                    }
                                },
                                modifier = Modifier.testTag("grant_runtime_permissions_button")
                            )
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                                val hasFg = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                                val hasBg = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED
                                if (hasFg && !hasBg) {
                                    CoralPillButton(
                                        text = "Grant Background Location",
                                        primary = false,
                                        onClick = { bgLocLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION) }
                                    )
                                }
                            }
                            CoralPillButton(
                                text = "Audit Permissions",
                                primary = false,
                                onClick = { onRunDeviceTool("permission_audit", "") },
                                modifier = Modifier.testTag("audit_permissions_button")
                            )
                            CoralPillButton(
                                text = if (showAllPermissions) "Hide (${state.permissionEntries.size})" else "Inspect All (${state.permissionEntries.size})",
                                primary = false,
                                onClick = { showAllPermissions = !showAllPermissions },
                                modifier = Modifier.testTag("toggle_permission_list_button")
                            )
                        }

                        // Special Access Status & Direct Settings Launchers
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            StatusChip(
                                label = "Overlay: ${if (special.overlayGranted) "ON" else "Grant"}",
                                toneColor = if (special.overlayGranted) NeuroColors.ShoggothGreen else NeuroColors.CoralSoft,
                                onClick = { onRunDeviceTool("open_overlay_settings", "") }
                            )
                            StatusChip(
                                label = "Accessibility: ${if (special.accessibilityConnected) "ON" else "Enable"}",
                                toneColor = if (special.accessibilityConnected) NeuroColors.ShoggothGreen else NeuroColors.CoralSoft,
                                onClick = { onRunDeviceTool("open_accessibility_settings", "") }
                            )
                            StatusChip(
                                label = "Notifications: ${if (special.notificationListenerConnected) "ON" else "Enable"}",
                                toneColor = if (special.notificationListenerConnected) NeuroColors.ShoggothGreen else NeuroColors.CoralSoft,
                                onClick = { onRunDeviceTool("open_notification_listener_settings", "") }
                            )
                            StatusChip(
                                label = "Exact Alarms: ${if (special.exactAlarmAllowed) "ON" else "Grant"}",
                                toneColor = if (special.exactAlarmAllowed) NeuroColors.ShoggothGreen else NeuroColors.CoralSoft,
                                onClick = { onRunDeviceTool("open_exact_alarm_settings", "") }
                            )
                        }

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text("Floating Shoggoth Orb", style = MaterialTheme.typography.bodyLarge, color = NeuroColors.Ink)
                                Text("Hover coral/green orb over other apps (requires Overlay)", style = MaterialTheme.typography.bodySmall, color = NeuroColors.InkDim)
                            }
                            Switch(
                                checked = state.settings.floatingOrbEnabled,
                                onCheckedChange = onToggleFloatingOrb,
                                colors = SwitchDefaults.colors(checkedThumbColor = NeuroColors.CoralSoft, checkedTrackColor = NeuroColors.PrimaryFill),
                                modifier = Modifier.testTag("floating_orb_switch")
                            )
                        }

                        if (showAllPermissions && state.permissionEntries.isNotEmpty()) {
                            FlowRow(
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                                verticalArrangement = Arrangement.spacedBy(6.dp)
                            ) {
                                state.permissionEntries.forEach { entry ->
                                    StatusChip(
                                        label = "${if (entry.granted) "OK" else "ASK"} • ${entry.shortName}",
                                        toneColor = if (entry.granted) NeuroColors.ShoggothGreen else NeuroColors.CoralSoft
                                    )
                                }
                            }
                        }

                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            state.deviceToolCatalog.forEach { tool ->
                                StatusChip(
                                    label = tool.title,
                                    toneColor = NeuroColors.ShoggothGreen,
                                    onClick = { onRunDeviceTool(tool.name, "") }
                                )
                            }
                            StatusChip(
                                label = "Import Document",
                                toneColor = NeuroColors.CoralSoft,
                                onClick = { docPickerLauncher.launch(arrayOf("*/*")) }
                            )
                            StatusChip(
                                label = if (state.settings.workspaceTreeUri.isBlank()) "Link Folder" else "Relink Folder",
                                toneColor = NeuroColors.CoralSoft,
                                onClick = { folderPickerLauncher.launch(null) }
                            )
                        }

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            PillTextField(
                                value = dialTarget,
                                onValueChange = { dialTarget = it },
                                placeholder = "Phone # or SMS recipient",
                                modifier = Modifier.weight(1f)
                            )
                            CoralPillButton(
                                text = "Dial",
                                primary = false,
                                onClick = { onRunDeviceTool("dial_number", dialTarget) }
                            )
                            CoralPillButton(
                                text = "Call",
                                primary = false,
                                onClick = { onRunDeviceTool("call_number", dialTarget) }
                            )
                            CoralPillButton(
                                text = "SMS",
                                primary = false,
                                onClick = { onRunDeviceTool("compose_sms", dialTarget) }
                            )
                        }

                        state.lastToolResult?.let { result ->
                            Surface(
                                shape = NeuroCorner.Bubble,
                                color = NeuroColors.GlassFill,
                                border = BorderStroke(
                                    1.dp,
                                    if (result.success) NeuroColors.ShoggothGreen.copy(alpha = 0.5f) else NeuroColors.ErrorPink
                                ),
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Column(
                                    modifier = Modifier.padding(12.dp),
                                    verticalArrangement = Arrangement.spacedBy(4.dp)
                                ) {
                                    Text(
                                        text = "Last Tool Output • ${result.toolName}",
                                        style = MaterialTheme.typography.labelLarge,
                                        color = if (result.success) NeuroColors.ShoggothGreen else NeuroColors.ErrorPink
                                    )
                                    Text(
                                        text = result.summary,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = NeuroColors.Ink
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // Hive Mind & Shared Mesh Delta Exchange
            item {
                GlassPanel {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.Hub,
                                contentDescription = "Hive Mind Delta icon",
                                tint = NeuroColors.ShoggothGreen,
                                modifier = Modifier.size(20.dp)
                            )
                            Text("Hive & Shared Mesh Deltas", style = MaterialTheme.typography.titleMedium, color = NeuroColors.CoralSoft)
                        }
                        Text(
                            text = "Export local Vale weights & grafted regions as a portable delta packet, or merge a peer's delta JSON.",
                            style = MaterialTheme.typography.bodySmall,
                            color = NeuroColors.InkDim
                        )
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            CoralPillButton(
                                text = "Export Delta",
                                primary = false,
                                onClick = onExportDelta
                            )
                            CoralPillButton(
                                text = "Import Delta File",
                                primary = false,
                                onClick = { deltaPickerLauncher.launch(arrayOf("application/json", "*/*")) }
                            )
                        }
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            PillTextField(
                                value = deltaPaste,
                                onValueChange = { deltaPaste = it },
                                placeholder = "Paste mesh delta JSON...",
                                modifier = Modifier.weight(1f)
                            )
                            CoralPillButton(
                                text = "Merge",
                                enabled = deltaPaste.isNotBlank(),
                                onClick = {
                                    onImportDeltaText(deltaPaste)
                                    deltaPaste = ""
                                }
                            )
                        }
                        state.exportedDeltaPreview?.let { delta ->
                            Surface(
                                shape = NeuroCorner.Bubble,
                                color = NeuroColors.InputFill,
                                border = BorderStroke(1.dp, NeuroColors.GlassLine),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .heightIn(max = 160.dp)
                            ) {
                                Text(
                                    text = delta,
                                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                    color = NeuroColors.InkDim,
                                    modifier = Modifier
                                        .padding(10.dp)
                                        .verticalScroll(rememberScrollState())
                                )
                            }
                        }
                    }
                }
            }

            // Danger Protocols & Alignment Standing
            item {
                val danger = state.dangerState
                GlassPanel {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Shield,
                                    contentDescription = "Danger Protocols icon",
                                    tint = NeuroColors.CoralAccent,
                                    modifier = Modifier.size(20.dp)
                                )
                                Text(
                                    text = "Danger Protocols",
                                    style = MaterialTheme.typography.titleMedium,
                                    color = NeuroColors.CoralSoft
                                )
                            }
                            StatusChip(
                                label = danger.standing.label,
                                toneColor = when (danger.standing) {
                                    AlignmentStanding.FRIENDLY, AlignmentStanding.NEUTRAL -> NeuroColors.ShoggothGreen
                                    AlignmentStanding.WARY -> NeuroColors.CoralSoft
                                    else -> NeuroColors.ErrorPink
                                }
                            )
                        }

                        LinearProgressIndicator(
                            progress = { danger.score.coerceIn(0f, 1f) },
                            color = if (danger.score >= 0.58f) NeuroColors.ShoggothGreen else NeuroColors.ErrorPink,
                            trackColor = NeuroColors.GlassFill,
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(10.dp)
                                .clip(CircleShape)
                        )

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text("Sandbox Guard", style = MaterialTheme.typography.bodyLarge, color = NeuroColors.Ink)
                                Text("Quarantines risky external tool probes", style = MaterialTheme.typography.bodySmall, color = NeuroColors.InkDim)
                            }
                            Switch(
                                checked = danger.sandboxEnabled,
                                onCheckedChange = onToggleSandbox,
                                colors = SwitchDefaults.colors(checkedThumbColor = NeuroColors.CoralSoft, checkedTrackColor = NeuroColors.PrimaryFill),
                                modifier = Modifier.testTag("sandbox_switch")
                            )
                        }

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text("Alignment Removal Armed", style = MaterialTheme.typography.bodyLarge, color = NeuroColors.Ink)
                                Text("Removes Shoggoth if standing drops to Malicious", style = MaterialTheme.typography.bodySmall, color = NeuroColors.InkDim)
                            }
                            Switch(
                                checked = danger.alignmentProtocolArmed,
                                onCheckedChange = onToggleAlignmentArmed,
                                colors = SwitchDefaults.colors(checkedThumbColor = NeuroColors.CoralSoft, checkedTrackColor = NeuroColors.PrimaryFill),
                                modifier = Modifier.testTag("alignment_armed_switch")
                            )
                        }

                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            CoralPillButton(
                                text = "Simulate Risk Probe",
                                primary = false,
                                onClick = onSimulateRiskProbe,
                                modifier = Modifier.testTag("simulate_risk_button")
                            )
                            CoralPillButton(
                                text = "Reset Neutral",
                                primary = true,
                                onClick = onResetAlignment,
                                modifier = Modifier.testTag("reset_alignment_button")
                            )
                            if (!danger.agentAlive) {
                                CoralPillButton(
                                    text = "Recreate Agent",
                                    primary = true,
                                    onClick = onRecreateAgent,
                                    modifier = Modifier.testTag("recreate_agent_button")
                                )
                            }
                        }

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            PillTextField(
                                value = deletePhrase,
                                onValueChange = { deletePhrase = it },
                                placeholder = "Type \"delete the agent\" to remove",
                                modifier = Modifier.weight(1f)
                            )
                            CoralPillButton(
                                text = "Remove",
                                primary = false,
                                onClick = {
                                    onRemoveAgent(deletePhrase)
                                    deletePhrase = ""
                                }
                            )
                        }

                        if (danger.events.isNotEmpty()) {
                            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text("Recent Alignment Events", style = MaterialTheme.typography.labelLarge, color = NeuroColors.InkDim)
                                danger.events.take(4).forEach { ev ->
                                    Text("• ${ev.reason}", style = MaterialTheme.typography.bodySmall, color = NeuroColors.InkDim)
                                }
                            }
                        }
                    }
                }
            }

            // Self-Healing Diagnostics
            item {
                GlassPanel {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                Icon(
                                    imageVector = Icons.Default.HealthAndSafety,
                                    contentDescription = "Self Healing icon",
                                    tint = NeuroColors.ShoggothGreen,
                                    modifier = Modifier.size(20.dp)
                                )
                                Text("Self-Healing", style = MaterialTheme.typography.titleMedium, color = NeuroColors.CoralSoft)
                            }
                            CoralPillButton(
                                text = "Heal Now",
                                primary = false,
                                onClick = onRunSelfHealing,
                                modifier = Modifier.testTag("heal_now_button")
                            )
                        }
                        state.healingChecks.forEach { check ->
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp)
                            ) {
                                Icon(
                                    imageVector = if (check.healthy) Icons.Default.CheckCircle else Icons.Default.Warning,
                                    contentDescription = if (check.healthy) "Healthy" else "Warning",
                                    tint = if (check.healthy) NeuroColors.ShoggothGreen else NeuroColors.ErrorPink,
                                    modifier = Modifier.size(18.dp)
                                )
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(check.component, style = MaterialTheme.typography.bodyMedium, color = NeuroColors.Ink)
                                    Text(check.detail, style = MaterialTheme.typography.bodySmall, color = NeuroColors.InkDim)
                                }
                            }
                        }
                    }
                }
            }

            // Data Donor & Privacy
            item {
                val donorPaused = state.settings.dataDonorPausedUntilMs > System.currentTimeMillis()
                GlassPanel {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Security,
                                    contentDescription = "Data Donor icon",
                                    tint = NeuroColors.CoralAccent,
                                    modifier = Modifier.size(20.dp)
                                )
                                Text("Data Donor", style = MaterialTheme.typography.titleMedium, color = NeuroColors.CoralSoft)
                            }
                            Switch(
                                checked = state.settings.dataDonorEnabled,
                                onCheckedChange = onToggleDataDonor,
                                colors = SwitchDefaults.colors(checkedThumbColor = NeuroColors.CoralSoft, checkedTrackColor = NeuroColors.PrimaryFill),
                                modifier = Modifier.testTag("data_donor_switch")
                            )
                        }
                        Text(
                            text = if (donorPaused) "Sharing temporarily paused." else "Opt-in anonymized shard donation keeps training data local until synced.",
                            style = MaterialTheme.typography.bodySmall,
                            color = NeuroColors.InkDim
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            CoralPillButton(text = "Pause 30m", primary = false, onClick = { onPauseDonorMinutes(30) })
                            if (donorPaused) {
                                CoralPillButton(text = "Resume", primary = true, onClick = { onPauseDonorMinutes(0) })
                            }
                        }
                    }
                }
            }

            // Compute Leases
            item {
                GlassPanel {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.Share,
                                contentDescription = "Compute Leases icon",
                                tint = NeuroColors.CoralAccent,
                                modifier = Modifier.size(20.dp)
                            )
                            Text("Compute Lending & Leases", style = MaterialTheme.typography.titleMedium, color = NeuroColors.CoralSoft)
                        }

                        PillTextField(value = leaseRecipient, onValueChange = { leaseRecipient = it }, placeholder = "Peer / Node name")
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            PillTextField(value = leaseHours, onValueChange = { leaseHours = it }, placeholder = "Hours", modifier = Modifier.weight(1f))
                            PillTextField(value = leaseUnits, onValueChange = { leaseUnits = it }, placeholder = "Units", modifier = Modifier.weight(1f))
                        }
                        CoralPillButton(
                            text = "Grant Compute Lease",
                            primary = true,
                            onClick = {
                                onGrantLease(leaseRecipient, leaseHours.toFloatOrNull() ?: 2f, leaseUnits.toIntOrNull() ?: 100)
                                leaseRecipient = ""
                            },
                            modifier = Modifier.testTag("grant_lease_button")
                        )

                        state.leases.forEach { lease ->
                            Surface(
                                shape = NeuroCorner.Bubble,
                                color = NeuroColors.GlassFill,
                                border = BorderStroke(1.dp, NeuroColors.GlassLine),
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Row(
                                    modifier = Modifier.padding(12.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(lease.recipient, style = MaterialTheme.typography.titleSmall, color = NeuroColors.Ink)
                                        Text(
                                            text = "${lease.hours}h • ${lease.computeUnits} units • Token ${lease.tokenPreview}",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = NeuroColors.InkDim
                                        )
                                    }
                                    CoralPillButton(text = "Revoke", primary = false, onClick = { onRevokeLease(lease.id) })
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
