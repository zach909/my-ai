package com.example

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.example.ui.components.CrownRingAmbient
import com.example.ui.navigation.BuilderRoute
import com.example.ui.navigation.ChatRoute
import com.example.ui.navigation.CommonsRoute
import com.example.ui.navigation.MetricsRoute
import com.example.ui.navigation.SettingsRoute
import com.example.ui.screens.BuilderScreen
import com.example.ui.screens.ChatScreen
import com.example.ui.screens.CommonsScreen
import com.example.ui.screens.MetricsScreen
import com.example.ui.screens.SettingsScreen
import com.example.ui.theme.NeuroClawTheme
import com.example.ui.theme.NeuroColors
import com.example.ui.theme.ThemeMode
import com.example.viewmodel.NeuroViewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(
                android.graphics.Color.TRANSPARENT,
                android.graphics.Color.TRANSPARENT
            ),
            navigationBarStyle = SystemBarStyle.auto(
                android.graphics.Color.TRANSPARENT,
                android.graphics.Color.TRANSPARENT
            )
        )
        super.onCreate(savedInstanceState)
        setContent {
            val vm: NeuroViewModel = viewModel()
            val state by vm.uiState.collectAsStateWithLifecycle()
            NeuroClawTheme(
                themeMode = ThemeMode.fromKey(state.settings.themeMode),
                dynamicColor = state.settings.dynamicColorEnabled
            ) {
                NeuroClawApp(viewModel = vm)
            }
        }
    }
}

private data class TopNavItem(
    val route: Any,
    val labelRes: Int,
    val icon: ImageVector
)

@Composable
private fun NeuroClawApp(viewModel: NeuroViewModel) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val navController = rememberNavController()
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentDestination = backStackEntry?.destination
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(state.statusMessage) {
        val msg = state.statusMessage
        if (!msg.isNullOrBlank()) {
            snackbarHostState.showSnackbar(msg)
            viewModel.clearStatusMessage()
        }
    }

    val navItems = remember {
        listOf(
            TopNavItem(ChatRoute, R.string.nav_chat, Icons.Default.ChatBubble),
            TopNavItem(BuilderRoute, R.string.nav_builder, Icons.Default.Build),
            TopNavItem(MetricsRoute, R.string.nav_metrics, Icons.Default.Hub),
            TopNavItem(CommonsRoute, R.string.nav_commons, Icons.Default.Shield),
            TopNavItem(SettingsRoute, R.string.nav_settings, Icons.Default.Settings)
        )
    }

    fun navigateTo(route: Any) {
        navController.navigate(route) {
            popUpTo(navController.graph.findStartDestination().id) {
                saveState = true
            }
            launchSingleTop = true
            restoreState = true
        }
    }

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val useRail = maxWidth >= 700.dp

        Box(modifier = Modifier.fillMaxSize()) {
            CrownRingAmbient(
                enabled = state.settings.ambientRingEnabled,
                reducedMotion = state.settings.reducedMotion,
                agentAlive = state.dangerState.agentAlive,
                energyPulse = state.energyPulse,
                skillNames = state.meshStats.activeRegions,
                modifier = Modifier.fillMaxSize()
            )

            Scaffold(
                containerColor = Color.Transparent,
                contentWindowInsets = WindowInsets.safeDrawing,
                snackbarHost = { SnackbarHost(hostState = snackbarHostState) },
                bottomBar = {
                    if (!useRail) {
                        NavigationBar(
                            containerColor = NeuroColors.NavBarFill,
                            contentColor = NeuroColors.CoralSoft,
                            tonalElevation = 0.dp
                        ) {
                            navItems.forEach { item ->
                                val selected = currentDestination?.hasRoute(item.route::class) == true
                                val label = stringResource(item.labelRes)
                                NavigationBarItem(
                                    selected = selected,
                                    onClick = { navigateTo(item.route) },
                                    icon = { Icon(item.icon, contentDescription = label) },
                                    label = { Text(label, maxLines = 1) },
                                    colors = NavigationBarItemDefaults.colors(
                                        selectedIconColor = NeuroColors.CoralSoft,
                                        selectedTextColor = NeuroColors.CoralSoft,
                                        unselectedIconColor = NeuroColors.InkDim,
                                        unselectedTextColor = NeuroColors.InkDim,
                                        indicatorColor = NeuroColors.PrimaryFill
                                    )
                                )
                            }
                        }
                    }
                }
            ) { innerPadding ->
                Row(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(innerPadding)
                ) {
                    if (useRail) {
                        NavigationRail(
                            containerColor = NeuroColors.NavBarFill,
                            contentColor = NeuroColors.CoralSoft
                        ) {
                            navItems.forEach { item ->
                                val selected = currentDestination?.hasRoute(item.route::class) == true
                                val label = stringResource(item.labelRes)
                                NavigationRailItem(
                                    selected = selected,
                                    onClick = { navigateTo(item.route) },
                                    icon = { Icon(item.icon, contentDescription = label) },
                                    label = { Text(label, maxLines = 1) },
                                    colors = NavigationRailItemDefaults.colors(
                                        selectedIconColor = NeuroColors.CoralSoft,
                                        selectedTextColor = NeuroColors.CoralSoft,
                                        unselectedIconColor = NeuroColors.InkDim,
                                        unselectedTextColor = NeuroColors.InkDim,
                                        indicatorColor = NeuroColors.PrimaryFill
                                    )
                                )
                            }
                        }
                    }

                    NavHost(
                        navController = navController,
                        startDestination = ChatRoute,
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxSize()
                    ) {
                        composable<ChatRoute> {
                            ChatScreen(
                                state = state,
                                onTypingPulse = viewModel::exciteRing,
                                onSendMessage = { text -> viewModel.sendMessage(text) },
                                onPickPhoto = viewModel::attachPickedPhoto,
                                onCameraSnapshot = viewModel::attachCameraBitmap,
                                onPickDocument = viewModel::attachDocumentUri,
                                onLinkWorkspaceFolder = viewModel::linkWorkspaceTree,
                                onNewSession = viewModel::startNewSession,
                                onSelectSession = viewModel::selectSession,
                                onSelectWorkspace = viewModel::selectWorkspace,
                                onCreateWorkspace = viewModel::createWorkspace,
                                onRemovePinnedAction = viewModel::removePinnedAction,
                                onToggleHiveMode = { enabled ->
                                    viewModel.updateSettings { it.copy(hiveModeEnabled = enabled) }
                                },
                                onToggleSpeakReplies = { enabled ->
                                    viewModel.updateSettings { it.copy(speakReplies = enabled) }
                                },
                                onRecordMistake = viewModel::recordMistakeCorrection,
                                onRunDeviceTool = viewModel::runDeviceTool,
                                onTeachYesNo = viewModel::teachYesNo,
                                onRecreateAgent = viewModel::recreateAgent
                            )
                        }
                        composable<BuilderRoute> {
                            BuilderScreen(
                                state = state,
                                onBuildExtension = viewModel::buildAndGraftExtension,
                                onToggleExtensionActive = viewModel::toggleExtensionActive,
                                onDeleteExtension = viewModel::deleteExtension,
                                onToggleStoreInstall = viewModel::toggleStoreInstall
                            )
                        }
                        composable<MetricsRoute> {
                            MetricsScreen(
                                state = state,
                                onRunDrills = viewModel::runAllDrills,
                                onRunEndurance = viewModel::runEnduranceTraining,
                                onCaptureCheckpoint = viewModel::captureCheckpoint,
                                onRestoreCheckpoint = viewModel::restoreCheckpoint,
                                onImportWeightsUri = viewModel::importMeshDeltaFromUri,
                                onExportDelta = viewModel::exportMeshDeltaPreview,
                                onSleepNow = viewModel::sleepNow,
                                dreamLabels = viewModel::dreamLabels,
                                onSaveDreamsUri = viewModel::saveDreamsToUri,
                                onTeachYesNo = viewModel::teachYesNo,
                                onAskYesNo = viewModel::askYesNo
                            )
                        }
                        composable<CommonsRoute> {
                            CommonsScreen(
                                state = state,
                                missingRuntimePermissions = viewModel::missingRuntimePermissions,
                                onPermissionsUpdated = viewModel::refreshPermissions,
                                onRunDeviceTool = viewModel::runDeviceTool,
                                onPickDocument = viewModel::attachDocumentUri,
                                onLinkWorkspaceFolder = viewModel::linkWorkspaceTree,
                                onToggleFloatingOrb = viewModel::toggleFloatingOrb,
                                onExportDelta = viewModel::exportMeshDeltaPreview,
                                onImportDeltaUri = viewModel::importMeshDeltaFromUri,
                                onImportDeltaText = viewModel::importMeshDeltaText,
                                onToggleSandbox = viewModel::toggleSandbox,
                                onToggleAlignmentArmed = viewModel::toggleAlignmentArmed,
                                onSimulateRiskProbe = viewModel::simulateRiskProbe,
                                onResetAlignment = viewModel::resetAlignmentToNeutral,
                                onRemoveAgent = viewModel::removeAgentByPhrase,
                                onRecreateAgent = viewModel::recreateAgent,
                                onRunSelfHealing = viewModel::runSelfHealing,
                                onToggleDataDonor = { enabled ->
                                    viewModel.updateSettings { it.copy(dataDonorEnabled = enabled) }
                                },
                                onPauseDonorMinutes = viewModel::pauseDataDonor,
                                onGrantLease = viewModel::grantLease,
                                onRevokeLease = viewModel::revokeLease
                            )
                        }
                        composable<SettingsRoute> {
                            SettingsScreen(
                                state = state,
                                onUpdateSettings = viewModel::updateSettings,
                                onSwitchProfile = viewModel::switchProfile,
                                onAddProfile = viewModel::addProfile,
                                onToggleFloatingOrb = viewModel::toggleFloatingOrb,
                                onLinkWorkspaceFolder = viewModel::linkWorkspaceTree,
                                onSyncNow = { viewModel.syncWithPc(silent = false) },
                                onExportChats = viewModel::exportChatsPreview,
                                onEraseTrainingData = viewModel::eraseCapturedTrainingData,
                                onRunDeviceTool = { tool -> viewModel.runDeviceTool(tool, "") }
                            )
                        }
                    }
                }
            }
        }
    }
}
