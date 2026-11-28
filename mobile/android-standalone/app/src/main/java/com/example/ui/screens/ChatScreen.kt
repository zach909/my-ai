package com.example.ui.screens

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.example.R
import com.example.model.ChatMessage
import com.example.model.MessageRole
import com.example.model.PromptButtonParser
import com.example.ui.components.CoralPillButton
import com.example.ui.components.GlassPanel
import com.example.ui.components.PillTextField
import com.example.ui.components.StatusChip
import com.example.ui.theme.NeuroColors
import com.example.ui.theme.NeuroCorner
import com.example.viewmodel.NeuroUiState
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ChatScreen(
    state: NeuroUiState,
    onTypingPulse: (Float) -> Unit,
    onSendMessage: (String) -> Unit,
    onPickPhoto: (android.net.Uri, String) -> Unit,
    onCameraSnapshot: (android.graphics.Bitmap, String) -> Unit,
    onPickDocument: (android.net.Uri) -> Unit,
    onLinkWorkspaceFolder: (android.net.Uri) -> Unit,
    onNewSession: () -> Unit,
    onSelectSession: (String) -> Unit,
    onSelectWorkspace: (String) -> Unit,
    onCreateWorkspace: (String) -> Unit,
    onRemovePinnedAction: (String) -> Unit,
    onToggleHiveMode: (Boolean) -> Unit,
    onToggleSpeakReplies: (Boolean) -> Unit,
    onRecordMistake: (String, String, String) -> Unit,
    onRunDeviceTool: (String, String) -> Unit,
    onTeachYesNo: (String, String, Boolean) -> Unit,
    onRecreateAgent: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    var inputText by remember { mutableStateOf("") }
    var isListening by remember { mutableStateOf(false) }
    var showSessionsSheet by remember { mutableStateOf(false) }
    var showToolsSheet by remember { mutableStateOf(false) }
    var toolsTab by remember { mutableIntStateOf(0) }
    var appSearch by remember { mutableStateOf("") }
    var showTeachDialog by remember { mutableStateOf(false) }
    var showNewDeskDialog by remember { mutableStateOf(false) }
    var mistakeTarget by remember { mutableStateOf<Pair<String, String>?>(null) }
    var localNotice by remember { mutableStateOf<String?>(null) }

    val messages = state.activeSession?.messages ?: emptyList()
    val listState = rememberLazyListState()

    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) {
            listState.animateScrollToItem(messages.size - 1)
        }
    }

    // Native Android Text-to-Speech for spoken replies
    var ttsReady by remember { mutableStateOf(false) }
    val tts = remember {
        var engine: TextToSpeech? = null
        engine = TextToSpeech(context) { status ->
            if (status == TextToSpeech.SUCCESS) {
                engine?.language = Locale.getDefault()
                ttsReady = true
            }
        }
        engine
    }
    DisposableEffect(tts) {
        onDispose { tts.shutdown() }
    }
    LaunchedEffect(state.lastSpokenEvent, state.settings.speakReplies, ttsReady) {
        val evt = state.lastSpokenEvent ?: return@LaunchedEffect
        if (state.settings.speakReplies && ttsReady) {
            val cleanText = evt.second
                .replace(Regex("\\[\\[[^\\]]*\\]\\]"), "")
                .take(400)
            if (cleanText.isNotBlank()) {
                onTypingPulse(0.6f)
                tts.speak(cleanText, TextToSpeech.QUEUE_FLUSH, null, evt.first)
            }
        }
    }

    val speechRecognizer = remember {
        if (SpeechRecognizer.isRecognitionAvailable(context)) {
            SpeechRecognizer.createSpeechRecognizer(context)
        } else {
            null
        }
    }
    DisposableEffect(speechRecognizer) {
        onDispose { speechRecognizer?.destroy() }
    }

    fun beginListening() {
        val recognizer = speechRecognizer
        if (recognizer == null) {
            localNotice = context.getString(R.string.speech_unavailable)
            return
        }
        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onResults(results: Bundle?) {
                val spoken = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (!spoken.isNullOrBlank()) {
                    inputText = if (inputText.isBlank()) spoken else "$inputText $spoken"
                    onTypingPulse(0.25f)
                }
                isListening = false
            }
            override fun onError(error: Int) { isListening = false }
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        }
        recognizer.startListening(intent)
        isListening = true
    }

    val micPermLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) beginListening() else localNotice = context.getString(R.string.mic_permission_needed)
    }

    val photoPickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri != null) {
            val note = inputText.trim()
            inputText = ""
            onPickPhoto(uri, note)
        }
    }

    val cameraPreviewLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicturePreview()
    ) { bitmap ->
        if (bitmap != null) {
            val note = inputText.trim()
            inputText = ""
            onCameraSnapshot(bitmap, note)
        }
    }

    val cameraPermLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) cameraPreviewLauncher.launch(null)
        else localNotice = "Camera permission is needed to capture snapshots."
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

    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.TopCenter
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .widthIn(max = 720.dp)
                .imePadding()
                .padding(horizontal = 14.dp, vertical = 8.dp)
        ) {
            // Compact Top Header Bar
            GlassPanel(
                cornerRadius = 28.dp,
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(9.dp)
                                    .clip(CircleShape)
                                    .background(if (state.dangerState.agentAlive) NeuroColors.ShoggothGreen else NeuroColors.ErrorPink)
                            )
                            Text(
                                text = state.activeSession?.title ?: stringResource(R.string.app_name),
                                style = MaterialTheme.typography.titleMedium,
                                color = NeuroColors.Ink,
                                maxLines = 1
                            )
                        }
                        Text(
                            text = "${state.settings.localAccountName} • ${state.meshStats.oneBrainEdges} edges • ${state.meshStats.activeRegions.size} regions",
                            style = MaterialTheme.typography.bodySmall,
                            color = NeuroColors.InkDim
                        )
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(0.dp)) {
                        IconButton(
                            onClick = { onToggleHiveMode(!state.settings.hiveModeEnabled) },
                            modifier = Modifier.minimumInteractiveComponentSize().testTag("hive_mode_button")
                        ) {
                            Icon(
                                imageVector = Icons.Default.Hub,
                                contentDescription = "Toggle Hive Mind consensus",
                                tint = if (state.settings.hiveModeEnabled) NeuroColors.ShoggothGreen else NeuroColors.InkDim
                            )
                        }
                        IconButton(
                            onClick = {
                                val next = !state.settings.speakReplies
                                if (!next) tts.stop()
                                onToggleSpeakReplies(next)
                            },
                            modifier = Modifier.minimumInteractiveComponentSize().testTag("tts_button")
                        ) {
                            Icon(
                                imageVector = if (state.settings.speakReplies) Icons.AutoMirrored.Filled.VolumeUp else Icons.AutoMirrored.Filled.VolumeOff,
                                contentDescription = "Toggle spoken replies",
                                tint = if (state.settings.speakReplies) NeuroColors.ShoggothGreen else NeuroColors.InkDim
                            )
                        }
                        IconButton(
                            onClick = { showTeachDialog = true },
                            modifier = Modifier.minimumInteractiveComponentSize().testTag("teach_button")
                        ) {
                            Icon(
                                imageVector = Icons.Default.Psychology,
                                contentDescription = stringResource(R.string.chat_teach_desc),
                                tint = NeuroColors.CoralSoft
                            )
                        }
                        IconButton(
                            onClick = { showSessionsSheet = true },
                            modifier = Modifier.minimumInteractiveComponentSize().testTag("sessions_button")
                        ) {
                            Icon(
                                imageVector = Icons.Default.History,
                                contentDescription = stringResource(R.string.chat_sessions_desc),
                                tint = NeuroColors.CoralSoft
                            )
                        }
                        IconButton(
                            onClick = onNewSession,
                            modifier = Modifier.minimumInteractiveComponentSize().testTag("new_chat_button")
                        ) {
                            Icon(
                                imageVector = Icons.Default.Add,
                                contentDescription = stringResource(R.string.chat_new_session),
                                tint = NeuroColors.CoralSoft
                            )
                        }
                    }
                }
            }

            // Multi-Desktop Workspace Switcher + Pinned Desktop Actions
            Spacer(Modifier.height(6.dp))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                state.workspaces.forEach { desk ->
                    val selected = desk.id == state.activeWorkspace?.id
                    StatusChip(
                        label = desk.name,
                        toneColor = if (selected) NeuroColors.CoralSoft else NeuroColors.InkDim,
                        onClick = { onSelectWorkspace(desk.id) }
                    )
                }
                StatusChip(
                    label = "+ Desk",
                    toneColor = NeuroColors.ShoggothGreen,
                    onClick = { showNewDeskDialog = true },
                    modifier = Modifier.testTag("new_desk_button")
                )
            }

            val pinned = state.activeWorkspace?.pinnedActions.orEmpty()
            if (pinned.isNotEmpty()) {
                Spacer(Modifier.height(6.dp))
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    pinned.forEach { pin ->
                        Surface(
                            shape = CircleShape,
                            color = NeuroColors.PrimaryFill,
                            border = BorderStroke(1.dp, NeuroColors.PrimaryLine)
                        ) {
                            Row(
                                modifier = Modifier.padding(start = 10.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp)
                            ) {
                                Text(
                                    text = pin.label,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = NeuroColors.CoralSoft,
                                    modifier = Modifier.clickable { onSendMessage(pin.prompt) }
                                )
                                Icon(
                                    imageVector = Icons.Default.Close,
                                    contentDescription = "Unpin ${pin.label}",
                                    tint = NeuroColors.InkDim,
                                    modifier = Modifier
                                        .size(14.dp)
                                        .clickable { onRemovePinnedAction(pin.id) }
                                )
                            }
                        }
                    }
                }
            }

            if (!state.dangerState.agentAlive) {
                Spacer(Modifier.height(8.dp))
                GlassPanel(
                    cornerRadius = 24.dp,
                    highlighted = true,
                    contentPadding = PaddingValues(14.dp)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = stringResource(R.string.agent_removed_notice),
                            style = MaterialTheme.typography.bodyMedium,
                            color = NeuroColors.CoralSoft,
                            modifier = Modifier.weight(1f).padding(end = 10.dp)
                        )
                        CoralPillButton(
                            text = "Restore",
                            onClick = onRecreateAgent,
                            modifier = Modifier.testTag("restore_agent_button")
                        )
                    }
                }
            }

            if (!localNotice.isNullOrBlank()) {
                Spacer(Modifier.height(6.dp))
                StatusChip(
                    label = localNotice!!,
                    toneColor = NeuroColors.CoralSoft,
                    onClick = { localNotice = null }
                )
            }

            // Message Transcript
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                contentPadding = PaddingValues(vertical = 6.dp)
            ) {
                items(messages, key = { it.id }) { msg ->
                    val idx = messages.indexOf(msg)
                    val prevUserPrompt = messages.take(idx).lastOrNull { it.role == MessageRole.USER }?.text ?: ""
                    ChatBubbleItem(
                        message = msg,
                        onPromptButtonClick = { prompt -> onSendMessage(prompt) },
                        onFlagMistake = { badReply -> mistakeTarget = prevUserPrompt to badReply }
                    )
                }
                if (state.isThinking) {
                    item(key = "thinking") {
                        StatusChip(
                            label = if (state.settings.hiveModeEnabled) "Hive Mind consensus cycling..." else "OneBrain Zip Loop propagating...",
                            toneColor = NeuroColors.ShoggothGreen
                        )
                    }
                }
            }

            // Composer Bar
            GlassPanel(
                cornerRadius = 30.dp,
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp)
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        PillTextField(
                            value = inputText,
                            onValueChange = {
                                inputText = it
                                onTypingPulse(0.14f)
                            },
                            placeholder = stringResource(R.string.chat_input_hint),
                            singleLine = false,
                            maxLines = 4,
                            shape = RoundedCornerShape(24.dp),
                            modifier = Modifier
                                .weight(1f)
                                .testTag("chat_input")
                        )
                        IconButton(
                            onClick = {
                                if (inputText.isNotBlank() && !state.isThinking) {
                                    val outgoing = inputText
                                    inputText = ""
                                    onSendMessage(outgoing)
                                }
                            },
                            enabled = inputText.isNotBlank() && !state.isThinking,
                            modifier = Modifier
                                .minimumInteractiveComponentSize()
                                .clip(CircleShape)
                                .background(
                                    if (inputText.isNotBlank()) NeuroColors.PrimaryFill else NeuroColors.ButtonNeutralFill
                                )
                                .border(
                                    1.dp,
                                    if (inputText.isNotBlank()) NeuroColors.PrimaryLine else NeuroColors.GlassLine,
                                    CircleShape
                                )
                                .testTag("send_button")
                        ) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.Send,
                                contentDescription = stringResource(R.string.chat_send),
                                tint = NeuroColors.CoralSoft
                            )
                        }
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        StatusChip(
                            label = if (isListening) "Stop Mic" else "Voice",
                            toneColor = if (isListening) NeuroColors.ErrorPink else NeuroColors.CoralSoft,
                            onClick = {
                                if (isListening) {
                                    speechRecognizer?.stopListening()
                                    isListening = false
                                } else {
                                    val granted = ContextCompat.checkSelfPermission(
                                        context,
                                        Manifest.permission.RECORD_AUDIO
                                    ) == PackageManager.PERMISSION_GRANTED
                                    if (granted) beginListening()
                                    else micPermLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                }
                            },
                            modifier = Modifier.testTag("mic_button")
                        )
                        StatusChip(
                            label = "Photo",
                            toneColor = NeuroColors.CoralSoft,
                            onClick = {
                                photoPickerLauncher.launch(
                                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                                )
                            },
                            modifier = Modifier.testTag("photo_button")
                        )
                        StatusChip(
                            label = "Camera",
                            toneColor = NeuroColors.CoralSoft,
                            onClick = {
                                val granted = ContextCompat.checkSelfPermission(
                                    context,
                                    Manifest.permission.CAMERA
                                ) == PackageManager.PERMISSION_GRANTED
                                if (granted) cameraPreviewLauncher.launch(null)
                                else cameraPermLauncher.launch(Manifest.permission.CAMERA)
                            },
                            modifier = Modifier.testTag("camera_button")
                        )
                        StatusChip(
                            label = "Tools & Apps",
                            toneColor = NeuroColors.ShoggothGreen,
                            onClick = { showToolsSheet = true },
                            modifier = Modifier.testTag("tools_button")
                        )
                        Spacer(Modifier.weight(1f))
                        Icon(
                            imageVector = if (isListening) Icons.Default.Stop else Icons.Default.Mic,
                            contentDescription = null,
                            tint = if (isListening) NeuroColors.ErrorPink else NeuroColors.InkFaint,
                            modifier = Modifier.size(16.dp)
                        )
                        Icon(
                            imageVector = Icons.Default.PhotoLibrary,
                            contentDescription = null,
                            tint = NeuroColors.InkFaint,
                            modifier = Modifier.size(16.dp)
                        )
                        Icon(
                            imageVector = Icons.Default.CameraAlt,
                            contentDescription = null,
                            tint = NeuroColors.InkFaint,
                            modifier = Modifier.size(16.dp)
                        )
                        Icon(
                            imageVector = Icons.Default.Build,
                            contentDescription = null,
                            tint = NeuroColors.InkFaint,
                            modifier = Modifier.size(16.dp)
                        )
                    }
                }
            }
        }
    }

    if (showSessionsSheet) {
        ModalBottomSheet(
            onDismissRequest = { showSessionsSheet = false },
            containerColor = NeuroColors.GroundSecondary,
            contentColor = NeuroColors.Ink
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "${state.activeWorkspace?.name ?: "Desk"} Chats",
                        style = MaterialTheme.typography.titleLarge,
                        color = NeuroColors.CoralSoft
                    )
                    CoralPillButton(
                        text = "New chat",
                        onClick = {
                            onNewSession()
                            showSessionsSheet = false
                        }
                    )
                }
                state.workspaceSessions.forEach { session ->
                    val selected = session.id == state.activeSession?.id
                    Surface(
                        shape = NeuroCorner.Bubble,
                        color = if (selected) NeuroColors.PrimaryFill else NeuroColors.GlassFill,
                        border = BorderStroke(1.dp, if (selected) NeuroColors.PrimaryLine else NeuroColors.GlassLine),
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                onSelectSession(session.id)
                                showSessionsSheet = false
                            }
                    ) {
                        Column(modifier = Modifier.padding(14.dp)) {
                            Text(
                                text = session.title,
                                style = MaterialTheme.typography.titleMedium,
                                color = NeuroColors.Ink
                            )
                            Text(
                                text = "${session.messages.size} messages",
                                style = MaterialTheme.typography.bodySmall,
                                color = NeuroColors.InkDim
                            )
                        }
                    }
                }
                Spacer(Modifier.height(16.dp))
            }
        }
    }

    if (showToolsSheet) {
        ModalBottomSheet(
            onDismissRequest = { showToolsSheet = false },
            containerColor = NeuroColors.GroundSecondary,
            contentColor = NeuroColors.Ink
        ) {
            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        CoralPillButton(
                            text = "Device Tools",
                            primary = toolsTab == 0,
                            onClick = { toolsTab = 0 }
                        )
                        CoralPillButton(
                            text = "App Launcher (${state.installedApps.size})",
                            primary = toolsTab == 1,
                            onClick = { toolsTab = 1 }
                        )
                    }
                }

                if (toolsTab == 0) {
                    item {
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            CoralPillButton(
                                text = "Import File",
                                primary = false,
                                onClick = {
                                    showToolsSheet = false
                                    docPickerLauncher.launch(arrayOf("*/*"))
                                },
                                modifier = Modifier.testTag("import_doc_button")
                            )
                            CoralPillButton(
                                text = if (state.settings.workspaceTreeUri.isBlank()) "Link Workspace Folder" else "Relink Folder",
                                primary = false,
                                onClick = {
                                    showToolsSheet = false
                                    folderPickerLauncher.launch(null)
                                }
                            )
                        }
                    }
                    items(state.deviceToolCatalog, key = { it.name }) { tool ->
                        Surface(
                            shape = NeuroCorner.Bubble,
                            color = NeuroColors.GlassFill,
                            border = BorderStroke(1.dp, NeuroColors.GlassLine),
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    showToolsSheet = false
                                    onSendMessage(tool.samplePrompt)
                                }
                        ) {
                            Row(
                                modifier = Modifier.padding(14.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(tool.title, style = MaterialTheme.typography.titleMedium, color = NeuroColors.Ink)
                                    Text(tool.description, style = MaterialTheme.typography.bodySmall, color = NeuroColors.InkDim)
                                }
                                StatusChip(label = "Run", toneColor = NeuroColors.ShoggothGreen)
                            }
                        }
                    }
                } else {
                    item {
                        PillTextField(
                            value = appSearch,
                            onValueChange = { appSearch = it },
                            placeholder = "Filter installed apps..."
                        )
                    }
                    val filtered = state.installedApps.filter {
                        appSearch.isBlank() ||
                            it.label.contains(appSearch, ignoreCase = true) ||
                            it.packageName.contains(appSearch, ignoreCase = true)
                    }
                    items(filtered, key = { it.packageName }) { app ->
                        Surface(
                            shape = NeuroCorner.Bubble,
                            color = NeuroColors.GlassFill,
                            border = BorderStroke(1.dp, NeuroColors.GlassLine),
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    showToolsSheet = false
                                    onRunDeviceTool("launch_app", app.packageName)
                                }
                        ) {
                            Row(
                                modifier = Modifier.padding(14.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(app.label, style = MaterialTheme.typography.titleMedium, color = NeuroColors.Ink)
                                    Text(app.packageName, style = MaterialTheme.typography.bodySmall, color = NeuroColors.InkDim)
                                }
                                StatusChip(label = "Launch", toneColor = NeuroColors.CoralSoft)
                            }
                        }
                    }
                }
                item { Spacer(Modifier.height(16.dp)) }
            }
        }
    }

    if (showTeachDialog) {
        QuickTeachDialog(
            onDismiss = { showTeachDialog = false },
            onTeach = { q, example, ans ->
                onTeachYesNo(q, example, ans)
                showTeachDialog = false
            }
        )
    }

    if (showNewDeskDialog) {
        CreateWorkspaceDialog(
            onDismiss = { showNewDeskDialog = false },
            onCreate = { name ->
                onCreateWorkspace(name)
                showNewDeskDialog = false
            }
        )
    }

    mistakeTarget?.let { (prompt, badReply) ->
        MistakeCorrectionDialog(
            prompt = prompt,
            onDismiss = { mistakeTarget = null },
            onSave = { correction ->
                onRecordMistake(prompt, badReply, correction)
                mistakeTarget = null
            }
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChatBubbleItem(
    message: ChatMessage,
    onPromptButtonClick: (String) -> Unit,
    onFlagMistake: (String) -> Unit
) {
    if (message.role == MessageRole.SYSTEM) {
        Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Text(
                text = message.text,
                style = MaterialTheme.typography.bodySmall,
                color = NeuroColors.InkDim,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)
            )
        }
        return
    }

    val isUser = message.role == MessageRole.USER
    var showDiagnostics by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = if (isUser) Alignment.End else Alignment.Start
    ) {
        Surface(
            shape = NeuroCorner.Bubble,
            color = if (isUser) NeuroColors.PrimaryFill else NeuroColors.AgentBubbleFill,
            border = BorderStroke(
                1.dp,
                when {
                    message.isError -> NeuroColors.ErrorPink
                    isUser -> NeuroColors.PrimaryLine
                    else -> NeuroColors.GlassLine
                }
            ),
            modifier = Modifier.widthIn(max = 520.dp)
        ) {
            Column(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                if (!message.attachedPhotoName.isNullOrBlank()) {
                    StatusChip(
                        label = "Captured: ${message.attachedPhotoName}",
                        toneColor = NeuroColors.ShoggothGreen
                    )
                }

                if (isUser) {
                    Text(
                        text = message.text,
                        style = MaterialTheme.typography.bodyLarge,
                        color = NeuroColors.Ink
                    )
                } else {
                    val parts = remember(message.text) { PromptButtonParser.split(message.text) }
                    val proseParts = parts.filter { !it.isButton || it.putTarget != null }
                    val buttonParts = parts.filter { it.isButton && it.putTarget == null }

                    proseParts.forEach { part ->
                        val clean = part.text.trim()
                        if (clean.isNotEmpty() && part.putTarget == null) {
                            Text(
                                text = clean,
                                style = MaterialTheme.typography.bodyLarge,
                                color = NeuroColors.Ink
                            )
                        }
                    }

                    if (buttonParts.isNotEmpty()) {
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            buttonParts.forEach { btn ->
                                CoralPillButton(
                                    text = btn.text,
                                    onClick = { onPromptButtonClick(btn.prompt) },
                                    primary = true
                                )
                            }
                        }
                    }

                    if (message.activeRegions.isNotEmpty() || message.recalledBytes.isNotEmpty() || message.hiveVotes.isNotEmpty()) {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            StatusChip(
                                label = if (showDiagnostics) "Hide trace" else "${message.cycleMs} ms • ${message.activeRegions.size} regions",
                                toneColor = NeuroColors.InkDim,
                                onClick = { showDiagnostics = !showDiagnostics }
                            )
                            StatusChip(
                                label = "Correct",
                                toneColor = NeuroColors.CoralAccent,
                                onClick = { onFlagMistake(message.text) }
                            )
                        }
                        AnimatedVisibility(visible = showDiagnostics) {
                            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(
                                    text = "Regions: ${message.activeRegions.joinToString(", ")}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = NeuroColors.CoralSoft
                                )
                                if (message.recalledBytes.isNotEmpty()) {
                                    Text(
                                        text = "Recalled bytes: ${message.recalledBytes.joinToString(" ")}",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = NeuroColors.ShoggothGreen
                                    )
                                }
                                if (message.hiveVotes.isNotEmpty()) {
                                    message.hiveVotes.forEach { vote ->
                                        Text(
                                            text = "Hive[${vote.persona} ${(vote.confidence * 100).toInt()}%]: ${vote.stance}",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = NeuroColors.CoralSoft
                                        )
                                    }
                                }
                                Text(
                                    text = "Surprise: ${"%.2f".format(message.surpriseScore)}",
                                    style = MaterialTheme.typography.bodySmall,
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

@Composable
private fun QuickTeachDialog(
    onDismiss: () -> Unit,
    onTeach: (String, String, Boolean) -> Unit
) {
    var question by remember { mutableStateOf("Is this an urgent task?") }
    var example by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = NeuroColors.GroundSecondary,
        titleContentColor = NeuroColors.CoralSoft,
        textContentColor = NeuroColors.Ink,
        title = { Text("Teach Yes / No Doorway") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    text = "Teach a binary concept directly into OneBrain on this device.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = NeuroColors.InkDim
                )
                PillTextField(
                    value = question,
                    onValueChange = { question = it },
                    placeholder = "Question (e.g. Is this urgent?)"
                )
                PillTextField(
                    value = example,
                    onValueChange = { example = it },
                    placeholder = "Example text",
                    singleLine = false,
                    maxLines = 3
                )
            }
        },
        confirmButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CoralPillButton(
                    text = "Teach No",
                    primary = false,
                    enabled = question.isNotBlank() && example.isNotBlank(),
                    onClick = { onTeach(question, example, false) }
                )
                CoralPillButton(
                    text = "Teach Yes",
                    primary = true,
                    enabled = question.isNotBlank() && example.isNotBlank(),
                    onClick = { onTeach(question, example, true) }
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", color = NeuroColors.InkDim)
            }
        }
    )
}

@Composable
private fun CreateWorkspaceDialog(
    onDismiss: () -> Unit,
    onCreate: (String) -> Unit
) {
    var name by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = NeuroColors.GroundSecondary,
        titleContentColor = NeuroColors.CoralSoft,
        textContentColor = NeuroColors.Ink,
        title = { Text("New Desktop Workspace") },
        text = {
            PillTextField(
                value = name,
                onValueChange = { name = it },
                placeholder = "Workspace name (e.g. Coding)"
            )
        },
        confirmButton = {
            CoralPillButton(
                text = "Create",
                enabled = name.isNotBlank(),
                onClick = { onCreate(name) }
            )
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", color = NeuroColors.InkDim)
            }
        }
    )
}

@Composable
private fun MistakeCorrectionDialog(
    prompt: String,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit
) {
    var correction by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = NeuroColors.GroundSecondary,
        titleContentColor = NeuroColors.CoralSoft,
        textContentColor = NeuroColors.Ink,
        title = { Text("Record Mistake & Correction") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (prompt.isNotBlank()) {
                    Text(
                        text = "Prompt: \"${prompt.take(90)}\"",
                        style = MaterialTheme.typography.bodySmall,
                        color = NeuroColors.InkDim
                    )
                }
                PillTextField(
                    value = correction,
                    onValueChange = { correction = it },
                    placeholder = "What should OneBrain remember instead?",
                    singleLine = false,
                    maxLines = 3
                )
            }
        },
        confirmButton = {
            CoralPillButton(
                text = "Save Correction",
                enabled = correction.isNotBlank(),
                onClick = { onSave(correction) }
            )
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", color = NeuroColors.InkDim)
            }
        }
    )
}
