package com.example.engine

import com.example.model.YesNoExample
import org.json.JSONArray
import org.json.JSONObject

/** A named region of the mesh, anchored by the hypervector of what it means. */
data class SkillRegion(
    val id: String,
    val name: String,
    val meaning: String,
    val anchor: HDVector,
    val definitions: List<String> = emptyList()
)

/** One consolidated, surprise-gated episodic memory. */
data class MemoryTrace(
    val cue: HDVector,
    val text: String,
    val surprise: Float,
    val timestampMs: Long
)

/**
 * The one OneBrain model.
 *
 * Everything OneBrain has learned or been taught lives here and nowhere else: the pretrained byte
 * graph (hub-routed, see [SynapseGraph]), the growable island mesh ([IslandMesh]: a frozen core, a self island, and one island of neurons
 * per learned skill or memory, with its zero-sum vale ledger), the skill regions, the episodic
 * memories and the yes/no doorway examples. [OneBrainEngine] is the one engine that runs it, and
 * this class is the one place that knows how to load and exchange it (bundled `model.json`, a
 * synced `model.json`, and a mesh delta all go through [loadByteGraph] / [mergeDelta]).
 *
 * Not thread-safe by itself: [OneBrainEngine] guards every access with its lock.
 */
class OneBrainModel {

    companion object {
        /** The frozen pretrained base. The mesh grows past this as islands are born; the base itself never changes. */
        const val CORE_NEURONS = 32
        const val DIMENSIONS = 32

        /** The island mesh is wider than the legacy 32-D vectors: byte n-grams need the room to tell subjects apart. */
        const val MESH_DIMENSIONS = 64
        const val DELTA_FORMAT = "neuroclaw-mesh-delta-v2"
        const val SYNAPSE_FORMAT = "neuroclaw-synapses-v1"
        private val INPUT_EDGE_REGEX = Regex("""^memory_(input|output)_b(\d+)$""")
    }

    /**
     * Hyperdimensional mesh. Grows by islands: new skills and memories get neurons of their own, trained only on
     * their own content, so learning never overwrites what is already there. The zero-sum vale budget is one point
     * per neuron ([IslandMesh.valeTotal]).
     */
    val mesh = IslandMesh(dimensions = MESH_DIMENSIONS, coreNeurons = CORE_NEURONS)

    /**
     * The byte-transition graph. It starts as the pretrained graph re-wired through hubs (not all-to-all), then changes
     * with use: unused connections fade and are deleted, neurons that keep firing together get connected.
     */
    val synapses = SynapseGraph()

    /** Skill regions by id: built-ins, grafted extensions, store skills, corrections and yes/no doorways. */
    val regions = LinkedHashMap<String, SkillRegion>()

    val memoryTraces = ArrayList<MemoryTrace>()
    val yesNoExamples = ArrayList<YesNoExample>()

    /** `modifiedAt` of the loaded OneBrain model file, used to tell whether a synced model is newer. */
    var version: Long = 0L
    var cyclesRun: Int = 0
    var lastSurpriseAvg: Float = 0.18f

    fun registerRegion(
        id: String,
        name: String,
        meaning: String,
        definitions: List<String> = emptyList()
    ) {
        val bytes = "$name $meaning ${definitions.joinToString(" ")}".toByteArray(Charsets.UTF_8)
        regions[id] = SkillRegion(
            id = id,
            name = name,
            meaning = meaning,
            anchor = HDVector.encodeBytes(bytes, DIMENSIONS),
            definitions = definitions
        )
    }

    /**
     * Replaces the byte graph with the one in a OneBrain `model.json`, re-wired through hubs.
     * Returns the number of connections it now has (far fewer than the dense graph in the file).
     */
    fun loadByteGraph(modelJson: String): Int {
        val obj = JSONObject(modelJson)
        version = obj.optLong("modifiedAt", obj.optLong("updatedAt", 0L))

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
        val dense = ArrayList<ByteEdge>()
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
                    dense.add(ByteEdge(from.second, to.second, w))
                }
            }
        }
        synapses.loadDense(dense)
        return synapses.size
    }

    /** Exports the vale ledger and every region as a mesh delta another OneBrain can merge. */
    fun exportDelta(): String {
        val obj = JSONObject()
        obj.put("format", DELTA_FORMAT)
        obj.put("oneBrainVersion", version)
        obj.put("cyclesRun", cyclesRun)
        obj.put("valeLedger", JSONArray().apply { mesh.neurons.forEach { put(it.vale.toDouble()) } })
        obj.put("islands", islandsToJson())
        obj.put("sleeps", mesh.sleeps)
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
        return obj.toString(2)
    }

    /**
     * Merges either a full OneBrain `model.json` (replaces the byte graph) or a mesh delta
     * (applies the vale ledger and merges its regions) into this model.
     */
    fun mergeDelta(raw: String): Pair<Boolean, String> {
        val obj = runCatching { JSONObject(raw) }.getOrNull()
            ?: return false to "Invalid JSON mesh delta."
        if (obj.has("neurons") && obj.has("connections")) {
            val connections = loadByteGraph(raw)
            return true to "Imported full OneBrain model ($connections hub-routed connections)."
        }
        // Islands first (additive: a local island is never replaced), then the ledger only if it fits the grown mesh.
        val importedIslands = obj.optJSONArray("islands")?.let { loadIslands(it) } ?: 0
        val valeArr = obj.optJSONArray("valeLedger")
        val all = mesh.neurons
        if (valeArr != null && valeArr.length() == all.size) {
            for (i in all.indices) all[i].vale = valeArr.optDouble(i, 1.0).toFloat().coerceAtLeast(0.1f)
            mesh.rebalance()
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
        return true to "Applied mesh delta ($importedRegions regions, $importedIslands new islands merged)."
    }

    // ------------------------------------------------------------ synapse persistence

    /** The graph as it has evolved, so growth and pruning survive a restart. Tied to the pretrained model it grew from. */
    fun synapsesToJson(): JSONObject = JSONObject()
        .put("format", SYNAPSE_FORMAT)
        .put("modelVersion", version)
        .put("steps", synapses.steps)
        .put("formed", synapses.totalFormed)
        .put("pruned", synapses.totalPruned)
        .put("neurons", JSONArray(synapses.neuronIds()))
        .put("synapses", JSONArray().apply {
            synapses.all().forEach { put(JSONArray().put(it.from).put(it.to).put(it.weight.toDouble())) }
        })

    /**
     * Restores an evolved graph. Ignored (the freshly loaded pretrained graph stays) when it was grown from a different
     * pretrained model than the one loaded now, or is malformed.
     */
    fun loadSynapses(o: JSONObject): Boolean {
        if (o.optString("format") != SYNAPSE_FORMAT || o.optLong("modelVersion", -1L) != version) return false
        val nArr = o.optJSONArray("neurons") ?: return false
        val sArr = o.optJSONArray("synapses") ?: return false
        val neurons = (0 until nArr.length()).map { nArr.optInt(it, -1) }.filter { it >= 0 }
        val saved = ArrayList<Synapse>()
        for (i in 0 until sArr.length()) {
            val t = sArr.optJSONArray(i) ?: continue
            if (t.length() != 3) continue
            saved.add(Synapse(t.optInt(0, -1), t.optInt(1, -1), t.optDouble(2, 0.0).toFloat()))
        }
        if (neurons.isEmpty()) return false
        synapses.restore(neurons, saved, o.optInt("steps"), o.optInt("formed"), o.optInt("pruned"))
        return true
    }

    // ------------------------------------------------------------ island persistence

    /** The learned islands (skills and memories) with their trained neurons, so growth survives a restart. */
    fun islandsToJson(): JSONArray {
        val arr = JSONArray()
        for (island in mesh.learned()) {
            arr.put(
                JSONObject()
                    .put("id", island.id)
                    .put("kind", island.kind.name)
                    .put("label", island.label)
                    .put("content", island.content)
                    .put("bornCycle", island.bornCycle)
                    .put("bornAtMs", island.bornAtMs)
                    .put("reason", island.reason)
                    .put("reinforcements", island.reinforcements)
                    .put("uses", island.uses)
                    .put("lastUsedCycle", island.lastUsedCycle)
                    .put("dreamRecall", island.dreamRecall.toDouble())
                    .put("neurons", JSONArray().apply {
                        island.neurons.forEach { n ->
                            put(
                                JSONObject()
                                    .put("v", n.vale.toDouble())
                                    .put("s", JSONArray().apply { n.state.data.forEach { put(it.toDouble()) } })
                            )
                        }
                    })
            )
        }
        return arr
    }

    /** Re-adds saved islands. Returns how many were new; ones already here, malformed, or over the cap are skipped. */
    fun loadIslands(arr: JSONArray): Int {
        val bounds = HDVector.computeBounds(MESH_DIMENSIONS)
        var added = 0
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val kind = runCatching { IslandKind.valueOf(o.optString("kind")) }.getOrNull() ?: continue
            val id = o.optString("id").takeIf { it.isNotBlank() } ?: continue
            val nArr = o.optJSONArray("neurons") ?: continue
            val neurons = ArrayList<Neuron>()
            for (j in 0 until nArr.length()) {
                val no = nArr.optJSONObject(j) ?: continue
                val sArr = no.optJSONArray("s") ?: continue
                if (sArr.length() != bounds[4]) continue
                val data = FloatArray(bounds[4]) { k -> sArr.optDouble(k, 0.0).toFloat() }
                neurons.add(Neuron(HDVector(data, bounds).normalized(), no.optDouble("v", 1.0).toFloat().coerceAtLeast(0.1f)))
            }
            if (neurons.isEmpty()) continue
            val island = Island(
                id = id, kind = kind, label = o.optString("label", id), content = o.optString("content"),
                bornCycle = o.optInt("bornCycle"), bornAtMs = o.optLong("bornAtMs"),
                reason = o.optString("reason"), neurons = neurons
            )
            island.reinforcements = o.optInt("reinforcements")
            island.uses = o.optInt("uses")
            island.lastUsedCycle = o.optInt("lastUsedCycle", island.bornCycle)
            island.dreamRecall = o.optDouble("dreamRecall", -1.0).toFloat()
            if (mesh.restoreIsland(island)) added++
        }
        if (added > 0) {
            mesh.rebalance()
            repeat(3) { mesh.refreshSelf() }
        }
        return added
    }

    /** The last sleep, so the self-model remembers its own history after a restart. */
    fun sleepHistoryToJson(): JSONObject {
        val last = mesh.lifeLog.lastOrNull()
        val o = JSONObject().put("sleeps", mesh.sleeps)
        if (last != null) {
            o.put("last", JSONObject()
                .put("cycle", last.cycle).put("episodes", last.episodes)
                .put("newIslands", JSONArray(last.newIslands)).put("reinforcedIslands", JSONArray(last.reinforcedIslands))
                .put("neuronsAdded", last.neuronsAdded).put("neuronsPruned", last.neuronsPruned)
                .put("islandsForgotten", JSONArray(last.islandsForgotten)).put("neuronCount", last.neuronCount)
                .apply {
                    last.dream?.let { d ->
                        put("dream", JSONObject().put("cues", d.cues).put("before", d.recallBefore.toDouble())
                            .put("after", d.recallAfter.toDouble()).put("rehearsed", d.rehearsed))
                    }
                })
        }
        return o
    }

    fun loadSleepHistory(o: JSONObject) {
        fun strings(a: JSONArray?) = (0 until (a?.length() ?: 0)).map { a!!.optString(it) }
        val last = o.optJSONObject("last")?.let { l ->
            SleepReport(
                cycle = l.optInt("cycle"), episodes = l.optInt("episodes"),
                newIslands = strings(l.optJSONArray("newIslands")), reinforcedIslands = strings(l.optJSONArray("reinforcedIslands")),
                neuronsAdded = l.optInt("neuronsAdded"), neuronsPruned = l.optInt("neuronsPruned"),
                islandsForgotten = strings(l.optJSONArray("islandsForgotten")),
                dream = l.optJSONObject("dream")?.let { d ->
                    DreamReport(d.optInt("cues"), d.optDouble("before").toFloat(), d.optDouble("after").toFloat(), d.optInt("rehearsed"))
                },
                neuronCount = l.optInt("neuronCount")
            )
        }
        mesh.restoreHistory(o.optInt("sleeps"), last)
    }
}
