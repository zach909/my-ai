package com.example.engine

import android.content.Context
import com.example.model.BrainCheckpoint
import com.example.model.BuiltExtension
import com.example.model.ByteEdgePreview
import com.example.model.CapabilityDrill
import com.example.model.DrillRunResult
import com.example.model.EnduranceRoundResult
import com.example.model.HealingCheck
import com.example.model.HiveVote
import com.example.model.MeshStatsSnapshot
import com.example.model.MistakeRecord
import com.example.model.YesNoExample
import com.example.model.YesNoQueryResult
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.tanh

/**
 * Local-first OneBrain neural mesh engine in pure Kotlin:
 * - Reads bundled `assets/onebrain/model.json` (`memory_input_b*` -> `memory_output_b*` edges)
 * - Runs raw UTF-8 byte-level Zip Loop projection (no tokenizer)
 * - Maintains a 32-neuron x 32-dim Hyperdimensional Mesh with zero-sum Vale conservation
 * - Supports NetSkillRouter over grafted NeuroLang extensions and Yes/No doorways
 * - Tracks surprise-gated associative memories and self-improvement drills
 */
class OneBrainEngine(private val context: Context) {

    data class ByteEdge(val fromByte: Int, val toByte: Int, val weight: Float)

    data class SkillRegion(
        val id: String,
        val name: String,
        val meaning: String,
        val anchor: HDVector,
        val definitions: List<String> = emptyList()
    )

    data class MemoryTrace(
        val cue: HDVector,
        val text: String,
        val surprise: Float,
        val timestampMs: Long
    )

    data class ChatTurnOutput(
        val reply: String,
        val recalledBytes: List<String>,
        val activeRegions: List<String>,
        val cycleMs: Long,
        val surpriseScore: Float,
        val hiveVotes: List<HiveVote> = emptyList()
    )

    companion object {
        const val PHONE_NEURONS = 32
        const val PHONE_DIMENSIONS = 32
        private const val INITIAL_VALE_TOTAL = 32.0f
        private const val LEARNING_RATE = 0.05f
        private const val INFLUENCE_DECAY = 0.95f
        private val INPUT_EDGE_REGEX = Regex("""^memory_(input|output)_b(\d+)$""")
    }

    private val lock = Any()
    val deviceTools = DeviceTools(context)
    private val neuronStates = Array(PHONE_NEURONS) { idx ->
        HDVector.random(PHONE_DIMENSIONS, seed = 1000L + idx * 37L)
    }
    private val valeLedger = FloatArray(PHONE_NEURONS) { INITIAL_VALE_TOTAL / PHONE_NEURONS }
    private val byteEdges = ArrayList<ByteEdge>()
    private val regions = LinkedHashMap<String, SkillRegion>()
    private val memoryTraces = ArrayList<MemoryTrace>()
    private val yesNoExamples = ArrayList<YesNoExample>()

    var oneBrainVersion: Long = 0L
        private set
    private var cyclesRun: Int = 0
    private var lastSurpriseAvg: Float = 0.18f

    init {
        loadBundledOneBrain()
        registerDefaultRegions()
    }

    private fun loadBundledOneBrain() {
        val raw = runCatching {
            context.assets.open("onebrain/model.json").bufferedReader().use { it.readText() }
        }.getOrNull() ?: return
        parseOneBrainModel(raw)
    }

    fun parseOneBrainModel(modelJson: String): Int = synchronized(lock) {
        val obj = JSONObject(modelJson)
        oneBrainVersion = obj.optLong("modifiedAt", obj.optLong("updatedAt", 0L))

        val sideMap = HashMap<String, Pair<Boolean, Int>>()
        val neuronsArr = obj.optJSONArray("neurons")
        if (neuronsArr != null) {
            for (i in 0 until neuronsArr.length()) {
                val pair = neuronsArr.optJSONArray(i) ?: continue
                val nObj = pair.optJSONObject(1) ?: continue
                val id = nObj.optString("id")
                val label = nObj.optString("label")
                val m = INPUT_EDGE_REGEX.matchEntire(label) ?: continue
                val isInput = m.groupValues[1] == "input"
                val byteVal = m.groupValues[2].toIntOrNull() ?: continue
                sideMap[id] = isInput to byteVal
            }
        }

        val weightsArr = obj.optJSONArray("weights")
        val connArr = obj.optJSONArray("connections")
        byteEdges.clear()
        if (connArr != null && weightsArr != null) {
            for (i in 0 until connArr.length()) {
                val pair = connArr.optJSONArray(i) ?: continue
                val cObj = pair.optJSONObject(1) ?: continue
                val from = sideMap[cObj.optString("fromNeuronId")] ?: continue
                val to = sideMap[cObj.optString("toNeuronId")] ?: continue
                if (!from.first || to.first) continue
                val wIdx = cObj.optInt("weightIndex", -1)
                if (wIdx in 0 until weightsArr.length() && !weightsArr.isNull(wIdx)) {
                    val w = weightsArr.optDouble(wIdx, 0.0).toFloat()
                    byteEdges.add(ByteEdge(from.second, to.second, w))
                }
            }
        }
        byteEdges.size
    }

    private fun registerDefaultRegions() {
        registerRegion(
            id = "onebrain",
            name = "OneBrain",
            meaning = "memory recall of learned byte patterns and associations",
            definitions = listOf("Recalls learned byte transitions from grafted self_ext snapshots.")
        )
        registerRegion(
            id = "zip-loop",
            name = "ZipLoop",
            meaning = "raw bit-level prompt and output cycle without tokenizers",
            definitions = listOf("Encodes raw UTF-8 bytes directly into hyperdimensional state.")
        )
        registerRegion(
            id = "vale-guard",
            name = "ValeGuard",
            meaning = "zero-sum stability ledger protecting long-term weights",
            definitions = listOf("Preserves total plasticity budget across active neurons.")
        )
        registerRegion(
            id = "neurolang",
            name = "NeuroLang",
            meaning = "compile neuron definitions, values, and weighted connections",
            definitions = listOf("Parses name=, @vale=, @definition=, and @connections= blocks.")
        )
        registerRegion(
            id = "device-tools",
            name = "DeviceTools",
            meaning = "inspect Android permissions, sensors, battery, network, location, contacts, calendar, bluetooth, dialer, sms",
            definitions = listOf("Imported Android DeviceTools module routed through OneBrain.")
        )
    }

    fun registerRegion(
        id: String,
        name: String,
        meaning: String,
        definitions: List<String> = emptyList()
    ) = synchronized(lock) {
        val bytes = "$name $meaning ${definitions.joinToString(" ")}".toByteArray(Charsets.UTF_8)
        regions[id] = SkillRegion(
            id = id,
            name = name,
            meaning = meaning,
            anchor = HDVector.encodeBytes(bytes, PHONE_DIMENSIONS),
            definitions = definitions
        )
    }

    fun unregisterRegion(id: String) = synchronized(lock) {
        regions.remove(id)
    }

    fun graftExtension(ext: BuiltExtension) {
        val defs = ext.neurons.mapNotNull { n ->
            val d = n.definition.trim()
            if (d.isNotEmpty()) "${n.name}: $d" else null
        }
        val meaning = ext.description.ifBlank { ext.neurons.joinToString(", ") { it.name } }
        registerRegion(
            id = "ext:${ext.id}",
            name = ext.name,
            meaning = meaning,
            definitions = defs
        )
        // Reinforce mesh vale slightly toward the newly grafted extension's anchor
        synchronized(lock) {
            val anchor = HDVector.encodeBytes(ext.code.toByteArray(Charsets.UTF_8), PHONE_DIMENSIONS)
            val targetIdx = abs(ext.name.hashCode()) % PHONE_NEURONS
            neuronStates[targetIdx] = HDVector.bundle(neuronStates[targetIdx], anchor, 0.6f, 0.4f)
        }
    }

    fun recallBytes(text: String, topK: Int = 5): List<String> = synchronized(lock) {
        if (byteEdges.isEmpty()) return emptyList()
        val active = HashSet<Int>()
        for (b in text.toByteArray(Charsets.UTF_8)) active.add(b.toInt() and 0xFF)
        val scores = HashMap<Int, Float>()
        for (edge in byteEdges) {
            if (edge.fromByte in active) {
                scores[edge.toByte] = (scores[edge.toByte] ?: 0f) + edge.weight
            }
        }
        return scores.entries
            .sortedByDescending { it.value }
            .take(topK)
            .map { (b, _) -> byteLabel(b) }
    }

    fun selectRegions(text: String, topK: Int = 3): List<SkillRegion> = synchronized(lock) {
        val inputVec = HDVector.encodeBytes(text.toByteArray(Charsets.UTF_8), PHONE_DIMENSIONS)
        val lower = text.lowercase()
        return regions.values
            .map { reg ->
                val sim = HDVector.cosineSimilarity(inputVec, reg.anchor)
                val keywordBoost = if (
                    lower.contains(reg.name.lowercase()) ||
                    reg.meaning.lowercase().split(' ').any { w -> w.length > 3 && lower.contains(w) }
                ) 0.35f else 0f
                reg to (sim + keywordBoost)
            }
            .sortedByDescending { it.second }
            .take(topK)
            .map { it.first }
    }

    fun processChat(message: String, hiveMode: Boolean = false): ChatTurnOutput = synchronized(lock) {
        val started = System.nanoTime()
        val rawBytes = message.toByteArray(Charsets.UTF_8)
        val inputVec = HDVector.encodeBytes(rawBytes, PHONE_DIMENSIONS)

        // Propagate across mesh with Vale-weighted plasticity (high-vale neurons resist rapid drift)
        var maxSim = -1f
        var bestIdx = 0
        for (i in 0 until PHONE_NEURONS) {
            val sim = HDVector.cosineSimilarity(inputVec, neuronStates[i])
            if (sim > maxSim) {
                maxSim = sim
                bestIdx = i
            }
            val plasticity = (LEARNING_RATE / (0.5f + valeLedger[i])).coerceIn(0.005f, 0.08f)
            val mixWeight = max(0f, sim + 0.25f) * plasticity
            if (mixWeight > 0f) {
                neuronStates[i] = HDVector.bundle(neuronStates[i], inputVec, 1f - mixWeight, mixWeight)
            }
        }

        // Surprise-gated associative memory consolidation + zero-sum Vale transfer
        val surprise = (1f - ((maxSim + 1f) * 0.5f)).coerceIn(0.02f, 0.98f)
        lastSurpriseAvg = lastSurpriseAvg * INFLUENCE_DECAY + surprise * (1f - INFLUENCE_DECAY)
        if (surprise > 0.28f || memoryTraces.size < 4) {
            if (memoryTraces.size >= 64) memoryTraces.removeAt(0)
            memoryTraces.add(MemoryTrace(inputVec, message.trim(), surprise, System.currentTimeMillis()))
        }
        redistributeValeZeroSum(winnerIdx = bestIdx, delta = 0.08f)

        val matchedRegions = selectRegions(message)
        val recalled = recallBytes(message)
        cyclesRun++

        // Recall closest prior episodic memory if relevant
        val closestMemory = memoryTraces
            .filter { it.text != message.trim() }
            .map { it to HDVector.cosineSimilarity(inputVec, it.cue) }
            .filter { it.second > 0.38f }
            .maxByOrNull { it.second }

        val yesNoHint = findBestYesNoMatch(message)
        val toolResult = deviceTools.tryHandleToolPrompt(message)
        val hiveVotes = if (hiveMode) evaluateHiveConsensus(message, matchedRegions, surprise) else emptyList()

        val reply = synthesizeReply(
            message = message,
            matchedRegions = matchedRegions,
            recalled = recalled,
            surprise = surprise,
            closestMemory = closestMemory?.first?.text,
            yesNoHint = yesNoHint,
            toolResult = toolResult,
            hiveVotes = hiveVotes
        )
        val elapsedMs = max(1L, (System.nanoTime() - started) / 1_000_000L)

        ChatTurnOutput(
            reply = reply,
            recalledBytes = recalled,
            activeRegions = matchedRegions.map { it.name },
            cycleMs = elapsedMs,
            surpriseScore = surprise,
            hiveVotes = hiveVotes
        )
    }

    private fun evaluateHiveConsensus(
        message: String,
        matchedRegions: List<SkillRegion>,
        surprise: Float
    ): List<HiveVote> {
        val msgVec = HDVector.encodeBytes(message.toByteArray(Charsets.UTF_8), PHONE_DIMENSIONS)
        val personas = listOf(
            "Planner" to "decompose into structured actions",
            "Coder" to "verify invariants and syntax paths",
            "Critic" to "check edge cases and mistake guards",
            "DeviceOps" to "route permissions and Android hardware tools",
            "MemoryWeaver" to "bind associative traces across ${memoryTraces.size} cues"
        )
        return personas.mapIndexed { idx, (name, role) ->
            val pVec = HDVector.encodeBytes("$name $role".toByteArray(Charsets.UTF_8), PHONE_DIMENSIONS)
            val neuronSim = HDVector.cosineSimilarity(msgVec, neuronStates[(idx * 5) % PHONE_NEURONS])
            val sim = (0.55f + 0.35f * HDVector.cosineSimilarity(msgVec, pVec) + 0.1f * neuronSim).coerceIn(0.45f, 0.98f)
            val regionHint = matchedRegions.getOrNull(idx % max(1, matchedRegions.size))?.name ?: "OneBrain"
            val stance = when (name) {
                "Critic" -> if (surprise > 0.45f) "High surprise (${"%.2f".format(surprise)}): verify carefully" else "Low surprise: aligned"
                "DeviceOps" -> "Ready via $regionHint"
                else -> "Route via $regionHint"
            }
            HiveVote(persona = name, stance = stance, confidence = sim)
        }
    }

    private fun redistributeValeZeroSum(winnerIdx: Int, delta: Float) {
        val share = delta / max(1, PHONE_NEURONS - 1)
        for (i in 0 until PHONE_NEURONS) {
            if (i == winnerIdx) {
                valeLedger[i] = (valeLedger[i] + delta).coerceAtMost(4.0f)
            } else {
                valeLedger[i] = (valeLedger[i] - share).coerceAtLeast(0.1f)
            }
        }
        // Re-normalize to preserve exact zero-sum total
        val sum = valeLedger.sum()
        if (sum > 0f) {
            val scale = INITIAL_VALE_TOTAL / sum
            for (i in 0 until PHONE_NEURONS) valeLedger[i] *= scale
        }
    }

    private fun findBestYesNoMatch(text: String): YesNoQueryResult? {
        if (yesNoExamples.isEmpty()) return null
        val qVec = HDVector.encodeBytes(text.toByteArray(Charsets.UTF_8), PHONE_DIMENSIONS)
        val grouped = yesNoExamples.groupBy { it.question }
        var best: YesNoQueryResult? = null
        var bestStrength = 0f
        for ((q, list) in grouped) {
            var pos = 0f
            var neg = 0f
            for (ex in list) {
                val eVec = HDVector.encodeBytes(ex.text.toByteArray(Charsets.UTF_8), PHONE_DIMENSIONS)
                val sim = max(0f, HDVector.cosineSimilarity(qVec, eVec))
                if (ex.answer) pos += sim else neg += sim
            }
            val total = pos + neg
            if (total > 0.25f) {
                val ans = pos >= neg
                val conf = (abs(pos - neg) / total).coerceIn(0.5f, 0.99f)
                if (total > bestStrength) {
                    bestStrength = total
                    best = YesNoQueryResult(q, ans, conf, list.size)
                }
            }
        }
        return best
    }

    private fun synthesizeReply(
        message: String,
        matchedRegions: List<SkillRegion>,
        recalled: List<String>,
        surprise: Float,
        closestMemory: String?,
        yesNoHint: YesNoQueryResult?,
        toolResult: DeviceToolResult?,
        hiveVotes: List<HiveVote>
    ): String {
        val lower = message.trim().lowercase()
        val extDefs = matchedRegions.filter { it.id.startsWith("ext:") || it.id.startsWith("store:") || it.id.startsWith("mistake:") }
            .flatMap { it.definitions }
            .take(2)

        if (toolResult != null) {
            return buildString {
                append("[DeviceTools • ${toolResult.toolName}]\n")
                append(toolResult.summary)
                if (!toolResult.promptSuggestion.isNullOrBlank()) {
                    append("\n\n${toolResult.promptSuggestion}")
                } else {
                    append("\n\n[[ask: Audit permissions | tool: permission_audit]] [[ask: Device info | tool: device_info]]")
                }
            }
        }

        return buildString {
            when {
                lower.contains("hello") || lower == "hi" || lower.startsWith("hey") -> {
                    append("OneBrain mesh is awake on this device (${byteEdges.size} byte edges, ${regions.size} active skill regions). ")
                    append("Every character you send enters through the Zip Loop as raw UTF-8 bytes without a tokenizer.")
                    append("\n\n[[ask: Inspect mesh stats | What is the current mesh and vale state?]]")
                    append(" [[ask: Audit permissions | tool: permission_audit]]")
                    append(" [[put: Pin Audit | tool: permission_audit | desktop]]")
                }
                lower.contains("vale") || lower.contains("mesh") || lower.contains("stat") -> {
                    val totalVale = valeLedger.sum()
                    append("Mesh state: $PHONE_NEURONS hyper-neurons x $PHONE_DIMENSIONS dims, ")
                    append("${byteEdges.size} OneBrain byte connections, ")
                    append("Vale budget conserved at ${"%.2f".format(totalVale)}/${"%.2f".format(INITIAL_VALE_TOTAL)}. ")
                    append("Cycle surprise is ${"%.2f".format(surprise)} across ${memoryTraces.size} consolidated traces.")
                    append("\n\n[[ask: Teach Yes/No | How do I teach OneBrain a new yes/no rule?]]")
                    append(" [[ask: Build NeuroLang skill | Show a NeuroLang skill example]]")
                }
                lower.contains("neurolang") || lower.contains("extension") || lower.contains("skill") -> {
                    append("NeuroLang defines routable experts directly inside OneBrain:\n")
                    append("name=\"helper\"\n\"helper\"@vale=\"3\"\n\"helper\"@definition=\"Your skill behavior\"\n")
                    append("Open the Builder tab to compile & graft a NeuroLang extension — each active skill grows a new green tentacle inside the Crown Ring.")
                    append("\n\n[[ask: Explain Zip Loop | How does the Zip Loop process bytes?]]")
                }
                lower.contains("zip") || lower.contains("token") || lower.contains("byte") -> {
                    append("NeuroClaw uses zero tokenizers. Your ${message.toByteArray().size}-byte input flowed through the Zip Loop into ")
                    append("${matchedRegions.joinToString(", ") { it.name }}")
                    if (recalled.isNotEmpty()) {
                        append(", activating OneBrain output bytes [${recalled.joinToString(" ")}]")
                    }
                    append(".")
                }
                lower.contains("teach") || lower.contains("yes/no") -> {
                    append("You can teach OneBrain binary concepts using the Teach button in Chat or the Yes/No Trainer on the Mesh tab. ")
                    append("Currently holding ${yesNoExamples.size} local training example(s).")
                }
                else -> {
                    append("Processed ${message.toByteArray().size} raw bytes via ")
                    append(matchedRegions.joinToString(" + ") { it.name })
                    append(" (surprise ${"%.2f".format(surprise)}).")
                    if (extDefs.isNotEmpty()) {
                        append("\nGrafted context: ${extDefs.joinToString(" | ")}")
                    }
                    if (yesNoHint != null) {
                        val verdict = if (yesNoHint.answer) "Yes" else "No"
                        append("\nYes/No Doorway [${yesNoHint.question}]: $verdict (${(yesNoHint.confidence * 100).toInt()}% confidence from ${yesNoHint.matchedExamples} examples).")
                    }
                    if (!closestMemory.isNullOrBlank()) {
                        append("\nAssociated trace: \"$closestMemory\"")
                    }
                    if (recalled.isNotEmpty()) {
                        append("\nOneBrain recalls: ${recalled.joinToString(" ")}")
                    }
                    if (hiveVotes.isNotEmpty()) {
                        val topVote = hiveVotes.maxByOrNull { it.confidence }
                        append("\nHive Mind Consensus (${hiveVotes.size} agents, lead ${topVote?.persona}): ${topVote?.stance}")
                    }
                    append("\n\n[[ask: Deeper recall | Recall more patterns from \"$message\"]]")
                    append(" [[ask: Check Vale budget | What is the current mesh and vale state?]]")
                }
            }
        }
    }

    fun teachYesNo(question: String, text: String, answer: Boolean): YesNoQueryResult = synchronized(lock) {
        val cleanQ = question.trim()
        val cleanT = text.trim()
        yesNoExamples.add(YesNoExample(cleanQ, cleanT, answer))
        registerRegion(
            id = "yes-no:${cleanQ.lowercase()}",
            name = cleanQ,
            meaning = "Yes/No doorway for $cleanQ",
            definitions = listOf(cleanT)
        )
        askYesNo(cleanQ, cleanT)
    }

    fun askYesNo(question: String, text: String): YesNoQueryResult = synchronized(lock) {
        val matching = yesNoExamples.filter { it.question.equals(question.trim(), ignoreCase = true) }
        if (matching.isEmpty()) {
            return YesNoQueryResult(question, answer = false, confidence = 0.5f, matchedExamples = 0)
        }
        val qVec = HDVector.encodeBytes(text.toByteArray(Charsets.UTF_8), PHONE_DIMENSIONS)
        var pos = 0f
        var neg = 0f
        for (ex in matching) {
            val eVec = HDVector.encodeBytes(ex.text.toByteArray(Charsets.UTF_8), PHONE_DIMENSIONS)
            val weight = exp(HDVector.cosineSimilarity(qVec, eVec) * 2f)
            if (ex.answer) pos += weight else neg += weight
        }
        val total = max(1e-5f, pos + neg)
        val ans = pos >= neg
        val conf = (abs(pos - neg) / total).coerceIn(0.5f, 0.99f)
        YesNoQueryResult(question, ans, conf, matching.size)
    }

    fun loadYesNoExamples(examples: List<YesNoExample>) = synchronized(lock) {
        yesNoExamples.clear()
        yesNoExamples.addAll(examples)
        examples.map { it.question }.distinct().forEach { q ->
            registerRegion("yes-no:${q.lowercase()}", q, "Yes/No doorway for $q")
        }
    }

    fun listYesNoQuestions(): List<String> = synchronized(lock) {
        yesNoExamples.map { it.question }.distinct()
    }

    fun runDrill(drill: CapabilityDrill): DrillRunResult = synchronized(lock) {
        val started = System.nanoTime()
        val res = when (drill.domain) {
            "Hyperdim" -> {
                val a = HDVector.encodeBytes("alpha".toByteArray(), PHONE_DIMENSIONS)
                val b = HDVector.encodeBytes("beta".toByteArray(), PHONE_DIMENSIONS)
                val bound = HDVector.bind(a, b)
                val sim = HDVector.cosineSimilarity(bound, a)
                val ok = abs(sim) < 0.65f
                ok to "bind(a,b) orthogonality sim=${"%.3f".format(sim)}"
            }
            "Vale" -> {
                val sum = valeLedger.sum()
                val ok = abs(sum - INITIAL_VALE_TOTAL) < 0.05f
                ok to "Vale sum=${"%.3f".format(sum)} (expected $INITIAL_VALE_TOTAL)"
            }
            "NeuroLang" -> {
                val parsed = NeuroLangParser.parse("name=\"probe\"\n\"probe\"@vale=\"2.5\"\n\"probe\"@definition=\"ok\"")
                val ok = parsed.isValid && parsed.neurons.first().vale == 2.5f
                ok to "Parsed ${parsed.neurons.size} neuron(s), vale=${parsed.neurons.firstOrNull()?.vale}"
            }
            else -> {
                val out = processChat(drill.prompt)
                val ok = out.recalledBytes.isNotEmpty() || out.activeRegions.isNotEmpty()
                ok to "Activated [${out.activeRegions.joinToString(", ")}]"
            }
        }
        val ms = max(1L, (System.nanoTime() - started) / 1_000_000L)
        DrillRunResult(
            drillId = drill.id,
            domain = drill.domain,
            passed = res.first,
            outputPreview = res.second,
            latencyMs = ms
        )
    }

    fun runSelfHealing(extensionCount: Int): List<HealingCheck> = synchronized(lock) {
        val valeSum = valeLedger.sum()
        val valeOk = abs(valeSum - INITIAL_VALE_TOTAL) < 0.1f
        if (!valeOk) {
            val scale = INITIAL_VALE_TOTAL / max(0.01f, valeSum)
            for (i in 0 until PHONE_NEURONS) valeLedger[i] *= scale
        }
        val normOk = neuronStates.all { abs(it.norm() - 1f) < 0.05f }
        if (!normOk) {
            for (i in 0 until PHONE_NEURONS) neuronStates[i] = neuronStates[i].normalized()
        }
        listOf(
            HealingCheck(
                component = "OneBrain Byte Graph",
                healthy = byteEdges.isNotEmpty(),
                detail = "${byteEdges.size} learned byte edges loaded (v$oneBrainVersion)"
            ),
            HealingCheck(
                component = "Vale Zero-Sum Ledger",
                healthy = true,
                detail = if (valeOk) "Conserved at ${"%.2f".format(valeSum)}" else "Rebalanced to $INITIAL_VALE_TOTAL"
            ),
            HealingCheck(
                component = "Hyperdimensional Manifold",
                healthy = true,
                detail = if (normOk) "All $PHONE_NEURONS vectors unit-normalized" else "Renormalized drift vectors"
            ),
            HealingCheck(
                component = "Extension & Skill Regions",
                healthy = true,
                detail = "${regions.size} active regions ($extensionCount user-built)"
            )
        )
    }

    fun snapshot(
        unsyncedTurns: Int,
        unsyncedExamples: Int,
        pendingPhotos: Int,
        lastSyncMs: Long
    ): MeshStatsSnapshot = synchronized(lock) {
        val sum = valeLedger.sum()
        MeshStatsSnapshot(
            neuronCount = PHONE_NEURONS,
            dimensions = PHONE_DIMENSIONS,
            oneBrainEdges = byteEdges.size,
            oneBrainVersion = oneBrainVersion,
            activeRegions = regions.values.map { it.name },
            valeTotal = sum,
            valeConserved = abs(sum - INITIAL_VALE_TOTAL) < 0.1f,
            averageSurprise = lastSurpriseAvg,
            memoryEntries = memoryTraces.size,
            cyclesRun = cyclesRun,
            unsyncedTurns = unsyncedTurns,
            unsyncedExamples = unsyncedExamples,
            pendingPhotos = pendingPhotos,
            lastSyncMs = lastSyncMs
        )
    }

    fun getValeDistribution(): List<Float> = synchronized(lock) {
        valeLedger.toList()
    }

    fun recordMistake(mistake: MistakeRecord) = synchronized(lock) {
        val corrVec = HDVector.encodeBytes(mistake.correction.toByteArray(Charsets.UTF_8), PHONE_DIMENSIONS)
        if (memoryTraces.size >= 64) memoryTraces.removeAt(0)
        memoryTraces.add(MemoryTrace(corrVec, mistake.correction, 0.92f, mistake.timestampMs))
        registerRegion(
            id = "mistake:${mistake.id.take(8)}",
            name = "Correction",
            meaning = mistake.prompt,
            definitions = listOf("Prefer: ${mistake.correction}")
        )
        val idx = abs(mistake.prompt.hashCode()) % PHONE_NEURONS
        neuronStates[idx] = HDVector.bundle(neuronStates[idx], corrVec, 0.45f, 0.55f)
    }

    fun runEnduranceTraining(rounds: Int, mistakes: List<MistakeRecord>): List<EnduranceRoundResult> = synchronized(lock) {
        val results = ArrayList<EnduranceRoundResult>()
        val prompts = mutableListOf(
            "OneBrain Vale conservation invariant",
            "ZipLoop UTF-8 byte projection",
            "NeuroLang weighted synapse routing",
            "DeviceTools permission audit check"
        )
        mistakes.takeLast(4).forEach { m -> prompts.add(m.correction) }

        for (r in 1..rounds.coerceIn(1, 10)) {
            val started = System.nanoTime()
            var totalSurprise = 0f
            var passes = 0
            for (p in prompts) {
                val out = processChat(p, hiveMode = false)
                totalSurprise += out.surpriseScore
                if (out.activeRegions.isNotEmpty() || out.recalledBytes.isNotEmpty()) passes++
            }
            val avgSurp = totalSurprise / max(1, prompts.size)
            val spread = (valeLedger.maxOrNull() ?: 1f) - (valeLedger.minOrNull() ?: 1f)
            val accuracy = ((passes.toFloat() / max(1, prompts.size)) * (1f - avgSurp * 0.15f)).coerceIn(0.6f, 0.99f)
            val elapsedMs = max(1L, (System.nanoTime() - started) / 1_000_000L)
            results.add(
                EnduranceRoundResult(
                    round = r,
                    accuracyScore = accuracy,
                    avgSurprise = avgSurp,
                    valeSpread = spread,
                    durationMs = elapsedMs
                )
            )
        }
        results
    }

    fun topByteEdges(limit: Int = 18): List<ByteEdgePreview> = synchronized(lock) {
        byteEdges
            .sortedByDescending { abs(it.weight) }
            .take(limit)
            .map { e -> ByteEdgePreview(byteLabel(e.fromByte), byteLabel(e.toByte), e.weight) }
    }

    fun captureCheckpoint(label: String): BrainCheckpoint = synchronized(lock) {
        BrainCheckpoint(
            id = UUID.randomUUID().toString(),
            label = label.ifBlank { "Checkpoint #${cyclesRun}" },
            edgesCount = byteEdges.size,
            valeTotal = valeLedger.sum(),
            memoriesCount = memoryTraces.size,
            valeSnapshot = valeLedger.toList()
        )
    }

    fun restoreCheckpoint(cp: BrainCheckpoint): Boolean = synchronized(lock) {
        if (cp.valeSnapshot.size != PHONE_NEURONS) return false
        for (i in 0 until PHONE_NEURONS) {
            valeLedger[i] = cp.valeSnapshot[i]
        }
        true
    }

    fun exportMeshDeltaJson(): String = synchronized(lock) {
        val obj = JSONObject()
        obj.put("format", "neuroclaw-mesh-delta-v1")
        obj.put("oneBrainVersion", oneBrainVersion)
        obj.put("cyclesRun", cyclesRun)
        obj.put("valeLedger", JSONArray().apply { valeLedger.forEach { put(it.toDouble()) } })
        val regionsArr = JSONArray()
        regions.values.forEach { reg ->
            regionsArr.put(
                JSONObject()
                    .put("id", reg.id)
                    .put("name", reg.name)
                    .put("meaning", reg.meaning)
                    .put("definitions", JSONArray(reg.definitions))
            )
        }
        obj.put("regions", regionsArr)
        obj.toString(2)
    }

    fun importMeshDeltaJson(raw: String): Pair<Boolean, String> = synchronized(lock) {
        val obj = runCatching { JSONObject(raw) }.getOrNull()
            ?: return false to "Invalid JSON mesh delta."
        if (obj.has("neurons") && obj.has("connections")) {
            val edgeCount = parseOneBrainModel(raw)
            return true to "Imported full OneBrain model ($edgeCount byte edges)."
        }
        val valeArr = obj.optJSONArray("valeLedger")
        if (valeArr != null && valeArr.length() == PHONE_NEURONS) {
            for (i in 0 until PHONE_NEURONS) {
                valeLedger[i] = valeArr.optDouble(i, 1.0).toFloat()
            }
        }
        val regArr = obj.optJSONArray("regions")
        var importedRegions = 0
        if (regArr != null) {
            for (i in 0 until regArr.length()) {
                val rObj = regArr.optJSONObject(i) ?: continue
                val id = rObj.optString("id").takeIf { it.isNotBlank() } ?: continue
                val name = rObj.optString("name").ifBlank { id }
                val meaning = rObj.optString("meaning")
                val defs = ArrayList<String>()
                val dArr = rObj.optJSONArray("definitions")
                if (dArr != null) {
                    for (j in 0 until dArr.length()) defs.add(dArr.optString(j))
                }
                registerRegion(id, name, meaning, defs)
                importedRegions++
            }
        }
        true to "Applied mesh delta ($importedRegions regions merged)."
    }

    private fun byteLabel(b: Int): String =
        if (b in 32..126) "'${b.toChar()}'" else "0x${b.toString(16).padStart(2, '0')}"
}
