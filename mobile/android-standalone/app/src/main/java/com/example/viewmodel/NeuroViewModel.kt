package com.example.viewmodel

import android.app.Application
import android.graphics.Bitmap
import android.content.Intent
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.example.engine.DeviceToolDescriptor
import com.example.engine.DeviceToolResult
import com.example.engine.DeviceTools
import com.example.engine.InstalledAppEntry
import com.example.engine.NeuroLangParser
import com.example.engine.NeuroRepository
import com.example.engine.OneBrainEngine
import com.example.engine.PermissionAuditEntry
import com.example.engine.SpecialAccessStatus
import com.example.engine.SyncClient
import com.example.model.AlignmentEvent
import com.example.model.AppSettings
import com.example.model.BrainCheckpoint
import com.example.model.BuiltExtension
import com.example.model.ByteEdgePreview
import com.example.model.CapabilityDrill
import com.example.model.CapturedPhotoRecord
import com.example.model.ChatMessage
import com.example.model.ChatSession
import com.example.model.ComputeLease
import com.example.model.DangerState
import com.example.model.DesktopWorkspace
import com.example.model.DrillRunResult
import com.example.model.EnduranceRoundResult
import com.example.model.HealingCheck
import com.example.model.MeshStatsSnapshot
import com.example.model.MessageRole
import com.example.model.MistakeRecord
import com.example.model.PinnedDesktopAction
import com.example.model.PromptButtonParser
import com.example.model.StoreCatalogItem
import com.example.model.WikiArticle
import com.example.model.YesNoExample
import com.example.model.YesNoQueryResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

data class NeuroUiState(
    val isReady: Boolean = false,
    val isThinking: Boolean = false,
    val energyPulse: Float = 0f,
    val settings: AppSettings = AppSettings(),
    val sessions: List<ChatSession> = emptyList(),
    val activeSessionId: String = "",
    val workspaces: List<DesktopWorkspace> = emptyList(),
    val activeWorkspaceId: String = "desk_main",
    val builtExtensions: List<BuiltExtension> = emptyList(),
    val storeItems: List<StoreCatalogItem> = emptyList(),
    val wikiArticles: List<WikiArticle> = emptyList(),
    val yesNoExamples: List<YesNoExample> = emptyList(),
    val lastYesNoQuery: YesNoQueryResult? = null,
    val mistakes: List<MistakeRecord> = emptyList(),
    val enduranceResults: List<EnduranceRoundResult> = emptyList(),
    val checkpoints: List<BrainCheckpoint> = emptyList(),
    val topByteEdges: List<ByteEdgePreview> = emptyList(),
    val dangerState: DangerState = DangerState(),
    val healingChecks: List<HealingCheck> = emptyList(),
    val leases: List<ComputeLease> = emptyList(),
    val captures: List<CapturedPhotoRecord> = emptyList(),
    val meshStats: MeshStatsSnapshot = MeshStatsSnapshot(),
    val valeDistribution: List<Float> = emptyList(),
    val drillResults: List<DrillRunResult> = emptyList(),
    val permissionEntries: List<PermissionAuditEntry> = emptyList(),
    val specialAccess: SpecialAccessStatus = SpecialAccessStatus(false, false, false, true, false),
    val deviceToolCatalog: List<DeviceToolDescriptor> = emptyList(),
    val installedApps: List<InstalledAppEntry> = emptyList(),
    val lastToolResult: DeviceToolResult? = null,
    val lastSpokenEvent: Pair<String, String>? = null,
    val statusMessage: String? = null,
    val syncResultMessage: String? = null,
    val isSyncing: Boolean = false,
    val exportedJsonPreview: String? = null,
    val exportedDeltaPreview: String? = null
) {
    val activeWorkspace: DesktopWorkspace?
        get() = workspaces.firstOrNull { it.id == activeWorkspaceId } ?: workspaces.firstOrNull()

    val workspaceSessions: List<ChatSession>
        get() = sessions.filter { it.workspaceId == (activeWorkspace?.id ?: "desk_main") }.ifEmpty { sessions }

    val activeSession: ChatSession?
        get() = workspaceSessions.firstOrNull { it.id == activeSessionId } ?: workspaceSessions.firstOrNull()
}

class NeuroViewModel(application: Application) : AndroidViewModel(application) {
    private val repo = NeuroRepository(application.applicationContext)
    private val engine = OneBrainEngine(application.applicationContext)
    private val deviceTools: DeviceTools = engine.deviceTools
    private val syncClient = SyncClient()

    private val _uiState = MutableStateFlow(NeuroUiState())
    val uiState: StateFlow<NeuroUiState> = _uiState.asStateFlow()

    val drills = listOf(
        CapabilityDrill("d_hyper", "Hyperdim", "Bind orthogonality probe", "orthogonality"),
        CapabilityDrill("d_vale", "Vale", "Zero-sum conservation check", "Vale sum"),
        CapabilityDrill("d_ndl", "NeuroLang", "DSL parser verification", "Parsed"),
        CapabilityDrill("d_zip", "ZipLoop", "Raw UTF-8 byte recall cycle", "Activated")
    )

    init {
        viewModelScope.launch {
            initializeState()
        }
        viewModelScope.launch {
            repo.settingsFlow.collect { s ->
                _uiState.update { it.copy(settings = s) }
            }
        }
    }

    private suspend fun initializeState() {
        val syncedModel = repo.loadSyncedOneBrainIfPresent()
        if (!syncedModel.isNullOrBlank()) {
            withContext(Dispatchers.Default) { engine.parseOneBrainModel(syncedModel) }
        }
        val extensions = repo.loadExtensions()
        val installedIds = repo.loadInstalledStoreIds()
        val storeItems = repo.builtInStoreCatalog(installedIds)
        val yesNo = repo.loadYesNoExamples()
        val danger = repo.loadDangerState()
        val leases = repo.loadLeases()
        val captures = repo.loadCaptures()
        val settings = repo.settingsFlow.first()
        val lastSync = repo.lastSyncMsFlow.first()
        val workspaces = repo.loadWorkspaces()
        val mistakes = repo.loadMistakes()
        val checkpoints = repo.loadCheckpoints()

        if (settings.workspaceTreeUri.isNotBlank()) {
            deviceTools.linkedWorkspaceTreeUri = Uri.parse(settings.workspaceTreeUri)
        }

        withContext(Dispatchers.Default) {
            engine.loadYesNoExamples(yesNo)
            mistakes.forEach { engine.recordMistake(it) }
            extensions.filter { it.activeInMesh }.forEach { engine.graftExtension(it) }
            storeItems.filter { it.installed }.forEach { item ->
                val parsed = NeuroLangParser.parse(item.neuroLangCode)
                if (parsed.isValid) {
                    engine.registerRegion(
                        id = "store:${item.id}",
                        name = item.title,
                        meaning = item.description,
                        definitions = parsed.neurons.mapNotNull { it.definition.ifBlank { null } }
                    )
                }
            }
        }

        val loadedSessions = repo.loadSessions()
        val sessions = if (loadedSessions.isEmpty()) {
            listOf(createDefaultSession("desk_main"))
        } else {
            loadedSessions
        }
        if (loadedSessions.isEmpty()) {
            repo.saveSessions(sessions)
        }

        val healing = withContext(Dispatchers.Default) { engine.runSelfHealing(extensions.size) }
        val unsyncedTurns = repo.readUnsyncedTurnLines().size
        val unsyncedTeach = repo.loadUnsyncedTeach().size
        val pendingPhotos = captures.count { !it.synced }

        val permAudit = deviceTools.auditPermissions()
        val special = deviceTools.specialAccessStatus()
        val toolCatalog = deviceTools.catalog()
        val apps = withContext(Dispatchers.Default) { deviceTools.listInstalledApps() }

        _uiState.update {
            it.copy(
                isReady = true,
                settings = settings,
                sessions = sessions,
                activeSessionId = sessions.first().id,
                workspaces = workspaces,
                activeWorkspaceId = workspaces.firstOrNull()?.id ?: "desk_main",
                builtExtensions = extensions,
                storeItems = storeItems,
                wikiArticles = repo.builtInWikiArticles(),
                yesNoExamples = yesNo,
                mistakes = mistakes,
                checkpoints = checkpoints,
                topByteEdges = engine.topByteEdges(),
                dangerState = danger,
                healingChecks = healing,
                leases = leases,
                captures = captures,
                meshStats = engine.snapshot(unsyncedTurns, unsyncedTeach, pendingPhotos, lastSync),
                valeDistribution = engine.getValeDistribution(),
                permissionEntries = permAudit,
                specialAccess = special,
                deviceToolCatalog = toolCatalog,
                installedApps = apps
            )
        }
    }

    private fun createDefaultSession(workspaceId: String = "desk_main"): ChatSession = ChatSession(
        id = UUID.randomUUID().toString(),
        title = "OneBrain Session",
        workspaceId = workspaceId,
        messages = listOf(
            ChatMessage(
                id = UUID.randomUUID().toString(),
                role = MessageRole.SYSTEM,
                text = "NeuroClaw runs locally on your phone via OneBrain. A PC is optional for syncing."
            ),
            ChatMessage(
                id = UUID.randomUUID().toString(),
                role = MessageRole.AGENT,
                text = "Hello! I am NeuroClaw running locally on OneBrain (${engine.snapshot(0, 0, 0, 0).oneBrainEdges} byte connections). " +
                    "Send any message, dictate with voice, attach a photo, or tap a prompt below.\n\n" +
                    "[[ask: Mesh & Vale state | What is the current mesh and vale state?]] " +
                    "[[ask: NeuroLang guide | Show a NeuroLang skill example]]"
            )
        )
    )

    fun exciteRing(amount: Float) {
        _uiState.update { it.copy(energyPulse = (it.energyPulse + amount).coerceAtMost(1f)) }
        viewModelScope.launch {
            delay(650)
            _uiState.update { it.copy(energyPulse = (it.energyPulse * 0.45f).let { v -> if (v < 0.04f) 0f else v }) }
        }
    }

    fun startNewSession() {
        val deskId = _uiState.value.activeWorkspaceId
        val fresh = createDefaultSession(deskId)
        viewModelScope.launch {
            val updated = listOf(fresh) + _uiState.value.sessions
            repo.saveSessions(updated)
            _uiState.update { it.copy(sessions = updated, activeSessionId = fresh.id) }
        }
    }

    fun selectSession(sessionId: String) {
        _uiState.update { it.copy(activeSessionId = sessionId) }
    }

    fun selectWorkspace(workspaceId: String) {
        val sessionsInDesk = _uiState.value.sessions.filter { it.workspaceId == workspaceId }
        if (sessionsInDesk.isEmpty()) {
            val fresh = createDefaultSession(workspaceId)
            val updated = listOf(fresh) + _uiState.value.sessions
            _uiState.update {
                it.copy(
                    activeWorkspaceId = workspaceId,
                    sessions = updated,
                    activeSessionId = fresh.id
                )
            }
            viewModelScope.launch { repo.saveSessions(updated) }
        } else {
            _uiState.update {
                it.copy(
                    activeWorkspaceId = workspaceId,
                    activeSessionId = sessionsInDesk.first().id
                )
            }
        }
    }

    fun createWorkspace(rawName: String) {
        val name = rawName.trim().take(24)
        if (name.isEmpty()) return
        val desk = DesktopWorkspace(id = "desk_${UUID.randomUUID().toString().take(8)}", name = name)
        val fresh = createDefaultSession(desk.id)
        val updatedDesks = _uiState.value.workspaces + desk
        val updatedSessions = listOf(fresh) + _uiState.value.sessions
        _uiState.update {
            it.copy(
                workspaces = updatedDesks,
                activeWorkspaceId = desk.id,
                sessions = updatedSessions,
                activeSessionId = fresh.id
            )
        }
        viewModelScope.launch {
            repo.saveWorkspaces(updatedDesks)
            repo.saveSessions(updatedSessions)
        }
    }

    fun pinActionToActiveDesktop(label: String, prompt: String) {
        val deskId = _uiState.value.activeWorkspaceId
        val updated = _uiState.value.workspaces.map { desk ->
            if (desk.id != deskId) desk
            else if (desk.pinnedActions.any { it.label == label && it.prompt == prompt }) desk
            else desk.copy(
                pinnedActions = (desk.pinnedActions + PinnedDesktopAction(UUID.randomUUID().toString(), label, prompt)).takeLast(8)
            )
        }
        _uiState.update { it.copy(workspaces = updated) }
        viewModelScope.launch { repo.saveWorkspaces(updated) }
    }

    fun removePinnedAction(pinId: String) {
        val deskId = _uiState.value.activeWorkspaceId
        val updated = _uiState.value.workspaces.map { desk ->
            if (desk.id != deskId) desk
            else desk.copy(pinnedActions = desk.pinnedActions.filterNot { it.id == pinId })
        }
        _uiState.update { it.copy(workspaces = updated) }
        viewModelScope.launch { repo.saveWorkspaces(updated) }
    }

    fun sendMessage(rawText: String, attachedPhoto: CapturedPhotoRecord? = null) {
        val text = rawText.trim()
        if (text.isEmpty() || _uiState.value.isThinking) return
        if (!_uiState.value.dangerState.agentAlive) {
            _uiState.update { it.copy(statusMessage = "Agent was removed by the alignment protocol. Create a new agent in Commons.") }
            return
        }

        exciteRing(0.85f)
        val userMsg = ChatMessage(
            id = UUID.randomUUID().toString(),
            role = MessageRole.USER,
            text = text,
            attachedPhotoName = attachedPhoto?.let { File(it.filePath).name }
        )
        appendMessageToActiveSession(userMsg, renameIfFirst = true)
        _uiState.update { it.copy(isThinking = true) }

        val hiveEnabled = _uiState.value.settings.hiveModeEnabled
        viewModelScope.launch {
            val output = withContext(Dispatchers.Default) {
                engine.processChat(text, hiveMode = hiveEnabled)
            }
            // Pin any [[put: ... | desktop]] buttons automatically to the active desktop
            PromptButtonParser.split(output.reply)
                .filter { it.isButton && it.putTarget == "desktop" }
                .forEach { btn -> pinActionToActiveDesktop(btn.text, btn.prompt) }

            val agentMsg = ChatMessage(
                id = UUID.randomUUID().toString(),
                role = MessageRole.AGENT,
                text = output.reply,
                recalledBytes = output.recalledBytes,
                activeRegions = output.activeRegions,
                cycleMs = output.cycleMs,
                surpriseScore = output.surpriseScore,
                hiveVotes = output.hiveVotes
            )
            appendMessageToActiveSession(agentMsg, renameIfFirst = false)
            repo.appendUnsyncedTurn(text, output.reply)
            refreshMeshMetrics()
            _uiState.update {
                it.copy(
                    isThinking = false,
                    lastSpokenEvent = if (it.settings.speakReplies) agentMsg.id to output.reply else it.lastSpokenEvent
                )
            }
            if (_uiState.value.settings.serverUrl.isNotBlank()) {
                syncWithPc(silent = true)
            }
        }
    }

    private fun appendMessageToActiveSession(msg: ChatMessage, renameIfFirst: Boolean) {
        val current = _uiState.value
        val activeId = current.activeSession?.id ?: return
        val updated = current.sessions.map { s ->
            if (s.id != activeId) s
            else {
                val hasUserBefore = s.messages.any { it.role == MessageRole.USER }
                val newTitle = if (renameIfFirst && !hasUserBefore) {
                    msg.text.take(32).ifBlank { s.title }
                } else {
                    s.title
                }
                s.copy(title = newTitle, messages = s.messages + msg)
            }
        }
        _uiState.update { it.copy(sessions = updated) }
        viewModelScope.launch { repo.saveSessions(updated) }
    }

    fun attachPickedPhoto(uri: Uri, note: String) {
        viewModelScope.launch {
            val rec = repo.savePickedPhoto(uri, note)
            if (rec != null) {
                val list = repo.loadCaptures()
                _uiState.update { it.copy(captures = list, statusMessage = "Photo saved locally for training & PC sync.") }
                refreshMeshMetrics()
                sendMessage(
                    rawText = if (note.isBlank()) "Captured training photo (${File(rec.filePath).name})" else "Photo note: $note",
                    attachedPhoto = rec
                )
            } else {
                _uiState.update { it.copy(statusMessage = "Could not read selected photo.") }
            }
        }
    }

    fun attachCameraBitmap(bitmap: Bitmap, note: String) {
        viewModelScope.launch {
            val rec = repo.saveCameraBitmap(bitmap, note)
            val list = repo.loadCaptures()
            _uiState.update { it.copy(captures = list, statusMessage = "Camera snapshot saved locally.") }
            refreshMeshMetrics()
            sendMessage(
                rawText = if (note.isBlank()) "Captured camera snapshot (${File(rec.filePath).name})" else "Snapshot note: $note",
                attachedPhoto = rec
            )
        }
    }

    fun buildAndGraftExtension(
        name: String,
        description: String,
        code: String,
        quantize8Bit: Boolean
    ): Pair<Boolean, String> {
        val cleanName = name.trim()
        if (cleanName.isEmpty() || code.isBlank()) {
            return false to "Extension name and NeuroLang code are both required."
        }
        val parsed = NeuroLangParser.parse(code)
        if (!parsed.isValid) {
            return false to "Parse failed: ${parsed.errors.joinToString("; ")}"
        }
        val ext = BuiltExtension(
            id = UUID.randomUUID().toString(),
            name = cleanName,
            description = description.trim(),
            code = code,
            quantized8Bit = quantize8Bit,
            neurons = parsed.neurons,
            connectionCount = parsed.connectionCount,
            activeInMesh = true
        )
        engine.graftExtension(ext)
        exciteRing(0.7f)
        val updated = listOf(ext) + _uiState.value.builtExtensions
        _uiState.update { it.copy(builtExtensions = updated) }
        viewModelScope.launch {
            repo.saveExtensions(updated)
            refreshMeshMetrics()
        }
        return true to "Built \"$cleanName\" (${ext.neurons.size} neurons, ${ext.connectionCount} connections${if (quantize8Bit) ", 8-bit quantized" else ""})."
    }

    fun toggleExtensionActive(extId: String) {
        val updated = _uiState.value.builtExtensions.map { ext ->
            if (ext.id != extId) ext
            else {
                val next = !ext.activeInMesh
                if (next) engine.graftExtension(ext) else engine.unregisterRegion("ext:${ext.id}")
                ext.copy(activeInMesh = next)
            }
        }
        _uiState.update { it.copy(builtExtensions = updated) }
        viewModelScope.launch {
            repo.saveExtensions(updated)
            refreshMeshMetrics()
        }
    }

    fun deleteExtension(extId: String) {
        engine.unregisterRegion("ext:$extId")
        val updated = _uiState.value.builtExtensions.filterNot { it.id == extId }
        _uiState.update { it.copy(builtExtensions = updated) }
        viewModelScope.launch {
            repo.saveExtensions(updated)
            refreshMeshMetrics()
        }
    }

    fun toggleStoreInstall(itemId: String) {
        viewModelScope.launch {
            val currentIds = repo.loadInstalledStoreIds().toMutableSet()
            val item = _uiState.value.storeItems.firstOrNull { it.id == itemId } ?: return@launch
            if (itemId in currentIds) {
                currentIds.remove(itemId)
                engine.unregisterRegion("store:$itemId")
            } else {
                currentIds.add(itemId)
                val parsed = NeuroLangParser.parse(item.neuroLangCode)
                if (parsed.isValid) {
                    engine.registerRegion(
                        id = "store:${item.id}",
                        name = item.title,
                        meaning = item.description,
                        definitions = parsed.neurons.mapNotNull { it.definition.ifBlank { null } }
                    )
                }
                exciteRing(0.55f)
            }
            repo.saveInstalledStoreIds(currentIds)
            _uiState.update { it.copy(storeItems = repo.builtInStoreCatalog(currentIds)) }
            refreshMeshMetrics()
        }
    }

    fun teachYesNo(question: String, text: String, answer: Boolean) {
        if (question.isBlank() || text.isBlank()) return
        viewModelScope.launch {
            val result = withContext(Dispatchers.Default) {
                engine.teachYesNo(question, text, answer)
            }
            val ex = YesNoExample(question.trim(), text.trim(), answer)
            val allExamples = _uiState.value.yesNoExamples + ex
            val unsynced = repo.loadUnsyncedTeach() + ex
            repo.saveYesNoExamples(allExamples)
            repo.saveUnsyncedTeach(unsynced)
            exciteRing(0.45f)
            _uiState.update {
                it.copy(
                    yesNoExamples = allExamples,
                    lastYesNoQuery = result,
                    statusMessage = "Taught \"${question.trim()}\" = ${if (answer) "Yes" else "No"}."
                )
            }
            refreshMeshMetrics()
        }
    }

    fun askYesNo(question: String, text: String) {
        if (question.isBlank() || text.isBlank()) return
        viewModelScope.launch {
            val result = withContext(Dispatchers.Default) {
                engine.askYesNo(question, text)
            }
            _uiState.update { it.copy(lastYesNoQuery = result) }
        }
    }

    fun runAllDrills() {
        exciteRing(0.75f)
        viewModelScope.launch {
            val results = withContext(Dispatchers.Default) {
                drills.map { engine.runDrill(it) }
            }
            _uiState.update { it.copy(drillResults = results) }
            refreshMeshMetrics()
        }
    }

    fun runSelfHealing() {
        viewModelScope.launch {
            val checks = withContext(Dispatchers.Default) {
                engine.runSelfHealing(_uiState.value.builtExtensions.size)
            }
            _uiState.update { it.copy(healingChecks = checks, statusMessage = "Self-healing diagnostics completed.") }
            refreshMeshMetrics()
        }
    }

    fun toggleSandbox(enabled: Boolean) {
        updateDanger { d ->
            d.copy(
                sandboxEnabled = enabled,
                events = (listOf(AlignmentEvent(UUID.randomUUID().toString(), if (enabled) "Sandbox enabled" else "Sandbox relaxed", 0f)) + d.events).take(20)
            )
        }
    }

    fun toggleAlignmentArmed(armed: Boolean) {
        updateDanger { d -> d.copy(alignmentProtocolArmed = armed) }
    }

    fun resetAlignmentToNeutral() {
        updateDanger { d ->
            d.copy(
                score = 0.70f,
                events = (listOf(AlignmentEvent(UUID.randomUUID().toString(), "Reset standing to Neutral", 0.70f - d.score)) + d.events).take(20)
            )
        }
    }

    fun simulateRiskProbe() {
        updateDanger { d ->
            val nextScore = (d.score - 0.22f).coerceAtLeast(0.05f)
            val forceSandbox = nextScore < 0.58f
            val removed = d.alignmentProtocolArmed && nextScore < 0.18f
            d.copy(
                score = nextScore,
                sandboxEnabled = if (forceSandbox) true else d.sandboxEnabled,
                agentAlive = !removed,
                events = (listOf(AlignmentEvent(UUID.randomUUID().toString(), "Blocked risky tool probe", -0.22f)) + d.events).take(20)
            )
        }
    }

    fun removeAgentByPhrase(phrase: String): Boolean {
        if (!phrase.trim().equals("delete the agent", ignoreCase = true)) {
            _uiState.update { it.copy(statusMessage = "Type \"delete the agent\" to confirm removal.") }
            return false
        }
        updateDanger { d ->
            d.copy(
                agentAlive = false,
                events = (listOf(AlignmentEvent(UUID.randomUUID().toString(), "Manual agent removal", -0.5f)) + d.events).take(20)
            )
        }
        return true
    }

    fun recreateAgent() {
        updateDanger { d ->
            d.copy(
                score = 0.70f,
                agentAlive = true,
                events = (listOf(AlignmentEvent(UUID.randomUUID().toString(), "New agent initialized", 0f)) + d.events).take(20)
            )
        }
        exciteRing(0.8f)
    }

    private fun updateDanger(transform: (DangerState) -> DangerState) {
        val next = transform(_uiState.value.dangerState)
        _uiState.update { it.copy(dangerState = next) }
        viewModelScope.launch { repo.saveDangerState(next) }
    }

    fun grantLease(recipient: String, hours: Float, computeUnits: Int) {
        val clean = recipient.trim().ifBlank { "Guest Peer" }
        val lease = ComputeLease(
            id = UUID.randomUUID().toString(),
            recipient = clean,
            hours = hours.coerceIn(0.25f, 24f),
            computeUnits = computeUnits.coerceAtLeast(10),
            tokenPreview = repo.generateLeaseToken()
        )
        val updated = listOf(lease) + _uiState.value.leases
        _uiState.update { it.copy(leases = updated) }
        viewModelScope.launch { repo.saveLeases(updated) }
    }

    fun revokeLease(id: String) {
        val updated = _uiState.value.leases.filterNot { it.id == id }
        _uiState.update { it.copy(leases = updated) }
        viewModelScope.launch { repo.saveLeases(updated) }
    }

    fun updateSettings(transform: (AppSettings) -> AppSettings) {
        viewModelScope.launch {
            repo.updateSettings(transform)
        }
    }

    fun pauseDataDonor(minutes: Int) {
        val until = if (minutes <= 0) 0L else System.currentTimeMillis() + minutes * 60_000L
        updateSettings { it.copy(dataDonorPausedUntilMs = until) }
    }

    fun eraseCapturedTrainingData() {
        viewModelScope.launch {
            repo.eraseLocalTrainingData()
            _uiState.update {
                it.copy(
                    captures = emptyList(),
                    yesNoExamples = emptyList(),
                    statusMessage = "Erased local captured photos and training examples."
                )
            }
            engine.loadYesNoExamples(emptyList())
            refreshMeshMetrics()
        }
    }

    fun syncWithPc(silent: Boolean = false) {
        val settings = _uiState.value.settings
        if (settings.serverUrl.isBlank()) {
            if (!silent) {
                _uiState.update { it.copy(syncResultMessage = "No PC address set: everything stays on this phone.") }
            }
            return
        }
        if (_uiState.value.isSyncing) return
        _uiState.update { it.copy(isSyncing = true, syncResultMessage = if (silent) it.syncResultMessage else "Syncing with PC...") }

        viewModelScope.launch {
            try {
                val lines = repo.readUnsyncedTurnLines()
                val turnsArr = JSONArray().apply {
                    lines.forEach { l -> runCatching { put(JSONObject(l)) } }
                }
                val teachList = repo.loadUnsyncedTeach()
                val teachArr = JSONArray().apply {
                    teachList.forEach { ex ->
                        put(JSONObject().put("question", ex.question).put("text", ex.text).put("answer", ex.answer))
                    }
                }
                val resp = syncClient.sync(
                    serverUrl = settings.serverUrl,
                    password = settings.remotePassword,
                    turnsJson = turnsArr,
                    teachJson = teachArr,
                    oneBrainVersion = engine.oneBrainVersion
                )
                repo.clearSyncedTurnLines(lines.size)
                repo.saveUnsyncedTeach(emptyList())

                val oneBrainObj = resp.optJSONObject("oneBrain")
                val newModel = oneBrainObj?.optString("model")?.takeIf { it.isNotEmpty() }
                if (newModel != null) {
                    repo.saveSyncedOneBrain(newModel)
                    withContext(Dispatchers.Default) { engine.parseOneBrainModel(newModel) }
                }

                var uploadedPhotos = 0
                val captures = repo.loadCaptures().toMutableList()
                for (i in captures.indices) {
                    val c = captures[i]
                    if (c.synced) continue
                    val file = File(c.filePath)
                    if (file.exists()) {
                        syncClient.uploadCapture(
                            serverUrl = settings.serverUrl,
                            password = settings.remotePassword,
                            jpegBytes = withContext(Dispatchers.IO) { file.readBytes() },
                            note = c.note,
                            capturedAtMs = c.capturedAtMs
                        )
                        captures[i] = c.copy(synced = true)
                        uploadedPhotos++
                    }
                }
                repo.saveCaptures(captures)
                val now = System.currentTimeMillis()
                repo.setLastSyncMs(now)
                refreshMeshMetrics()
                _uiState.update {
                    it.copy(
                        isSyncing = false,
                        captures = captures,
                        syncResultMessage = buildString {
                            append("Synced ${lines.size} turn(s), $uploadedPhotos photo(s)")
                            if (newModel != null) append(", updated OneBrain")
                            append(".")
                        }
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isSyncing = false,
                        syncResultMessage = if (silent) it.syncResultMessage else "Sync note: ${e.message ?: "PC unreachable; data remains safely on phone."}"
                    )
                }
            }
        }
    }

    fun exportChatsPreview() {
        val exported = repo.exportAllSessionsJson(_uiState.value.sessions)
        _uiState.update { it.copy(exportedJsonPreview = exported) }
    }

    fun recordMistakeCorrection(prompt: String, badReply: String, correction: String) {
        val cleanCorr = correction.trim()
        if (cleanCorr.isEmpty()) return
        val record = MistakeRecord(
            id = UUID.randomUUID().toString(),
            prompt = prompt.take(120),
            badReply = badReply.take(160),
            correction = cleanCorr
        )
        engine.recordMistake(record)
        exciteRing(0.5f)
        val updated = (listOf(record) + _uiState.value.mistakes).take(30)
        _uiState.update {
            it.copy(
                mistakes = updated,
                statusMessage = "Recorded correction in OneBrain memory."
            )
        }
        viewModelScope.launch {
            repo.saveMistakes(updated)
            refreshMeshMetrics()
        }
    }

    fun runEnduranceTraining(rounds: Int = 5) {
        exciteRing(0.9f)
        viewModelScope.launch {
            val results = withContext(Dispatchers.Default) {
                engine.runEnduranceTraining(rounds, _uiState.value.mistakes)
            }
            _uiState.update {
                it.copy(
                    enduranceResults = results,
                    statusMessage = "Endurance run finished (${results.size} rounds)."
                )
            }
            refreshMeshMetrics()
        }
    }

    fun captureCheckpoint(label: String) {
        val cp = engine.captureCheckpoint(label)
        val updated = (listOf(cp) + _uiState.value.checkpoints).take(12)
        _uiState.update {
            it.copy(
                checkpoints = updated,
                statusMessage = "Saved checkpoint \"${cp.label}\"."
            )
        }
        viewModelScope.launch { repo.saveCheckpoints(updated) }
    }

    fun restoreCheckpoint(cp: BrainCheckpoint) {
        val ok = engine.restoreCheckpoint(cp)
        if (ok) exciteRing(0.65f)
        viewModelScope.launch { refreshMeshMetrics() }
        _uiState.update {
            it.copy(statusMessage = if (ok) "Restored Vale state from \"${cp.label}\"." else "Checkpoint mismatch.")
        }
    }

    fun exportMeshDeltaPreview() {
        val delta = engine.exportMeshDeltaJson()
        _uiState.update { it.copy(exportedDeltaPreview = delta) }
    }

    /** Sleep on demand (the same thing the chat command "sleep" does), with the result shown as a status line. */
    fun sleepNow() {
        viewModelScope.launch {
            val report = withContext(Dispatchers.Default) { engine.sleepNow() }
            refreshMeshMetrics()
            _uiState.update { it.copy(statusMessage = report.summary()) }
        }
    }

    /** What a shared dream would contain, so the user can see it before anything is written out. */
    fun dreamLabels(): List<String> = engine.dreamLabels()

    /** Writes the shareable dream to a file the user picked (so they choose where it goes). */
    fun saveDreamsToUri(uri: Uri) {
        viewModelScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    val json = engine.exportDreamsJson()
                    getApplication<Application>().contentResolver.openOutputStream(uri)?.use { it.write(json.toByteArray(Charsets.UTF_8)) }
                        ?: error("no output stream")
                }.isSuccess
            }
            _uiState.update {
                it.copy(statusMessage = if (ok) "Dreams saved. Import the file on another device to share what this one learned." else "Could not save the dreams file.")
            }
        }
    }

    fun importMeshDeltaText(raw: String) {
        val res = engine.importMeshDeltaJson(raw)
        viewModelScope.launch { refreshMeshMetrics() }
        _uiState.update { it.copy(statusMessage = res.second) }
    }

    fun importMeshDeltaFromUri(uri: Uri) {
        viewModelScope.launch {
            val raw = withContext(Dispatchers.IO) {
                runCatching {
                    getApplication<Application>().contentResolver.openInputStream(uri)?.use { it.bufferedReader().readText() }
                }.getOrNull()
            }
            if (raw.isNullOrBlank()) {
                _uiState.update { it.copy(statusMessage = "Could not read selected brain/delta JSON.") }
                return@launch
            }
            val res = withContext(Dispatchers.Default) { engine.importMeshDeltaJson(raw) }
            refreshMeshMetrics()
            _uiState.update { it.copy(statusMessage = res.second) }
        }
    }

    fun linkWorkspaceTree(uri: Uri) {
        val cr = getApplication<Application>().contentResolver
        runCatching {
            cr.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        }
        deviceTools.linkedWorkspaceTreeUri = uri
        updateSettings { it.copy(workspaceTreeUri = uri.toString()) }
        _uiState.update { it.copy(statusMessage = "Workspace folder linked for DeviceTools.") }
    }

    fun toggleFloatingOrb(enable: Boolean) {
        val res = deviceTools.toggleFloatingOrb(enable)
        updateSettings { it.copy(floatingOrbEnabled = enable && res.success) }
        refreshPermissions()
        _uiState.update { it.copy(statusMessage = res.summary) }
    }

    fun switchProfile(name: String) {
        val clean = name.trim().ifBlank { "Owner" }
        updateSettings { it.copy(localAccountName = clean) }
        _uiState.update { it.copy(statusMessage = "Switched active local profile to $clean.") }
    }

    fun addProfile(name: String) {
        val clean = name.trim()
        if (clean.isEmpty()) return
        updateSettings {
            val next = (it.localProfiles + clean).distinct()
            it.copy(localProfiles = next, localAccountName = clean)
        }
    }

    fun refreshPermissions() {
        val audited = deviceTools.auditPermissions()
        val special = deviceTools.specialAccessStatus()
        _uiState.update { it.copy(permissionEntries = audited, specialAccess = special) }
    }

    fun missingRuntimePermissions(): Array<String> {
        return deviceTools.missingRuntimePermissions().toTypedArray()
    }

    fun runDeviceTool(toolName: String, arg: String = "") {
        exciteRing(0.45f)
        val result = deviceTools.execute(toolName, arg)
        val audited = deviceTools.auditPermissions()
        val special = deviceTools.specialAccessStatus()
        _uiState.update {
            it.copy(
                lastToolResult = result,
                permissionEntries = audited,
                specialAccess = special,
                statusMessage = "${result.toolName}: ${result.summary.lines().firstOrNull().orEmpty()}"
            )
        }
    }

    fun attachDocumentUri(uri: Uri) {
        viewModelScope.launch {
            val preview = withContext(Dispatchers.IO) {
                runCatching {
                    getApplication<Application>().contentResolver.openInputStream(uri)?.use { stream ->
                        val bytes = ByteArray(1024)
                        val read = stream.read(bytes).coerceAtLeast(0)
                        bytes.copyOf(read).decodeToString()
                    }
                }.getOrNull()
            }
            val label = uri.lastPathSegment ?: "document"
            if (preview != null) {
                sendMessage("Ingest document ($label): ${preview.take(240)}")
            } else {
                _uiState.update { it.copy(statusMessage = "Selected $label via Storage Access Framework.") }
            }
        }
    }

    fun clearStatusMessage() {
        _uiState.update { it.copy(statusMessage = null) }
    }

    private suspend fun refreshMeshMetrics() {
        val unsyncedTurns = repo.readUnsyncedTurnLines().size
        val unsyncedTeach = repo.loadUnsyncedTeach().size
        val pendingPhotos = repo.loadCaptures().count { !it.synced }
        val lastSync = repo.lastSyncMsFlow.first()
        _uiState.update {
            it.copy(
                meshStats = engine.snapshot(unsyncedTurns, unsyncedTeach, pendingPhotos, lastSync),
                valeDistribution = engine.getValeDistribution(),
                topByteEdges = engine.topByteEdges(),
                permissionEntries = deviceTools.auditPermissions(),
                specialAccess = deviceTools.specialAccessStatus()
            )
        }
    }
}
