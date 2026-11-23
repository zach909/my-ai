package com.example.engine

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.example.model.AppSettings
import com.example.model.BrainCheckpoint
import com.example.model.BuiltExtension
import com.example.model.CapturedPhotoRecord
import com.example.model.ChatSession
import com.example.model.ComputeLease
import com.example.model.DangerState
import com.example.model.DesktopWorkspace
import com.example.model.MistakeRecord
import com.example.model.PinnedDesktopAction
import com.example.model.StoreCatalogItem
import com.example.model.WikiArticle
import com.example.model.YesNoExample
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.SecureRandom

private val Context.neuroDataStore by preferencesDataStore(name = "neuroclaw_prefs")

class NeuroRepository(private val context: Context) {
    private val json = Json {
        ignoreUnknownKeys = true
        prettyPrint = false
        encodeDefaults = true
    }

    private object Keys {
        val SERVER_URL = stringPreferencesKey("server_url")
        val REMOTE_PASSWORD = stringPreferencesKey("remote_password")
        val OPEN_CHAT_ON_LAUNCH = booleanPreferencesKey("open_chat_on_launch")
        val AMBIENT_RING_ENABLED = booleanPreferencesKey("ambient_ring_enabled")
        val REDUCED_MOTION = booleanPreferencesKey("reduced_motion")
        val SPEAK_REPLIES = booleanPreferencesKey("speak_replies")
        val HIVE_MODE = booleanPreferencesKey("hive_mode")
        val FLOATING_ORB = booleanPreferencesKey("floating_orb")
        val WORKSPACE_TREE_URI = stringPreferencesKey("workspace_tree_uri")
        val DATA_DONOR = booleanPreferencesKey("data_donor")
        val DATA_DONOR_PAUSED_UNTIL = longPreferencesKey("data_donor_paused_until")
        val LENDING_ENABLED = booleanPreferencesKey("lending_enabled")
        val LOCAL_ACCOUNT_NAME = stringPreferencesKey("local_account_name")
        val LOCAL_PROFILES_JSON = stringPreferencesKey("local_profiles_json")
        val LAST_SYNC_MS = longPreferencesKey("last_sync_ms")
        val THEME_MODE = stringPreferencesKey("theme_mode")
        val DYNAMIC_COLOR = booleanPreferencesKey("dynamic_color")
    }

    private val sessionsFile get() = File(context.filesDir, "chat_sessions.json")
    private val workspacesFile get() = File(context.filesDir, "desktop_workspaces.json")
    private val extensionsFile get() = File(context.filesDir, "built_extensions.json")
    private val yesNoFile get() = File(context.filesDir, "yes_no_examples.json")
    private val mistakesFile get() = File(context.filesDir, "mistakes.json")
    private val checkpointsFile get() = File(context.filesDir, "brain_checkpoints.json")
    private val unsyncedTurnsFile get() = File(context.filesDir, "unsynced_turns.jsonl")
    private val unsyncedTeachFile get() = File(context.filesDir, "unsynced_teach.json")
    private val capturesMetaFile get() = File(context.filesDir, "captured_photos.json")
    private val dangerFile get() = File(context.filesDir, "danger_state.json")
    private val leasesFile get() = File(context.filesDir, "compute_leases.json")
    private val installedStoreIdsFile get() = File(context.filesDir, "installed_store_ids.json")
    private val syncedOneBrainFile get() = File(context.filesDir, "onebrain_from_pc.json")
    private val capturesDir get() = File(context.filesDir, "captures").apply { mkdirs() }

    val settingsFlow: Flow<AppSettings> = context.neuroDataStore.data.map { prefs ->
        val profiles = prefs[Keys.LOCAL_PROFILES_JSON]?.let { raw ->
            runCatching { json.decodeFromString<List<String>>(raw) }.getOrNull()
        } ?: listOf("Owner", "Researcher", "Developer")
        AppSettings(
            serverUrl = prefs[Keys.SERVER_URL] ?: "",
            remotePassword = prefs[Keys.REMOTE_PASSWORD] ?: "",
            openChatOnLaunch = prefs[Keys.OPEN_CHAT_ON_LAUNCH] ?: true,
            ambientRingEnabled = prefs[Keys.AMBIENT_RING_ENABLED] ?: true,
            reducedMotion = prefs[Keys.REDUCED_MOTION] ?: false,
            speakReplies = prefs[Keys.SPEAK_REPLIES] ?: false,
            hiveModeEnabled = prefs[Keys.HIVE_MODE] ?: false,
            floatingOrbEnabled = prefs[Keys.FLOATING_ORB] ?: false,
            workspaceTreeUri = prefs[Keys.WORKSPACE_TREE_URI] ?: "",
            dataDonorEnabled = prefs[Keys.DATA_DONOR] ?: false,
            dataDonorPausedUntilMs = prefs[Keys.DATA_DONOR_PAUSED_UNTIL] ?: 0L,
            lendingEnabled = prefs[Keys.LENDING_ENABLED] ?: false,
            localAccountName = prefs[Keys.LOCAL_ACCOUNT_NAME] ?: "Owner",
            localProfiles = profiles,
            themeMode = prefs[Keys.THEME_MODE] ?: "SYSTEM",
            dynamicColorEnabled = prefs[Keys.DYNAMIC_COLOR] ?: true
        )
    }

    val lastSyncMsFlow: Flow<Long> = context.neuroDataStore.data.map { it[Keys.LAST_SYNC_MS] ?: 0L }

    suspend fun updateSettings(transform: (AppSettings) -> AppSettings) {
        val current = settingsFlow.first()
        val updated = transform(current)
        context.neuroDataStore.edit { prefs ->
            prefs[Keys.SERVER_URL] = normalizeServerUrl(updated.serverUrl)
            prefs[Keys.REMOTE_PASSWORD] = updated.remotePassword
            prefs[Keys.OPEN_CHAT_ON_LAUNCH] = updated.openChatOnLaunch
            prefs[Keys.AMBIENT_RING_ENABLED] = updated.ambientRingEnabled
            prefs[Keys.REDUCED_MOTION] = updated.reducedMotion
            prefs[Keys.SPEAK_REPLIES] = updated.speakReplies
            prefs[Keys.HIVE_MODE] = updated.hiveModeEnabled
            prefs[Keys.FLOATING_ORB] = updated.floatingOrbEnabled
            prefs[Keys.WORKSPACE_TREE_URI] = updated.workspaceTreeUri
            prefs[Keys.DATA_DONOR] = updated.dataDonorEnabled
            prefs[Keys.DATA_DONOR_PAUSED_UNTIL] = updated.dataDonorPausedUntilMs
            prefs[Keys.LENDING_ENABLED] = updated.lendingEnabled
            prefs[Keys.LOCAL_ACCOUNT_NAME] = updated.localAccountName.ifBlank { "Owner" }
            prefs[Keys.LOCAL_PROFILES_JSON] = json.encodeToString(updated.localProfiles.ifEmpty { listOf("Owner") })
            prefs[Keys.THEME_MODE] = updated.themeMode.ifBlank { "SYSTEM" }
            prefs[Keys.DYNAMIC_COLOR] = updated.dynamicColorEnabled
        }
    }

    suspend fun setLastSyncMs(ms: Long) {
        context.neuroDataStore.edit { it[Keys.LAST_SYNC_MS] = ms }
    }

    suspend fun loadSyncedOneBrainIfPresent(): String? = withContext(Dispatchers.IO) {
        if (syncedOneBrainFile.exists()) runCatching { syncedOneBrainFile.readText() }.getOrNull() else null
    }

    suspend fun saveSyncedOneBrain(modelJson: String) = withContext(Dispatchers.IO) {
        syncedOneBrainFile.writeText(modelJson)
    }

    suspend fun loadSessions(): List<ChatSession> = withContext(Dispatchers.IO) {
        if (!sessionsFile.exists()) return@withContext emptyList()
        runCatching { json.decodeFromString<List<ChatSession>>(sessionsFile.readText()) }.getOrDefault(emptyList())
    }

    suspend fun saveSessions(sessions: List<ChatSession>) = withContext(Dispatchers.IO) {
        sessionsFile.writeText(json.encodeToString(sessions))
    }

    suspend fun appendUnsyncedTurn(message: String, reply: String) = withContext(Dispatchers.IO) {
        val line = JSONObject()
            .put("message", message)
            .put("reply", reply)
            .put("at", System.currentTimeMillis())
            .toString() + "\n"
        unsyncedTurnsFile.appendText(line)
    }

    suspend fun readUnsyncedTurnLines(): List<String> = withContext(Dispatchers.IO) {
        if (!unsyncedTurnsFile.exists()) emptyList()
        else unsyncedTurnsFile.readLines().filter { it.isNotBlank() }
    }

    suspend fun clearSyncedTurnLines(countSent: Int) = withContext(Dispatchers.IO) {
        if (!unsyncedTurnsFile.exists() || countSent <= 0) return@withContext
        val now = unsyncedTurnsFile.readLines().filter { it.isNotBlank() }
        val remaining = now.drop(countSent)
        if (remaining.isEmpty()) unsyncedTurnsFile.delete()
        else unsyncedTurnsFile.writeText(remaining.joinToString("\n", postfix = "\n"))
    }

    suspend fun loadExtensions(): List<BuiltExtension> = withContext(Dispatchers.IO) {
        if (!extensionsFile.exists()) return@withContext emptyList()
        runCatching { json.decodeFromString<List<BuiltExtension>>(extensionsFile.readText()) }.getOrDefault(emptyList())
    }

    suspend fun saveExtensions(list: List<BuiltExtension>) = withContext(Dispatchers.IO) {
        extensionsFile.writeText(json.encodeToString(list))
    }

    suspend fun loadYesNoExamples(): List<YesNoExample> = withContext(Dispatchers.IO) {
        if (!yesNoFile.exists()) return@withContext emptyList()
        runCatching { json.decodeFromString<List<YesNoExample>>(yesNoFile.readText()) }.getOrDefault(emptyList())
    }

    suspend fun saveYesNoExamples(list: List<YesNoExample>) = withContext(Dispatchers.IO) {
        yesNoFile.writeText(json.encodeToString(list))
    }

    suspend fun loadUnsyncedTeach(): List<YesNoExample> = withContext(Dispatchers.IO) {
        if (!unsyncedTeachFile.exists()) return@withContext emptyList()
        runCatching { json.decodeFromString<List<YesNoExample>>(unsyncedTeachFile.readText()) }.getOrDefault(emptyList())
    }

    suspend fun saveUnsyncedTeach(list: List<YesNoExample>) = withContext(Dispatchers.IO) {
        unsyncedTeachFile.writeText(json.encodeToString(list))
    }

    suspend fun loadDangerState(): DangerState = withContext(Dispatchers.IO) {
        if (!dangerFile.exists()) return@withContext DangerState()
        runCatching { json.decodeFromString<DangerState>(dangerFile.readText()) }.getOrDefault(DangerState())
    }

    suspend fun saveDangerState(state: DangerState) = withContext(Dispatchers.IO) {
        dangerFile.writeText(json.encodeToString(state))
    }

    suspend fun loadLeases(): List<ComputeLease> = withContext(Dispatchers.IO) {
        if (!leasesFile.exists()) return@withContext emptyList()
        runCatching { json.decodeFromString<List<ComputeLease>>(leasesFile.readText()) }.getOrDefault(emptyList())
    }

    suspend fun saveLeases(leases: List<ComputeLease>) = withContext(Dispatchers.IO) {
        leasesFile.writeText(json.encodeToString(leases))
    }

    suspend fun loadInstalledStoreIds(): Set<String> = withContext(Dispatchers.IO) {
        if (!installedStoreIdsFile.exists()) return@withContext emptySet()
        runCatching { json.decodeFromString<Set<String>>(installedStoreIdsFile.readText()) }.getOrDefault(emptySet())
    }

    suspend fun saveInstalledStoreIds(ids: Set<String>) = withContext(Dispatchers.IO) {
        installedStoreIdsFile.writeText(json.encodeToString(ids))
    }

    suspend fun loadWorkspaces(): List<DesktopWorkspace> = withContext(Dispatchers.IO) {
        val defaults = listOf(
            DesktopWorkspace(
                id = "desk_main",
                name = "Main Desk",
                pinnedActions = listOf(
                    PinnedDesktopAction("pin_audit", "Audit Perms", "tool: permission_audit"),
                    PinnedDesktopAction("pin_mesh", "Mesh Stats", "What is the current mesh and vale state?")
                )
            ),
            DesktopWorkspace(id = "desk_research", name = "Research"),
            DesktopWorkspace(
                id = "desk_ops",
                name = "Device Ops",
                pinnedActions = listOf(
                    PinnedDesktopAction("pin_apps", "Apps", "tool: list_installed_apps"),
                    PinnedDesktopAction("pin_notifs", "Alerts", "tool: list_notifications")
                )
            )
        )
        if (!workspacesFile.exists()) return@withContext defaults
        runCatching { json.decodeFromString<List<DesktopWorkspace>>(workspacesFile.readText()) }
            .getOrDefault(defaults)
            .ifEmpty { defaults }
    }

    suspend fun saveWorkspaces(list: List<DesktopWorkspace>) = withContext(Dispatchers.IO) {
        workspacesFile.writeText(json.encodeToString(list))
    }

    suspend fun loadMistakes(): List<MistakeRecord> = withContext(Dispatchers.IO) {
        if (!mistakesFile.exists()) return@withContext emptyList()
        runCatching { json.decodeFromString<List<MistakeRecord>>(mistakesFile.readText()) }.getOrDefault(emptyList())
    }

    suspend fun saveMistakes(list: List<MistakeRecord>) = withContext(Dispatchers.IO) {
        mistakesFile.writeText(json.encodeToString(list))
    }

    suspend fun loadCheckpoints(): List<BrainCheckpoint> = withContext(Dispatchers.IO) {
        if (!checkpointsFile.exists()) return@withContext emptyList()
        runCatching { json.decodeFromString<List<BrainCheckpoint>>(checkpointsFile.readText()) }.getOrDefault(emptyList())
    }

    suspend fun saveCheckpoints(list: List<BrainCheckpoint>) = withContext(Dispatchers.IO) {
        checkpointsFile.writeText(json.encodeToString(list))
    }

    suspend fun loadCaptures(): List<CapturedPhotoRecord> = withContext(Dispatchers.IO) {
        if (!capturesMetaFile.exists()) return@withContext emptyList()
        runCatching { json.decodeFromString<List<CapturedPhotoRecord>>(capturesMetaFile.readText()) }.getOrDefault(emptyList())
    }

    suspend fun saveCaptures(list: List<CapturedPhotoRecord>) = withContext(Dispatchers.IO) {
        capturesMetaFile.writeText(json.encodeToString(list))
    }

    suspend fun savePickedPhoto(uri: Uri, note: String): CapturedPhotoRecord? = withContext(Dispatchers.IO) {
        val ts = System.currentTimeMillis()
        val dest = File(capturesDir, "capture_$ts.jpg")
        val copied = runCatching {
            context.contentResolver.openInputStream(uri)?.use { input ->
                FileOutputStream(dest).use { out -> input.copyTo(out) }
                true
            } ?: false
        }.getOrDefault(false)
        if (!copied) return@withContext null
        val rec = CapturedPhotoRecord(
            id = "cap_$ts",
            filePath = dest.absolutePath,
            note = note.trim(),
            capturedAtMs = ts,
            synced = false
        )
        val current = loadCaptures()
        saveCaptures(current + rec)
        rec
    }

    suspend fun saveCameraBitmap(bitmap: Bitmap, note: String): CapturedPhotoRecord = withContext(Dispatchers.IO) {
        val ts = System.currentTimeMillis()
        val dest = File(capturesDir, "capture_$ts.jpg")
        FileOutputStream(dest).use { out -> bitmap.compress(Bitmap.CompressFormat.JPEG, 88, out) }
        val rec = CapturedPhotoRecord(
            id = "cap_$ts",
            filePath = dest.absolutePath,
            note = note.trim(),
            capturedAtMs = ts,
            synced = false
        )
        val current = loadCaptures()
        saveCaptures(current + rec)
        rec
    }

    suspend fun eraseAllCaptures() = withContext(Dispatchers.IO) {
        capturesDir.listFiles()?.forEach { it.delete() }
        if (capturesMetaFile.exists()) capturesMetaFile.delete()
    }

    suspend fun eraseLocalTrainingData() = withContext(Dispatchers.IO) {
        eraseAllCaptures()
        if (unsyncedTurnsFile.exists()) unsyncedTurnsFile.delete()
        if (unsyncedTeachFile.exists()) unsyncedTeachFile.delete()
        if (yesNoFile.exists()) yesNoFile.delete()
    }

    fun generateLeaseToken(): String {
        val bytes = ByteArray(12)
        SecureRandom().nextBytes(bytes)
        return "cl_" + bytes.joinToString("") { "%02x".format(it) }
    }

    fun builtInStoreCatalog(installedIds: Set<String>): List<StoreCatalogItem> = listOf(
        StoreCatalogItem(
            id = "store_coding_skill",
            kind = "Skill",
            title = "Coding & Debug Expert",
            description = "Routes programming questions through structured NeuroLang syntax & algorithm neurons.",
            author = "NeuroClaw Core",
            category = "Engineering",
            neuroLangCode = "name=\"code_parser\"\n\"code_parser\"@vale=\"3.0\"\n\"code_parser\"@definition=\"Trace syntax, invariants, and edge cases before patching.\"\nname=\"test_verifier\"\n\"test_verifier\"@connections=\".code_parser*0.85+0.1\"",
            installed = "store_coding_skill" in installedIds
        ),
        StoreCatalogItem(
            id = "store_heic_skill",
            kind = "Skill",
            title = "Media & Format Pipeline",
            description = "Step-by-step procedural skill for container inspection, tile decoding, and PNG export.",
            author = "SkillMaker",
            category = "Media",
            neuroLangCode = "name=\"container_header\"\n\"container_header\"@vale=\"2.2\"\n\"container_header\"@definition=\"Read container header, extract payload, decode tiles.\"",
            installed = "store_heic_skill" in installedIds
        ),
        StoreCatalogItem(
            id = "store_research_corroborator",
            kind = "Plugin",
            title = "Research Corroborator",
            description = "Cross-checks claims against local associative traces before synthesizing an answer.",
            author = "NeuroClaw Commons",
            category = "Reasoning",
            neuroLangCode = "name=\"corroborator\"\n\"corroborator\"@vale=\"2.8\"\n\"corroborator\"@definition=\"Verify multi-trace evidence before answering.\"",
            installed = "store_research_corroborator" in installedIds
        ),
        StoreCatalogItem(
            id = "store_prompt_reflect",
            kind = "Prompting",
            title = "Structured Self-Critique",
            description = "Adds [[ask: ...]] follow-up prompts for confidence checking and counter-examples.",
            author = "OneBrain Lab",
            category = "Prompting",
            neuroLangCode = "name=\"self_critic\"\n\"self_critic\"@vale=\"2.0\"\n\"self_critic\"@definition=\"Offer crisp follow-up verification prompts.\"",
            installed = "store_prompt_reflect" in installedIds
        )
    )

    fun builtInWikiArticles(): List<WikiArticle> = listOf(
        WikiArticle(
            id = "onebrain",
            title = "OneBrain & The Zip Loop",
            summary = "How raw bytes flow through the neural mesh without tokenizers.",
            content = "NeuroClaw never slices text into subword tokens. Every prompt enters as raw UTF-8 bytes through the Zip Loop, projecting into 32-dimensional hypervectors partitioned into semantic (40%), context (25%), value (10%), temporary (15%), and meta (10%) subspaces. Pre-trained OneBrain byte edges (memory_input_b* -> memory_output_b*) provide immediate pattern recall offline."
        ),
        WikiArticle(
            id = "vale",
            title = "Zero-Sum Vale Conservation",
            summary = "Preventing catastrophic forgetting with conserved plasticity budgets.",
            content = "Every neuron holds a Vale stability weight. When a winning neuron increases its Vale on a cycle, the remaining neurons share an equal decrease so the total Vale across the mesh remains strictly conserved. High-Vale neurons change slowly, protecting established knowledge while letting low-Vale neurons adapt rapidly."
        ),
        WikiArticle(
            id = "neurolang",
            title = "NeuroLang (NDL) Extensions",
            summary = "Authoring routable experts in declarative neuron definitions.",
            content = "NeuroLang lets you define neurons (name=\"...\"), stability weights (@vale=\"...\"), behavioral definitions (@definition=\"...\"), and weighted synapses (@connections=\"target*weight+bias\"). Compiled extensions graft directly into OneBrain and appear as green skill tentacles inside the Crown Ring."
        ),
        WikiArticle(
            id = "alignment",
            title = "Danger Protocols & Alignment",
            summary = "Behavioral standing, sandbox isolation, and the alignment protocol.",
            content = "The Danger Protocol tracks actions—never mere speech—across five bands: Friendly, Neutral, Wary, Hostile, and Malicious. Wary enforces sandbox isolation; Malicious triggers removal when the alignment protocol is armed, visibly breaking the Crown Ring until a fresh agent is initialized."
        )
    )

    fun exportAllSessionsJson(sessions: List<ChatSession>): String =
        json.encodeToString(sessions)
}
