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
import java.io.File
import java.util.UUID
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.tanh

/**
 * The one OneBrain engine. It runs the one [OneBrainModel] (the only place any state lives) in pure Kotlin:
 * - Reads bundled `assets/onebrain/model.json` (`memory_input_b*` -> `memory_output_b*` edges)
 * - Runs raw UTF-8 byte-level Zip Loop projection (no tokenizer)
 * - Maintains a growable Hyperdimensional Mesh of islands (a frozen 32-neuron core, a self island, and one island
 *   per learned skill or memory) with zero-sum Vale conservation. It learns in two phases: awake it only reads and
 *   remembers what is new; asleep ([sleepNow], or automatically once enough new experience has built up) it grows
 *   islands of new neurons trained on that experience, prunes, and dreams (see [IslandMesh]).
 * - Supports NetSkillRouter over grafted NeuroLang extensions and Yes/No doorways
 * - Tracks surprise-gated associative memories and self-improvement drills
 */
class OneBrainEngine(private val context: Context) {

    data class ChatTurnOutput(
        val reply: String,
        val recalledBytes: List<String>,
        val activeRegions: List<String>,
        val cycleMs: Long,
        val surpriseScore: Float,
        val hiveVotes: List<HiveVote> = emptyList(),
        /** Learned islands that recognised this message, best first. */
        val activeIslands: List<String> = emptyList(),
        /** Set when this turn ended in a sleep (the brain had enough new experience to want one, or was asked to). */
        val sleepReport: SleepReport? = null
    )

    companion object {
        /** The frozen pretrained core. The live mesh is bigger once islands have grown: see [OneBrainEngine.neuronCount]. */
        const val CORE_NEURONS = OneBrainModel.CORE_NEURONS
        /** What low-power mode scales: the frozen core, the one fixed-size part of the mesh (learned islands add to it). */
        const val PHONE_NEURONS = OneBrainModel.CORE_NEURONS
        const val PHONE_DIMENSIONS = OneBrainModel.DIMENSIONS
        const val MESH_DIMENSIONS = OneBrainModel.MESH_DIMENSIONS
        private const val INFLUENCE_DECAY = 0.95f
        private const val ISLANDS_FILE = "onebrain_islands.json"
        private const val SYNAPSES_FILE = "onebrain_synapses.json"

        /** The synapse graph is saved when its shape changes, and otherwise at least this often (weights drift every turn). */
        private const val SYNAPSE_SAVE_EVERY = 10

        /** Chat only mentions a yes/no doorway whose examples resemble the message at least this much. */
        private const val YES_NO_HINT_MIN_SIMILARITY = 0.25f
    }

    private val lock = Any()
    val deviceTools = DeviceTools(context)

    /** The one model: every piece of state this engine reads or learns lives in here. */
    private val brain = OneBrainModel()

    val oneBrainVersion: Long get() = brain.version

    /** Low power mode: fewer neurons run when the battery is low and unplugged (threshold adapts to use). */
    private val lowPower = LowPowerGovernor(PHONE_NEURONS)

    val isLowPower: Boolean get() = lowPower.active

    private fun lowPowerNeuronCount(): Int {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as? android.os.BatteryManager
            ?: return PHONE_NEURONS
        val level = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
        if (level < 0) return PHONE_NEURONS
        return lowPower.activeNeurons(level / 100f, bm.isCharging, System.currentTimeMillis())
    }
    /** Neurons in the live mesh: the frozen core, the self island and every learned island. */
    val neuronCount: Int get() = synchronized(lock) { brain.mesh.neuronCount }

    init {
        loadBundledOneBrain()
        loadSynapsesFromDisk()
        registerDefaultRegions()
        loadIslandsFromDisk()
    }

    // ------------------------------------------------------------------ growth persistence

    private val islandsFile get() = File(context.filesDir, ISLANDS_FILE)

    /** Learning that vanished on restart would be no self at all: islands and the sleep history are saved as they change. */
    private fun persistIslands() {
        runCatching {
            val o = JSONObject().put("islands", brain.islandsToJson()).put("history", brain.sleepHistoryToJson())
            islandsFile.writeText(o.toString())
        }
    }

    private fun loadIslandsFromDisk() {
        val raw = runCatching { islandsFile.takeIf { it.exists() }?.readText() }.getOrNull() ?: return
        val o = runCatching { JSONObject(raw) }.getOrNull() ?: return
        o.optJSONArray("islands")?.let { brain.loadIslands(it) }
        o.optJSONObject("history")?.let { brain.loadSleepHistory(it) }
    }

    private val synapsesFile get() = File(context.filesDir, SYNAPSES_FILE)

    /** The byte graph changes with use (connections fade, delete and grow), so what it became is saved. */
    private fun persistSynapses() {
        runCatching { synapsesFile.writeText(brain.synapsesToJson().toString()) }
    }

    /** Picks the evolved graph back up, if it grew from the same pretrained model that is loaded now. */
    private fun loadSynapsesFromDisk() {
        val raw = runCatching { synapsesFile.takeIf { it.exists() }?.readText() }.getOrNull() ?: return
        val o = runCatching { JSONObject(raw) }.getOrNull() ?: return
        brain.loadSynapses(o)
    }

    private fun loadBundledOneBrain() {
        val raw = runCatching {
            context.assets.open("onebrain/model.json").bufferedReader().use { it.readText() }
        }.getOrNull() ?: return
        brain.loadByteGraph(raw)
    }

    /** Loads a (synced) pretrained model: the byte graph is rebuilt from it, hub-routed, replacing whatever grew before. */
    fun parseOneBrainModel(modelJson: String): Int = synchronized(lock) {
        brain.loadByteGraph(modelJson).also { persistSynapses() }
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
        brain.registerRegion(id, name, meaning, definitions)
    }

    fun unregisterRegion(id: String) = synchronized(lock) {
        brain.regions.remove(id)
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
        // A new skill gets an island of its own: neurons born for this skill and trained only on its content.
        // Nothing already in the mesh is touched, so it cannot overwrite anything. Re-grafting the same, unchanged
        // extension (every app start) is a no-op; an edited one retrains its own island in place.
        synchronized(lock) {
            val id = "skill:ext:${ext.id}"
            val before = brain.mesh.islands[id]?.contentHash
            val teachers = ArrayList<String>()
            teachers.add("${ext.name}. $meaning")
            teachers.addAll(defs)
            ext.code.trim().take(1200).takeIf { it.isNotEmpty() }?.let { teachers.add(it) }
            val island = brain.mesh.learnNow(
                id = id, kind = IslandKind.SKILL, label = ext.name, teachers = teachers,
                reason = "grafted extension", cycle = brain.cyclesRun, nowMs = System.currentTimeMillis()
            )
            if (island != null && island.contentHash != before) persistIslands()
        }
    }

    fun recallBytes(text: String, topK: Int = 5): List<String> = synchronized(lock) {
        if (brain.synapses.size == 0) return emptyList()
        return brain.synapses.recall(distinctBytes(text), topK).map { byteLabel(it) }
    }

    private fun distinctBytes(text: String): Set<Int> =
        text.toByteArray(Charsets.UTF_8).mapTo(HashSet()) { it.toInt() and 0xFF }

    fun selectRegions(text: String, topK: Int = 3): List<SkillRegion> = synchronized(lock) {
        val inputVec = HDVector.encodeBytes(text.toByteArray(Charsets.UTF_8), PHONE_DIMENSIONS)
        val lower = text.lowercase()
        return brain.regions.values
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
        val mesh = brain.mesh
        val lower = message.trim().lowercase()

        // Keeps the low-power governor's battery history current (it backs [isLowPower]). Nothing is mixed into any
        // neuron here any more: awake, chat only reads and routes, and learning happens in sleep.
        lowPowerNeuronCount()

        // WAKE: the islands that recognise this message are routed to, and anything new to me is remembered for
        // sleep. No neuron changes while awake, so a chat can never overwrite what the mesh already knows.
        val routed = mesh.wake(message, brain.cyclesRun, System.currentTimeMillis())
        val islandVec = mesh.encode(message)

        // Surprise = how unfamiliar this is to everything learned so far (1.0 until anything has been learned).
        val surprise = mesh.novelty(islandVec).coerceIn(0.02f, 0.98f)
        brain.lastSurpriseAvg = brain.lastSurpriseAvg * INFLUENCE_DECAY + surprise * (1f - INFLUENCE_DECAY)
        if (surprise > 0.28f || brain.memoryTraces.size < 4) {
            if (brain.memoryTraces.size >= 64) brain.memoryTraces.removeAt(0)
            brain.memoryTraces.add(MemoryTrace(inputVec, message.trim(), surprise, System.currentTimeMillis()))
        }

        // Zero-sum vale transfer: use makes the winning neuron more stable. Only vale moves, never a weight.
        val winner = routed.firstOrNull()?.first?.neurons?.maxByOrNull { HDVector.cosineSimilarity(islandVec, it.state) }
            ?: mesh.core.neurons.maxByOrNull { HDVector.cosineSimilarity(islandVec, it.state) }
        if (winner != null) mesh.redistributeVale(winner, delta = 0.08f)

        val matchedRegions = selectRegions(message)
        val recalled = recallBytes(message)
        // Answered from the graph as it was; now the graph itself moves on: connections that were used together
        // strengthen, the rest fade (and are deleted at ~0), neurons that keep firing together get connected.
        val synapseStep = brain.synapses.step(distinctBytes(message))
        if (synapseStep.changedStructure || brain.synapses.steps % SYNAPSE_SAVE_EVERY == 0) persistSynapses()
        brain.cyclesRun++

        // Recall closest prior episodic memory if relevant
        val closestMemory = brain.memoryTraces
            .filter { it.text != message.trim() }
            .map { it to HDVector.cosineSimilarity(inputVec, it.cue) }
            .filter { it.second > 0.38f }
            .maxByOrNull { it.second }

        val yesNoHint = findBestYesNoMatch(message)
        val toolResult = deviceTools.tryHandleToolPrompt(message)
        val hiveVotes = if (hiveMode) evaluateHiveConsensus(message, matchedRegions, surprise) else emptyList()

        // SLEEP: asked for outright, or the brain has built up enough new experience that it wants to. Done after the
        // routing above so this message is still answered from what was known when it arrived.
        val askedToSleep = lower == "sleep" || lower.contains("go to sleep") || lower.contains("consolidate")
        val sleepReport = if (askedToSleep || mesh.shouldSleep()) {
            mesh.sleep(brain.cyclesRun, System.currentTimeMillis()).also { persistIslands() }
        } else null

        val reply = synthesizeReply(
            message = message,
            matchedRegions = matchedRegions,
            recalled = recalled,
            surprise = surprise,
            closestMemory = closestMemory?.first?.text,
            yesNoHint = yesNoHint,
            toolResult = toolResult,
            hiveVotes = hiveVotes,
            routed = routed,
            sleepReport = sleepReport,
            askedToSleep = askedToSleep
        )
        val elapsedMs = max(1L, (System.nanoTime() - started) / 1_000_000L)

        ChatTurnOutput(
            reply = reply,
            recalledBytes = recalled,
            activeRegions = matchedRegions.map { it.name },
            cycleMs = elapsedMs,
            surpriseScore = surprise,
            hiveVotes = hiveVotes,
            activeIslands = routed.map { it.first.label },
            sleepReport = sleepReport
        )
    }

    /** Sleep on demand: consolidate what is waiting into islands, prune, dream, and refresh the self-model. */
    fun sleepNow(): SleepReport = synchronized(lock) {
        brain.mesh.sleep(brain.cyclesRun, System.currentTimeMillis()).also { persistIslands() }
    }

    /** The brain reading its own state back (neurons, islands, newest, most used, last sleep, what is waiting). */
    fun describeSelf(): String = synchronized(lock) { brain.mesh.describeSelf(brain.lastSurpriseAvg) }

    private fun evaluateHiveConsensus(
        message: String,
        matchedRegions: List<SkillRegion>,
        surprise: Float
    ): List<HiveVote> {
        val msgVec = HDVector.encodeBytes(message.toByteArray(Charsets.UTF_8), PHONE_DIMENSIONS)
        val meshVec = brain.mesh.encode(message)
        val personas = listOf(
            "Planner" to "decompose into structured actions",
            "Coder" to "verify invariants and syntax paths",
            "Critic" to "check edge cases and mistake guards",
            "DeviceOps" to "route permissions and Android hardware tools",
            "MemoryWeaver" to "bind associative traces across ${brain.memoryTraces.size} cues"
        )
        return personas.mapIndexed { idx, (name, role) ->
            val pVec = HDVector.encodeBytes("$name $role".toByteArray(Charsets.UTF_8), PHONE_DIMENSIONS)
            val neuronSim = HDVector.cosineSimilarity(meshVec, brain.mesh.neurons[(idx * 5) % brain.mesh.neuronCount].state)
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

    /**
     * The one yes/no scorer: every example votes with its similarity to the input, so the same
     * examples and input give the same verdict whether Chat's doorway hint or the Trainer asks.
     */
    private class YesNoTally(val pos: Float, val neg: Float) {
        val total: Float get() = pos + neg
        val answer: Boolean get() = pos >= neg
        val confidence: Float get() = (abs(pos - neg) / max(1e-5f, total)).coerceIn(0.5f, 0.99f)
    }

    private fun tallyYesNo(examples: List<YesNoExample>, qVec: HDVector): YesNoTally {
        var pos = 0f
        var neg = 0f
        for (ex in examples) {
            val eVec = HDVector.encodeBytes(ex.text.toByteArray(Charsets.UTF_8), PHONE_DIMENSIONS)
            val sim = max(0f, HDVector.cosineSimilarity(qVec, eVec))
            if (ex.answer) pos += sim else neg += sim
        }
        return YesNoTally(pos, neg)
    }

    private fun findBestYesNoMatch(text: String): YesNoQueryResult? {
        if (brain.yesNoExamples.isEmpty()) return null
        val qVec = HDVector.encodeBytes(text.toByteArray(Charsets.UTF_8), PHONE_DIMENSIONS)
        val grouped = brain.yesNoExamples.groupBy { it.question }
        var best: YesNoQueryResult? = null
        var bestStrength = 0f
        for ((q, list) in grouped) {
            val tally = tallyYesNo(list, qVec)
            if (tally.total > YES_NO_HINT_MIN_SIMILARITY && tally.total > bestStrength) {
                bestStrength = tally.total
                best = YesNoQueryResult(q, tally.answer, tally.confidence, list.size)
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
        hiveVotes: List<HiveVote>,
        routed: List<Pair<Island, Float>> = emptyList(),
        sleepReport: SleepReport? = null,
        askedToSleep: Boolean = false
    ): String {
        val lower = message.trim().lowercase()
        val isSelfQuestion = listOf(
            "who are you", "about yourself", "sense of self", "what have you learned", "what did you learn",
            "what do you know", "what are you made of", "describe yourself", "your neurons", "your islands"
        ).any { lower.contains(it) }
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

        if (askedToSleep && sleepReport != null) {
            return buildString {
                append(sleepReport.summary())
                append("\n\n[[ask: Who are you now? | Describe yourself]]")
            }
        }
        if (isSelfQuestion) {
            return buildString {
                append(brain.mesh.describeSelf(brain.lastSurpriseAvg))
                append("\n\n[[ask: Go to sleep | sleep]] [[ask: Mesh stats | What is the current mesh and vale state?]]")
            }
        }

        return buildString {
            when {
                lower.contains("hello") || lower == "hi" || lower.startsWith("hey") -> {
                    append("OneBrain mesh is awake on this device (${brain.synapses.size} connections routed through ${brain.synapses.hubCount} hubs, ${brain.regions.size} active skill regions). ")
                    append("Every character you send enters through the Zip Loop as raw UTF-8 bytes without a tokenizer.")
                    append("\n\n[[ask: Inspect mesh stats | What is the current mesh and vale state?]]")
                    append(" [[ask: Audit permissions | tool: permission_audit]]")
                    append(" [[put: Pin Audit | tool: permission_audit | desktop]]")
                }
                lower.contains("vale") || lower.contains("mesh") || lower.contains("stat") -> {
                    val totalVale = brain.mesh.neurons.sumOf { it.vale.toDouble() }.toFloat()
                    append("Mesh state: ${brain.mesh.neuronCount} hyper-neurons x $MESH_DIMENSIONS dims in ${brain.mesh.islands.size} islands ")
                    append("(${brain.mesh.learned().size} learned), ")
                    append("${brain.synapses.size} OneBrain byte connections through ${brain.synapses.hubCount} hubs ")
                    append("(${brain.synapses.totalFormed} grown, ${brain.synapses.totalPruned} pruned so far), ")
                    append("Vale budget conserved at ${"%.2f".format(totalVale)}/${"%.2f".format(brain.mesh.valeTotal)}. ")
                    append("Cycle surprise is ${"%.2f".format(surprise)} across ${brain.memoryTraces.size} consolidated traces.")
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
                    append("Currently holding ${brain.yesNoExamples.size} local training example(s).")
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
                    routed.firstOrNull()?.let { (island, sim) ->
                        append("\nIsland recall [${island.label}] (${"%.2f".format(sim)}): ${island.content.lineSequence().first().take(160)}")
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
            if (sleepReport != null) append("\n\n[slept] ${sleepReport.summary()}")
        }
    }

    fun teachYesNo(question: String, text: String, answer: Boolean): YesNoQueryResult = synchronized(lock) {
        val cleanQ = question.trim()
        val cleanT = text.trim()
        brain.yesNoExamples.add(YesNoExample(cleanQ, cleanT, answer))
        registerRegion(
            id = "yes-no:${cleanQ.lowercase()}",
            name = cleanQ,
            meaning = "Yes/No doorway for $cleanQ",
            definitions = listOf(cleanT)
        )
        askYesNo(cleanQ, cleanT)
    }

    fun askYesNo(question: String, text: String): YesNoQueryResult = synchronized(lock) {
        val matching = brain.yesNoExamples.filter { it.question.equals(question.trim(), ignoreCase = true) }
        val qVec = HDVector.encodeBytes(text.toByteArray(Charsets.UTF_8), PHONE_DIMENSIONS)
        val tally = tallyYesNo(matching, qVec)
        // No example, or none that resembles the input at all, is no evidence: answer No at the 0.5 floor.
        if (tally.total <= 1e-5f) {
            return YesNoQueryResult(question, answer = false, confidence = 0.5f, matchedExamples = matching.size)
        }
        YesNoQueryResult(question, tally.answer, tally.confidence, matching.size)
    }

    fun loadYesNoExamples(examples: List<YesNoExample>) = synchronized(lock) {
        brain.yesNoExamples.clear()
        brain.yesNoExamples.addAll(examples)
        examples.map { it.question }.distinct().forEach { q ->
            registerRegion("yes-no:${q.lowercase()}", q, "Yes/No doorway for $q")
        }
    }

    fun listYesNoQuestions(): List<String> = synchronized(lock) {
        brain.yesNoExamples.map { it.question }.distinct()
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
                val sum = brain.mesh.neurons.sumOf { it.vale.toDouble() }.toFloat()
                val ok = abs(sum - brain.mesh.valeTotal) < 0.05f
                ok to "Vale sum=${"%.3f".format(sum)} (expected ${brain.mesh.valeTotal})"
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
        val valeSum = brain.mesh.neurons.sumOf { it.vale.toDouble() }.toFloat()
        val valeTotal = brain.mesh.valeTotal
        val valeOk = abs(valeSum - valeTotal) < 0.1f
        if (!valeOk) brain.mesh.rebalance()
        val normOk = brain.mesh.neurons.all { abs(it.state.norm() - 1f) < 0.05f }
        if (!normOk) {
            for (n in brain.mesh.neurons) n.state = n.state.normalized()
        }
        listOf(
            HealingCheck(
                component = "OneBrain Byte Graph",
                healthy = brain.synapses.size > 0,
                detail = "${brain.synapses.size} hub-routed byte connections loaded (v$oneBrainVersion)"
            ),
            HealingCheck(
                component = "Vale Zero-Sum Ledger",
                healthy = true,
                detail = if (valeOk) "Conserved at ${"%.2f".format(valeSum)}" else "Rebalanced to $valeTotal"
            ),
            HealingCheck(
                component = "Hyperdimensional Manifold",
                healthy = true,
                detail = if (normOk) "All ${brain.mesh.neuronCount} vectors unit-normalized" else "Renormalized drift vectors"
            ),
            HealingCheck(
                component = "Island Mesh",
                healthy = true,
                detail = "${brain.mesh.learned().size} learned islands, ${brain.mesh.neuronCount} neurons, ${brain.mesh.sleeps} sleeps, ${brain.mesh.shortTerm.size} experiences awaiting sleep"
            ),
            HealingCheck(
                component = "Extension & Skill Regions",
                healthy = true,
                detail = "${brain.regions.size} active regions ($extensionCount user-built)"
            )
        )
    }

    fun snapshot(
        unsyncedTurns: Int,
        unsyncedExamples: Int,
        pendingPhotos: Int,
        lastSyncMs: Long
    ): MeshStatsSnapshot = synchronized(lock) {
        val sum = brain.mesh.neurons.sumOf { it.vale.toDouble() }.toFloat()
        MeshStatsSnapshot(
            neuronCount = brain.mesh.neuronCount,
            dimensions = MESH_DIMENSIONS,
            oneBrainEdges = brain.synapses.size,
            oneBrainVersion = oneBrainVersion,
            activeRegions = brain.regions.values.map { it.name },
            valeTotal = sum,
            valeConserved = abs(sum - brain.mesh.valeTotal) < 0.1f,
            valeBudget = brain.mesh.valeTotal,
            islandCount = brain.mesh.islands.size,
            learnedIslands = brain.mesh.learned().size,
            sleeps = brain.mesh.sleeps,
            pendingExperiences = brain.mesh.shortTerm.size,
            averageSurprise = brain.lastSurpriseAvg,
            memoryEntries = brain.memoryTraces.size,
            cyclesRun = brain.cyclesRun,
            unsyncedTurns = unsyncedTurns,
            unsyncedExamples = unsyncedExamples,
            pendingPhotos = pendingPhotos,
            lastSyncMs = lastSyncMs
        )
    }

    fun getValeDistribution(): List<Float> = synchronized(lock) {
        brain.mesh.neurons.map { it.vale }
    }

    fun recordMistake(mistake: MistakeRecord) = synchronized(lock) {
        val corrVec = HDVector.encodeBytes(mistake.correction.toByteArray(Charsets.UTF_8), PHONE_DIMENSIONS)
        if (brain.memoryTraces.size >= 64) brain.memoryTraces.removeAt(0)
        brain.memoryTraces.add(MemoryTrace(corrVec, mistake.correction, 0.92f, mistake.timestampMs))
        registerRegion(
            id = "mistake:${mistake.id.take(8)}",
            name = "Correction",
            meaning = mistake.prompt,
            definitions = listOf("Prefer: ${mistake.correction}")
        )
        // A correction is deliberate teaching: it gets an island of its own instead of being blended into a neuron
        // that already knows something else. Unchanged corrections re-applied at startup are a no-op.
        val id = "mistake:${mistake.id.take(8)}"
        val before = brain.mesh.islands[id]?.contentHash
        val island = brain.mesh.learnNow(
            id = id, kind = IslandKind.MEMORY, label = "Correction: ${mistake.prompt.trim().take(32)}",
            teachers = listOf("${mistake.prompt} -> ${mistake.correction}", mistake.correction),
            reason = "corrected mistake", cycle = brain.cyclesRun, nowMs = mistake.timestampMs
        )
        if (island != null && island.contentHash != before) persistIslands()
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
            val vales = brain.mesh.neurons.map { it.vale }
            val spread = (vales.maxOrNull() ?: 1f) - (vales.minOrNull() ?: 1f)
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
        brain.synapses.all()
            .sortedByDescending { abs(it.weight) }
            .take(limit)
            .map { e -> ByteEdgePreview(nodeLabel(e.from), nodeLabel(e.to), e.weight) }
    }

    fun captureCheckpoint(label: String): BrainCheckpoint = synchronized(lock) {
        BrainCheckpoint(
            id = UUID.randomUUID().toString(),
            label = label.ifBlank { "Checkpoint #${brain.cyclesRun}" },
            edgesCount = brain.synapses.size,
            valeTotal = brain.mesh.neurons.sumOf { it.vale.toDouble() }.toFloat(),
            memoriesCount = brain.memoryTraces.size,
            valeSnapshot = brain.mesh.neurons.map { it.vale }
        )
    }

    fun restoreCheckpoint(cp: BrainCheckpoint): Boolean = synchronized(lock) {
        // The mesh only grows, so a checkpoint taken earlier is a prefix of today's neurons (core, self, then islands in
        // birth order). Restore that prefix; neurons born since keep their vale. A checkpoint of a bigger mesh cannot apply.
        val all = brain.mesh.neurons
        if (cp.valeSnapshot.isEmpty() || cp.valeSnapshot.size > all.size) return false
        for (i in cp.valeSnapshot.indices) all[i].vale = cp.valeSnapshot[i].coerceAtLeast(0.1f)
        brain.mesh.rebalance()
        true
    }

    fun exportMeshDeltaJson(): String = synchronized(lock) {
        brain.exportDelta()
    }

    fun importMeshDeltaJson(raw: String): Pair<Boolean, String> = synchronized(lock) {
        brain.mergeDelta(raw)
    }

    private fun byteLabel(b: Int): String =
        if (b in 32..126) "'${b.toChar()}'" else "0x${b.toString(16).padStart(2, '0')}"

    private fun nodeLabel(node: Int): String =
        if (Nodes.role(node) == NodeRole.HUB) "hub ${Nodes.hubIndex(node)}" else byteLabel(Nodes.byteOf(node))
}
