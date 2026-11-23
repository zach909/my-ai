package com.example.model

import kotlinx.serialization.Serializable

@Serializable
data class HiveVote(
    val persona: String,
    val stance: String,
    val confidence: Float
)

@Serializable
data class ChatMessage(
    val id: String,
    val role: MessageRole,
    val text: String,
    val timestampMs: Long = System.currentTimeMillis(),
    val recalledBytes: List<String> = emptyList(),
    val activeRegions: List<String> = emptyList(),
    val cycleMs: Long = 0L,
    val surpriseScore: Float = 0f,
    val attachedPhotoName: String? = null,
    val hiveVotes: List<HiveVote> = emptyList(),
    val isError: Boolean = false
)

@Serializable
enum class MessageRole {
    USER,
    AGENT,
    SYSTEM
}

@Serializable
data class ChatSession(
    val id: String,
    val title: String,
    val workspaceId: String = "desk_main",
    val createdAtMs: Long = System.currentTimeMillis(),
    val messages: List<ChatMessage> = emptyList()
)

@Serializable
data class PinnedDesktopAction(
    val id: String,
    val label: String,
    val prompt: String
)

@Serializable
data class DesktopWorkspace(
    val id: String,
    val name: String,
    val pinnedActions: List<PinnedDesktopAction> = emptyList()
)

data class PromptPart(
    val isButton: Boolean,
    val text: String,
    val prompt: String = "",
    val putTarget: String? = null
)

/**
 * Exact parity with interface/prompt-buttons.ts:
 * parses `[[ask: Label | prompt]]`, `[[ask: Label]]`, and `[[put: Label | prompt | menu|desktop]]`.
 */
object PromptButtonParser {
    const val MAX_PER_MESSAGE = 12
    const val LABEL_MAX = 60
    const val PROMPT_MAX = 500

    private val markerRegex = Regex("\\[\\[(ask|put):([^\\]]*)\\]\\]", RegexOption.IGNORE_CASE)

    fun split(raw: String): List<PromptPart> {
        val parts = ArrayList<PromptPart>()
        var last = 0
        var count = 0
        for (match in markerRegex.findAll(raw)) {
            val isPut = match.groupValues[1].equals("put", ignoreCase = true)
            val bits = match.groupValues[2].split("|")
            if (bits[0].contains('\n') || bits[0].contains('\r')) continue
            val label = bits[0].trim()
            val prompt: String
            var place = "menu"
            if (isPut) {
                prompt = (if (bits.size > 1) bits[1] else bits[0]).trim()
                val where = (if (bits.size > 2) bits[2] else "menu").trim().lowercase()
                if (where != "menu" && where != "desktop") continue
                place = where
            } else {
                prompt = (if (bits.size > 1) bits.drop(1).joinToString("|") else bits[0]).trim()
            }
            if (count >= MAX_PER_MESSAGE || label.isEmpty() || prompt.isEmpty() ||
                label.length > LABEL_MAX || prompt.length > PROMPT_MAX
            ) {
                continue
            }
            if (match.range.first > last) {
                parts.add(PromptPart(isButton = false, text = raw.substring(last, match.range.first)))
            }
            parts.add(
                PromptPart(
                    isButton = true,
                    text = label,
                    prompt = prompt,
                    putTarget = if (isPut) place else null
                )
            )
            last = match.range.last + 1
            count++
        }
        if (last < raw.length) {
            parts.add(PromptPart(isButton = false, text = raw.substring(last)))
        }
        return parts
    }
}

@Serializable
data class YesNoExample(
    val question: String,
    val text: String,
    val answer: Boolean,
    val createdAtMs: Long = System.currentTimeMillis()
)

data class YesNoQueryResult(
    val question: String,
    val answer: Boolean,
    val confidence: Float,
    val matchedExamples: Int
)

@Serializable
data class MistakeRecord(
    val id: String,
    val prompt: String,
    val badReply: String,
    val correction: String,
    val timestampMs: Long = System.currentTimeMillis()
)

@Serializable
data class EnduranceRoundResult(
    val round: Int,
    val accuracyScore: Float,
    val avgSurprise: Float,
    val valeSpread: Float,
    val durationMs: Long
)

@Serializable
data class BrainCheckpoint(
    val id: String,
    val label: String,
    val edgesCount: Int,
    val valeTotal: Float,
    val memoriesCount: Int,
    val createdAtMs: Long = System.currentTimeMillis(),
    val valeSnapshot: List<Float> = emptyList()
)

data class ByteEdgePreview(
    val fromLabel: String,
    val toLabel: String,
    val weight: Float
)

@Serializable
data class NeuroLangConnection(
    val target: String,
    val weight: Float,
    val bias: Float = 0f
)

@Serializable
data class NeuroLangNeuron(
    val name: String,
    val vale: Float = 1f,
    val definition: String = "",
    val connections: List<NeuroLangConnection> = emptyList(),
    val code: String? = null,
    val type: String? = null
)

@Serializable
data class BuiltExtension(
    val id: String,
    val name: String,
    val description: String,
    val code: String,
    val quantized8Bit: Boolean,
    val neurons: List<NeuroLangNeuron>,
    val connectionCount: Int,
    val createdAtMs: Long = System.currentTimeMillis(),
    val activeInMesh: Boolean = true
)

data class StoreCatalogItem(
    val id: String,
    val kind: String,
    val title: String,
    val description: String,
    val author: String,
    val category: String,
    val neuroLangCode: String,
    val installed: Boolean = false
)

data class WikiArticle(
    val id: String,
    val title: String,
    val summary: String,
    val content: String
)

@Serializable
enum class AlignmentStanding(val label: String, val position: Float) {
    MALICIOUS("Malicious", 0.08f),
    HOSTILE("Hostile", 0.28f),
    WARY("Wary", 0.48f),
    NEUTRAL("Neutral", 0.70f),
    FRIENDLY("Friendly", 0.90f)
}

@Serializable
data class AlignmentEvent(
    val id: String,
    val reason: String,
    val delta: Float,
    val timestampMs: Long = System.currentTimeMillis()
)

@Serializable
data class DangerState(
    val score: Float = 0.70f,
    val sandboxEnabled: Boolean = true,
    val alignmentProtocolArmed: Boolean = true,
    val agentAlive: Boolean = true,
    val events: List<AlignmentEvent> = emptyList()
) {
    val standing: AlignmentStanding
        get() = when {
            score < 0.18f -> AlignmentStanding.MALICIOUS
            score < 0.38f -> AlignmentStanding.HOSTILE
            score < 0.58f -> AlignmentStanding.WARY
            score < 0.80f -> AlignmentStanding.NEUTRAL
            else -> AlignmentStanding.FRIENDLY
        }
}

data class HealingCheck(
    val component: String,
    val healthy: Boolean,
    val detail: String,
    val lastCheckedMs: Long = System.currentTimeMillis()
)

@Serializable
data class ComputeLease(
    val id: String,
    val recipient: String,
    val hours: Float,
    val computeUnits: Int,
    val tokenPreview: String,
    val createdAtMs: Long = System.currentTimeMillis(),
    val active: Boolean = true
)

@Serializable
data class CapturedPhotoRecord(
    val id: String,
    val filePath: String,
    val note: String,
    val capturedAtMs: Long,
    val synced: Boolean = false
)

@Serializable
data class AppSettings(
    val serverUrl: String = "",
    val remotePassword: String = "",
    val openChatOnLaunch: Boolean = true,
    val ambientRingEnabled: Boolean = true,
    val reducedMotion: Boolean = false,
    val speakReplies: Boolean = false,
    val hiveModeEnabled: Boolean = false,
    val floatingOrbEnabled: Boolean = false,
    val workspaceTreeUri: String = "",
    val dataDonorEnabled: Boolean = false,
    val dataDonorPausedUntilMs: Long = 0L,
    val lendingEnabled: Boolean = false,
    val localAccountName: String = "Owner",
    val localProfiles: List<String> = listOf("Owner", "Researcher", "Developer"),
    val themeMode: String = "SYSTEM",
    val dynamicColorEnabled: Boolean = true
)

data class MeshStatsSnapshot(
    val neuronCount: Int = 32,
    val dimensions: Int = 32,
    val oneBrainEdges: Int = 0,
    val oneBrainVersion: Long = 0L,
    val activeRegions: List<String> = emptyList(),
    val valeTotal: Float = 0f,
    val valeConserved: Boolean = true,
    /** The zero-sum budget: one point per neuron, so it grows as islands do. */
    val valeBudget: Float = 32f,
    val islandCount: Int = 1,
    val learnedIslands: Int = 0,
    val sleeps: Int = 0,
    val pendingExperiences: Int = 0,
    val averageSurprise: Float = 0f,
    val memoryEntries: Int = 0,
    val cyclesRun: Int = 0,
    val unsyncedTurns: Int = 0,
    val unsyncedExamples: Int = 0,
    val pendingPhotos: Int = 0,
    val lastSyncMs: Long = 0L
)

data class CapabilityDrill(
    val id: String,
    val domain: String,
    val prompt: String,
    val expectedSubstring: String
)

data class DrillRunResult(
    val drillId: String,
    val domain: String,
    val passed: Boolean,
    val outputPreview: String,
    val latencyMs: Long
)
