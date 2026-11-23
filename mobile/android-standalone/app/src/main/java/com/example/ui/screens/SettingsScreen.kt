package com.example.ui.screens

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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudSync
import androidx.compose.material.icons.filled.DeleteForever
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.Icon
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.example.model.AppSettings
import com.example.ui.components.CoralPillButton
import com.example.ui.components.GlassPanel
import com.example.ui.components.PillTextField
import com.example.ui.components.SectionHeader
import com.example.ui.components.StatusChip
import com.example.ui.theme.NeuroColors
import com.example.ui.theme.NeuroCorner
import com.example.ui.theme.ThemeMode
import com.example.viewmodel.NeuroUiState

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsScreen(
    state: NeuroUiState,
    onUpdateSettings: ((AppSettings) -> AppSettings) -> Unit,
    onSwitchProfile: (String) -> Unit,
    onAddProfile: (String) -> Unit,
    onToggleFloatingOrb: (Boolean) -> Unit,
    onLinkWorkspaceFolder: (android.net.Uri) -> Unit,
    onSyncNow: () -> Unit,
    onExportChats: () -> Unit,
    onEraseTrainingData: () -> Unit,
    onRunDeviceTool: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val settings = state.settings
    var serverUrlDraft by remember(settings.serverUrl) { mutableStateOf(settings.serverUrl) }
    var passwordDraft by remember(settings.remotePassword) { mutableStateOf(settings.remotePassword) }
    var newProfileDraft by remember { mutableStateOf("") }
    var confirmErase by remember { mutableStateOf(false) }

    val folderPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri ->
        if (uri != null) onLinkWorkspaceFolder(uri)
    }

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
                    title = "Settings, Accounts & Sync",
                    subtitle = "Local accounts, optional PC sync, TTS/Hive/Ambient toggles, and storage"
                )
            }

            // Local Profiles & Accounts
            item {
                GlassPanel {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.Person,
                                contentDescription = "Accounts icon",
                                tint = NeuroColors.CoralAccent,
                                modifier = Modifier.size(20.dp)
                            )
                            Text("Local Accounts (${settings.localAccountName})", style = MaterialTheme.typography.titleMedium, color = NeuroColors.CoralSoft)
                        }
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            settings.localProfiles.forEach { profile ->
                                CoralPillButton(
                                    text = profile,
                                    primary = profile == settings.localAccountName,
                                    onClick = { onSwitchProfile(profile) }
                                )
                            }
                        }
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            PillTextField(
                                value = newProfileDraft,
                                onValueChange = { newProfileDraft = it },
                                placeholder = "Add local profile name",
                                modifier = Modifier.weight(1f)
                            )
                            CoralPillButton(
                                text = "Add",
                                primary = false,
                                enabled = newProfileDraft.isNotBlank(),
                                onClick = {
                                    onAddProfile(newProfileDraft)
                                    newProfileDraft = ""
                                }
                            )
                        }
                    }
                }
            }

            // Optional PC Sync
            item {
                GlassPanel(highlighted = true) {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.CloudSync,
                                contentDescription = "PC Sync icon",
                                tint = NeuroColors.CoralAccent,
                                modifier = Modifier.size(20.dp)
                            )
                            Text("Optional PC Sync", style = MaterialTheme.typography.titleMedium, color = NeuroColors.CoralSoft)
                        }
                        Text(
                            text = "Everything works locally on this phone without a PC. Enter a host address to sync OneBrain snapshots and captures via /api/phone-sync.",
                            style = MaterialTheme.typography.bodySmall,
                            color = NeuroColors.InkDim
                        )
                        PillTextField(
                            value = serverUrlDraft,
                            onValueChange = { serverUrlDraft = it },
                            placeholder = "http://192.168.1.10:7861"
                        )
                        PillTextField(
                            value = passwordDraft,
                            onValueChange = { passwordDraft = it },
                            placeholder = "Remote Access Password (optional)"
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            CoralPillButton(
                                text = "Save Endpoint",
                                primary = false,
                                onClick = {
                                    onUpdateSettings {
                                        it.copy(
                                            serverUrl = serverUrlDraft.trim(),
                                            remotePassword = passwordDraft
                                        )
                                    }
                                },
                                modifier = Modifier.testTag("save_sync_button")
                            )
                            CoralPillButton(
                                text = if (state.isSyncing) "Syncing..." else "Sync Now",
                                primary = true,
                                enabled = !state.isSyncing,
                                onClick = {
                                    onUpdateSettings {
                                        it.copy(
                                            serverUrl = serverUrlDraft.trim(),
                                            remotePassword = passwordDraft
                                        )
                                    }
                                    onSyncNow()
                                },
                                modifier = Modifier.testTag("sync_now_button")
                            )
                        }
                        if (!state.syncResultMessage.isNullOrBlank()) {
                            StatusChip(label = state.syncResultMessage, toneColor = NeuroColors.CoralSoft)
                        }
                    }
                }
            }

            // Appearance, Voice & Hive Mode
            item {
                GlassPanel {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.Tune,
                                contentDescription = "Appearance icon",
                                tint = NeuroColors.CoralAccent,
                                modifier = Modifier.size(20.dp)
                            )
                            Text("Theme, Voice, Hive & Ambient Ring", style = MaterialTheme.typography.titleMedium, color = NeuroColors.CoralSoft)
                        }

                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("Appearance Mode", style = MaterialTheme.typography.bodyLarge, color = NeuroColors.Ink)
                            Text(
                                "Follows Android system Light/Dark settings by default",
                                style = MaterialTheme.typography.bodySmall,
                                color = NeuroColors.InkDim
                            )
                            FlowRow(
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                val currentMode = ThemeMode.fromKey(settings.themeMode)
                                ThemeMode.entries.forEach { mode ->
                                    CoralPillButton(
                                        text = mode.label,
                                        primary = currentMode == mode,
                                        onClick = {
                                            onUpdateSettings { it.copy(themeMode = mode.storageKey) }
                                        },
                                        modifier = Modifier.testTag("theme_mode_${mode.storageKey.lowercase()}")
                                    )
                                }
                            }
                        }

                        SettingSwitchRow(
                            title = "Material 3 Dynamic Color",
                            subtitle = "Adapts accent and surface palette from device wallpaper on Android 12+",
                            checked = settings.dynamicColorEnabled,
                            onCheckedChange = { enabled -> onUpdateSettings { it.copy(dynamicColorEnabled = enabled) } },
                            tag = "dynamic_color_switch"
                        )

                        SettingSwitchRow(
                            title = "Speak Agent Replies (TTS)",
                            subtitle = "Speaks OneBrain answers aloud using on-device voice synthesis",
                            checked = settings.speakReplies,
                            onCheckedChange = { enabled -> onUpdateSettings { it.copy(speakReplies = enabled) } },
                            tag = "speak_replies_switch"
                        )

                        SettingSwitchRow(
                            title = "Hive Mind Multi-Agent Mode",
                            subtitle = "Evaluates prompts with 5 specialized local personas before replying",
                            checked = settings.hiveModeEnabled,
                            onCheckedChange = { enabled -> onUpdateSettings { it.copy(hiveModeEnabled = enabled) } },
                            tag = "hive_mode_switch"
                        )

                        SettingSwitchRow(
                            title = "Floating Shoggoth Orb",
                            subtitle = "Persistent draggable overlay orb across other Android apps",
                            checked = settings.floatingOrbEnabled,
                            onCheckedChange = onToggleFloatingOrb,
                            tag = "settings_floating_orb_switch"
                        )

                        SettingSwitchRow(
                            title = "Crown Ring & Shoggoth Ambient",
                            subtitle = "Live 3D-projected coral cord and skill tentacles behind the interface",
                            checked = settings.ambientRingEnabled,
                            onCheckedChange = { enabled -> onUpdateSettings { it.copy(ambientRingEnabled = enabled) } },
                            tag = "ambient_ring_switch"
                        )

                        SettingSwitchRow(
                            title = "Reduced Motion",
                            subtitle = "Calms ring rotation and tentacle sway animations",
                            checked = settings.reducedMotion,
                            onCheckedChange = { enabled -> onUpdateSettings { it.copy(reducedMotion = enabled) } },
                            tag = "reduced_motion_switch"
                        )

                        SettingSwitchRow(
                            title = "Open Chat on Launch",
                            subtitle = "Start directly on the local OneBrain conversation screen",
                            checked = settings.openChatOnLaunch,
                            onCheckedChange = { enabled -> onUpdateSettings { it.copy(openChatOnLaunch = enabled) } },
                            tag = "open_chat_switch"
                        )
                    }
                }
            }

            // Workspace Folder & System Access Shortcuts
            item {
                GlassPanel {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("Workspace & System Access", style = MaterialTheme.typography.titleMedium, color = NeuroColors.CoralSoft)
                        Text(
                            text = if (settings.workspaceTreeUri.isBlank()) "No device folder linked yet." else "Linked folder: ${settings.workspaceTreeUri.takeLast(48)}",
                            style = MaterialTheme.typography.bodySmall,
                            color = NeuroColors.InkDim
                        )
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            CoralPillButton(
                                text = "Link Workspace Folder",
                                primary = false,
                                onClick = { folderPicker.launch(null) }
                            )
                            CoralPillButton(
                                text = "App Permissions",
                                primary = false,
                                onClick = { onRunDeviceTool("open_app_settings") },
                                modifier = Modifier.testTag("open_os_settings_button")
                            )
                        }
                    }
                }
            }

            // Export & Erase Training Data
            item {
                GlassPanel {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            CoralPillButton(
                                text = "Export Chats JSON",
                                primary = false,
                                onClick = onExportChats,
                                modifier = Modifier.testTag("export_chats_button")
                            )
                            CoralPillButton(
                                text = if (confirmErase) "Tap Again to Erase" else "Erase Local Training Data",
                                primary = false,
                                onClick = {
                                    if (confirmErase) {
                                        onEraseTrainingData()
                                        confirmErase = false
                                    } else {
                                        confirmErase = true
                                    }
                                },
                                modifier = Modifier.testTag("erase_training_button")
                            )
                        }
                        if (confirmErase) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp)
                            ) {
                                Icon(
                                    imageVector = Icons.Default.DeleteForever,
                                    contentDescription = "Confirm erase",
                                    tint = NeuroColors.ErrorPink,
                                    modifier = Modifier.size(16.dp)
                                )
                                Text(
                                    text = "Clears saved captures and Yes/No training examples on this phone.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = NeuroColors.ErrorPink
                                )
                            }
                        }

                        if (!state.exportedJsonPreview.isNullOrBlank()) {
                            Surface(
                                shape = NeuroCorner.Bubble,
                                color = NeuroColors.InputFill,
                                border = BorderStroke(1.dp, NeuroColors.GlassLine),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .heightIn(max = 220.dp)
                            ) {
                                Column(
                                    modifier = Modifier
                                        .padding(12.dp)
                                        .verticalScroll(rememberScrollState()),
                                    verticalArrangement = Arrangement.spacedBy(6.dp)
                                ) {
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                                    ) {
                                        Icon(
                                            imageVector = Icons.Default.Download,
                                            contentDescription = "JSON Preview",
                                            tint = NeuroColors.ShoggothGreen,
                                            modifier = Modifier.size(16.dp)
                                        )
                                        Text("Exported Sessions JSON", style = MaterialTheme.typography.labelLarge, color = NeuroColors.ShoggothGreen)
                                    }
                                    Text(
                                        text = state.exportedJsonPreview,
                                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                        color = NeuroColors.InkDim
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingSwitchRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    tag: String
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f).padding(end = 10.dp)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = NeuroColors.Ink)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = NeuroColors.InkDim)
        }
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = NeuroColors.CoralSoft,
                checkedTrackColor = NeuroColors.PrimaryFill
            ),
            modifier = Modifier.testTag(tag)
        )
    }
}
