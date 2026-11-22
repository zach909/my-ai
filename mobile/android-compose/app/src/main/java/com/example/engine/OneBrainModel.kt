package com.example.engine

import com.example.model.YesNoExample
import org.json.JSONArray
import org.json.JSONObject

/** One learned byte transition from the pretrained OneBrain graph (`memory_input_b*` -> `memory_output_b*`). */
data class ByteEdge(val fromByte: Int, val toByte: Int, val weight: Float)

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
 * graph, the hyperdimensional mesh and its zero-sum vale ledger, the skill regions, the episodic
 * memories and the yes/no doorway examples. [OneBrainEngine] is the one engine that runs it, and
 * this class is the one place that knows how to load and exchange it (bundled `model.json`, a
 * synced `model.json`, and a mesh delta all go through [loadByteGraph] / [mergeDelta]).
 *
 * Not thread-safe by itself: [OneBrainEngine] guards every access with its lock.
 */
class OneBrainModel {

    companion object {
        const val NEURONS = 32
        const val DIMENSIONS = 32
        const val VALE_TOTAL = 32.0f
        const val DELTA_FORMAT = "neuroclaw-mesh-delta-v1"
        private val INPUT_EDGE_REGEX = Regex("""^memory_(input|output)_b(\d+)$""")
    }

    /** Hyperdimensional mesh: one state vector per hyper-neuron. */
    val neuronStates = Array(NEURONS) { idx ->
        HDVector.random(DIMENSIONS, seed = 1000L + idx * 37L)
    }

    /** Zero-sum plasticity budget over the mesh; always sums to [VALE_TOTAL]. */
    val valeLedger = FloatArray(NEURONS) { VALE_TOTAL / NEURONS }

    /** Pretrained byte-transition graph. */
    val byteEdges = ArrayList<ByteEdge>()

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

    /** Replaces the byte graph with the one in a OneBrain `model.json`. Returns the edge count. */
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
        return byteEdges.size
    }

    /** Exports the vale ledger and every region as a mesh delta another OneBrain can merge. */
    fun exportDelta(): String {
        val obj = JSONObject()
        obj.put("format", DELTA_FORMAT)
        obj.put("oneBrainVersion", version)
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
            val edgeCount = loadByteGraph(raw)
            return true to "Imported full OneBrain model ($edgeCount byte edges)."
        }
        val valeArr = obj.optJSONArray("valeLedger")
        if (valeArr != null && valeArr.length() == NEURONS) {
            for (i in 0 until NEURONS) {
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
        return true to "Applied mesh delta ($importedRegions regions merged)."
    }
}
