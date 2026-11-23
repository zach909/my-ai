package com.example.engine

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt

/** One learned byte transition from the pretrained OneBrain graph (`memory_input_b*` -> `memory_output_b*`). */
data class ByteEdge(val fromByte: Int, val toByte: Int, val weight: Float)

/** Layers, in the order a signal travels: bytes in, hubs, bytes out. */
enum class NodeRole { INPUT, HUB, OUTPUT }

/** Node ids: input byte b is `b`, output byte b is `256 + b`, hub h is `512 + h`. */
object Nodes {
    const val OUTPUT_BASE = 256
    const val HUB_BASE = 512
    fun input(b: Int) = b
    fun output(b: Int) = OUTPUT_BASE + b
    fun hub(h: Int) = HUB_BASE + h
    fun role(id: Int): NodeRole = when {
        id >= HUB_BASE -> NodeRole.HUB
        id >= OUTPUT_BASE -> NodeRole.OUTPUT
        else -> NodeRole.INPUT
    }
    /** The byte an input or output node stands for, or -1 for a hub. */
    fun byteOf(id: Int): Int = when { id >= HUB_BASE -> -1; id >= OUTPUT_BASE -> id - OUTPUT_BASE; else -> id }
    fun hubIndex(id: Int): Int = id - HUB_BASE
}

/** One directed connection. A weight near zero carries nothing, so a connection that fades to it is deleted. */
class Synapse(val from: Int, val to: Int, var weight: Float)

data class SynapseStepReport(val formed: Int, val pruned: Int, val strengthened: Int) {
    val changedStructure: Boolean get() = formed > 0 || pruned > 0
}

/**
 * OneBrain's byte graph, wired like a brain rather than like a spreadsheet: not everything connects to everything.
 *
 * SHAPE. Byte neurons do not link to each other directly. They link to a handful of hubs, and signals route
 * input byte -> hub -> output byte. [loadDense] turns the pretrained all-to-all graph into that shape: it finds the
 * few directions that carry most of the signal (low-rank factors, one per hub) and attaches each byte neuron to only
 * the [HUBS_PER_LEAF] hubs it leans on most. On the bundled model that is 105 connections instead of 338, and the
 * top-5 recall overlaps the original's by 0.84 on 3-8 byte messages (0.68 on single bytes). The cost is real: this is
 * a compression, so some of the pretrained detail is gone from the start.
 *
 * FADE. A connection that is not confirmed by its two ends being active together loses [DECAY] of its weight per
 * step, and one that falls below [PRUNE_BELOW] is a multiply-by-nothing, so it is deleted. Neurons are never deleted,
 * only connections, so a neuron can always grow new ones.
 *
 * GROW. Two neurons that are both strongly active in the same step [FORM_AFTER] times get a connection (same
 * sign of activity: excitatory; opposite sign: inhibitory, a negative weight). Neurons that are already wired
 * together through a hub in the right sense do not get a second, direct link: on the real graph that rule is what
 * stopped 68 of the first 76 new links being direct byte-to-byte shortcuts. Neurons on the same layer cannot link
 * directly, so they are tied together *through a hub*. A byte neuron holds at most [MAX_LEAF_DEGREE] connections, so a
 * full neuron only takes a new connection by dropping a weaker one.
 *
 * Pure Kotlin, no Android types. Not thread-safe; [OneBrainEngine] guards it with its lock.
 */
class SynapseGraph(val hubCount: Int = HUB_COUNT) {
    companion object {
        const val HUB_COUNT = 4
        const val HUBS_PER_LEAF = 2

        /** A neuron counts as strongly active when its activity, relative to the busiest neuron of its layer, is at least this. */
        const val HIGH = 0.5f

        /** Strongly active together (or strongly opposite) this many times before a connection is generated. */
        const val FORM_AFTER = 3

        /** Co-activity evidence not renewed for this many steps is forgotten. */
        const val FORM_WINDOW_STEPS = 200
        const val INITIAL_WEIGHT = 0.2f

        /** At or below this a connection is multiplying by nothing and is deleted. */
        const val PRUNE_BELOW = 0.02f
        const val HEBB_RATE = 0.05f
        const val DECAY = 0.005f
        const val WEIGHT_MAX = 2f
        const val MAX_LEAF_DEGREE = 8
        const val MAX_TRACKED_PAIRS = 2048
        private const val POWER_ITERATIONS = 200

        private fun key(from: Int, to: Int): Long = (from.toLong() shl 32) or to.toLong()
        private fun sign(x: Float): Float = if (x < 0f) -1f else 1f
    }

    private val synapses = LinkedHashMap<Long, Synapse>()

    /** Input and output byte neurons that exist. Hubs always exist. Sorted so every walk over them is deterministic. */
    private val leaves = java.util.TreeSet<Int>()

    private class Tally(var same: Int = 0, var opposite: Int = 0, var lastStep: Int = 0)
    private val tallies = HashMap<Long, Tally>()

    var steps = 0
        private set
    var totalFormed = 0
        private set
    var totalPruned = 0
        private set

    val size: Int get() = synapses.size
    fun neuronIds(): List<Int> = leaves.toList()

    /** Copies, so callers cannot change a weight behind the graph's back. */
    fun all(): List<Synapse> = synapses.values.map { Synapse(it.from, it.to, it.weight) }

    fun weight(from: Int, to: Int): Float? = synapses[key(from, to)]?.weight

    fun degree(node: Int): Int = synapses.values.count { it.from == node || it.to == node }

    fun hasNeuron(id: Int): Boolean =
        if (Nodes.role(id) == NodeRole.HUB) Nodes.hubIndex(id) in 0 until hubCount else id in leaves

    fun addNeuron(id: Int) {
        if (Nodes.role(id) != NodeRole.HUB && id >= 0) leaves.add(id)
    }

    fun clear() {
        synapses.clear(); leaves.clear(); tallies.clear()
        steps = 0; totalFormed = 0; totalPruned = 0
    }

    // ------------------------------------------------------------------ building

    /** A signal only travels forward: byte in -> hub -> byte out, hubs in index order. */
    private fun legal(from: Int, to: Int): Boolean {
        val f = Nodes.role(from)
        val t = Nodes.role(to)
        return when {
            f == NodeRole.INPUT -> t == NodeRole.HUB || t == NodeRole.OUTPUT
            f == NodeRole.HUB -> t == NodeRole.OUTPUT || (t == NodeRole.HUB && Nodes.hubIndex(from) < Nodes.hubIndex(to))
            else -> false
        }
    }

    /** Adds or replaces a connection. Refused when the direction is wrong, a neuron is missing, or the weight is nothing. */
    fun connect(from: Int, to: Int, weight: Float): Boolean {
        if (!legal(from, to) || !hasNeuron(from) || !hasNeuron(to)) return false
        if (!weight.isFinite() || abs(weight) < PRUNE_BELOW) return false
        synapses[key(from, to)] = Synapse(from, to, weight.coerceIn(-WEIGHT_MAX, WEIGHT_MAX))
        return true
    }

    /** Restores a saved graph exactly as it was (no re-wiring, no step). */
    fun restore(neuronIds: Collection<Int>, saved: List<Synapse>, steps: Int, formed: Int, pruned: Int) {
        clear()
        for (id in neuronIds) addNeuron(id)
        for (s in saved) {
            if (Nodes.role(s.from) != NodeRole.HUB) addNeuron(s.from)
            if (Nodes.role(s.to) != NodeRole.HUB) addNeuron(s.to)
            connect(s.from, s.to, s.weight)
        }
        this.steps = steps; totalFormed = formed; totalPruned = pruned
    }

    /**
     * Replaces everything with the hub-routed version of a dense byte -> byte graph (the pretrained one).
     * Each hub is one low-rank factor of the dense weight matrix; each byte neuron keeps only its strongest hubs.
     */
    fun loadDense(edges: List<ByteEdge>) {
        clear()
        val valid = edges.filter { it.fromByte in 0..255 && it.toByte in 0..255 && it.weight.isFinite() }
        if (valid.isEmpty()) return
        val ins = valid.map { it.fromByte }.distinct().sorted()
        val outs = valid.map { it.toByte }.distinct().sorted()
        ins.forEach { leaves.add(Nodes.input(it)) }
        outs.forEach { leaves.add(Nodes.output(it)) }

        val inIdx = ins.withIndex().associate { it.value to it.index }
        val outIdx = outs.withIndex().associate { it.value to it.index }
        val m = Array(ins.size) { DoubleArray(outs.size) }
        for (e in valid) m[inIdx.getValue(e.fromByte)][outIdx.getValue(e.toByte)] = e.weight.toDouble()

        val k = minOf(hubCount, ins.size, outs.size)
        val (a, b) = lowRank(m, k)
        for ((i, byte) in ins.withIndex()) {
            for (f in strongest(k) { a[i][it] }) connect(Nodes.input(byte), Nodes.hub(f), a[i][f].toFloat())
        }
        for ((o, byte) in outs.withIndex()) {
            for (f in strongest(k) { b[it][o] }) connect(Nodes.hub(f), Nodes.output(byte), b[f][o].toFloat())
        }
    }

    private fun strongest(k: Int, value: (Int) -> Double): List<Int> =
        (0 until k).sortedWith(compareByDescending<Int> { abs(value(it)) }.thenBy { it }).take(HUBS_PER_LEAF)

    /**
     * Rank-[k] factors A (rows x k) and B (k x cols) with A*B ~ [m], from power iteration with deflation.
     * Deterministic: the start vectors are fixed, not random.
     */
    private fun lowRank(m: Array<DoubleArray>, k: Int): Pair<Array<DoubleArray>, Array<DoubleArray>> {
        val rows = m.size
        val cols = m[0].size
        val res = Array(rows) { m[it].clone() }
        val a = Array(rows) { DoubleArray(k) }
        val b = Array(k) { DoubleArray(cols) }
        for (f in 0 until k) {
            var v = DoubleArray(cols) { j -> 1.0 + ((j * 37 + f * 11) % 13) / 13.0 }
            v = unit(v)
            repeat(POWER_ITERATIONS) {
                val u = DoubleArray(rows) { i -> dot(res[i], v) }
                val w = DoubleArray(cols) { j -> var s = 0.0; for (i in 0 until rows) s += res[i][j] * u[i]; s }
                val n = sqrt(dot(w, w))
                if (n < 1e-12) return@repeat
                v = DoubleArray(cols) { w[it] / n }
            }
            val u = DoubleArray(rows) { i -> dot(res[i], v) }
            val sigma = sqrt(dot(u, u))
            if (sigma < 1e-9) break
            val root = sqrt(sigma)
            for (i in 0 until rows) {
                a[i][f] = u[i] / sigma * root
                for (j in 0 until cols) res[i][j] -= u[i] * v[j]
            }
            for (j in 0 until cols) b[f][j] = v[j] * root
        }
        return a to b
    }

    private fun dot(x: DoubleArray, y: DoubleArray): Double { var s = 0.0; for (i in x.indices) s += x[i] * y[i]; return s }
    private fun unit(x: DoubleArray): DoubleArray { val n = sqrt(dot(x, x)); return if (n < 1e-12) x else DoubleArray(x.size) { x[it] / n } }

    // ------------------------------------------------------------------ signal

    private fun activeLeaves(activeBytes: Collection<Int>): Set<Int> =
        activeBytes.mapNotNull { b -> Nodes.input(b).takeIf { b in 0..255 && it in leaves } }.toSet()

    /**
     * Raw drive reaching every hub and output byte neuron that any active input can reach, travelling
     * input -> hub -> output (and hub -> later hub, and any direct shortcut). Linear, so with hubs standing in for a
     * dense connection the two-hop product is that connection's weight.
     */
    fun propagate(activeBytes: Collection<Int>): Map<Int, Float> = propagate(activeLeaves(activeBytes))

    private fun propagate(active: Set<Int>): Map<Int, Float> {
        val incoming = HashMap<Int, MutableList<Synapse>>()
        for (s in synapses.values) incoming.getOrPut(s.to) { ArrayList() }.add(s)
        val drive = LinkedHashMap<Int, Float>()
        fun feed(node: Int) {
            var sum = 0f
            var any = false
            for (s in incoming[node] ?: return) {
                val src = if (Nodes.role(s.from) == NodeRole.INPUT) (if (s.from in active) 1f else continue) else (drive[s.from] ?: continue)
                sum += s.weight * src
                any = true
            }
            if (any) drive[node] = sum
        }
        for (h in 0 until hubCount) feed(Nodes.hub(h))
        for (id in leaves) if (Nodes.role(id) == NodeRole.OUTPUT) feed(id)
        return drive
    }

    /** The output bytes the active input bytes lean toward, strongest first. */
    fun recall(activeBytes: Collection<Int>, topK: Int = 5): List<Int> =
        propagate(activeBytes)
            .filterKeys { Nodes.role(it) == NodeRole.OUTPUT }
            .entries
            .sortedWith(compareByDescending<Map.Entry<Int, Float>> { it.value }.thenBy { it.key })
            .take(topK)
            .map { Nodes.byteOf(it.key) }

    /** Activity of every neuron that fired: inputs 1, hubs and outputs relative to the busiest of their own layer. */
    private fun activity(active: Set<Int>, drive: Map<Int, Float>): Map<Int, Float> {
        val act = HashMap<Int, Float>()
        for (a in active) act[a] = 1f
        for (role in listOf(NodeRole.HUB, NodeRole.OUTPUT)) {
            val layer = drive.filterKeys { Nodes.role(it) == role }
            val peak = layer.values.fold(0f) { p, v -> max(p, abs(v)) }
            if (peak > 0f) for ((n, v) in layer) act[n] = v / peak
        }
        return act
    }

    // ------------------------------------------------------------------ one step of use

    /**
     * One use of the graph with these input bytes active. Existing connections are strengthened when both of their
     * ends fire together (and fade otherwise, and are deleted at ~0); neurons that keep firing together or in
     * opposition get new connections.
     */
    fun step(activeBytes: Collection<Int>): SynapseStepReport {
        steps++
        val active = activeLeaves(activeBytes)
        val act = activity(active, propagate(active))

        var strengthened = 0
        var pruned = 0
        val it = synapses.values.iterator()
        while (it.hasNext()) {
            val s = it.next()
            val a = act[s.from] ?: 0f
            val b = act[s.to] ?: 0f
            if (abs(a) >= HIGH && abs(b) >= HIGH) {
                s.weight = (s.weight + HEBB_RATE * a * b).coerceIn(-WEIGHT_MAX, WEIGHT_MAX)
                strengthened++
            } else {
                s.weight *= (1f - DECAY)
            }
            if (abs(s.weight) < PRUNE_BELOW) { it.remove(); pruned++ }
        }

        val formed = formNew(act)
        totalFormed += formed
        totalPruned += pruned
        return SynapseStepReport(formed, pruned, strengthened)
    }

    private fun formNew(act: Map<Int, Float>): Int {
        val high = act.filter { abs(it.value) >= HIGH }.keys.sorted()
        val ready = ArrayList<Triple<Int, Int, Float>>()
        for (i in high.indices) for (j in i + 1 until high.size) {
            val x = high[i]
            val y = high[j]
            val s = sign(act.getValue(x) * act.getValue(y))
            if (linked(x, y, s)) continue
            val t = tallies.getOrPut(key(x, y)) { Tally(lastStep = steps) }
            if (steps - t.lastStep > FORM_WINDOW_STEPS) { t.same = 0; t.opposite = 0 }
            t.lastStep = steps
            if (s > 0f) t.same++ else t.opposite++
            if ((if (s > 0f) t.same else t.opposite) >= FORM_AFTER) ready.add(Triple(x, y, s))
        }
        var formed = 0
        for ((x, y, s) in ready) {
            if (linked(x, y, s)) continue
            if (generate(x, y, s)) {
                tallies.remove(key(x, y))
                formed++
            }
        }
        trimTallies()
        return formed
    }

    private fun trimTallies() {
        if (tallies.size <= MAX_TRACKED_PAIRS) return
        tallies.entries.removeAll { steps - it.value.lastStep > FORM_WINDOW_STEPS }
        if (tallies.size <= MAX_TRACKED_PAIRS) return
        val keep = tallies.entries.sortedByDescending { it.value.lastStep }.take(MAX_TRACKED_PAIRS / 2).map { it.key }.toSet()
        tallies.keys.retainAll(keep)
    }

    // ------------------------------------------------------------------ generating connections

    private fun layer(id: Int) = Nodes.role(id).ordinal

    /** The connection that links [leaf] with [hub]: byte in -> hub, or hub -> byte out. */
    private fun spoke(leaf: Int, hub: Int): Pair<Int, Int> =
        if (Nodes.role(leaf) == NodeRole.INPUT) leaf to hub else hub to leaf

    private fun sameLayerLeaves(x: Int, y: Int) =
        Nodes.role(x) == Nodes.role(y) && Nodes.role(x) != NodeRole.HUB

    /**
     * True when x and y are already wired together: directly, or through a hub that carries the relation [s]
     * (same-layer neurons through a shared hub, different layers through a hub in between). A pair that is already
     * routed through a hub does not get a second, direct link, which is what keeps the graph hub-and-spoke.
     */
    private fun linked(x: Int, y: Int, s: Float): Boolean {
        if (sameLayerLeaves(x, y)) {
            for (h in 0 until hubCount) {
                val (f1, t1) = spoke(x, Nodes.hub(h))
                val (f2, t2) = spoke(y, Nodes.hub(h))
                val w1 = weight(f1, t1) ?: continue
                val w2 = weight(f2, t2) ?: continue
                if (sign(w1 * w2) == s) return true
            }
            return false
        }
        val (a, b) = ordered(x, y)
        if (weight(a, b) != null) return true
        for (h in 0 until hubCount) {
            val mid = Nodes.hub(h)
            if (mid == a || mid == b) continue
            val w1 = weight(a, mid) ?: continue
            val w2 = weight(mid, b) ?: continue
            if (sign(w1 * w2) == s) return true
        }
        return false
    }

    /** Orders a pair along the direction signals travel. */
    private fun ordered(x: Int, y: Int): Pair<Int, Int> = when {
        layer(x) != layer(y) -> if (layer(x) < layer(y)) x to y else y to x
        else -> if (x < y) x to y else y to x
    }

    private fun generate(x: Int, y: Int, s: Float): Boolean {
        val plan = ArrayList<Triple<Int, Int, Float>>()
        if (sameLayerLeaves(x, y)) {
            if (!pickHub(x, y, s, plan)) return false
        } else {
            val (a, b) = ordered(x, y)
            if (!legal(a, b)) return false
            plan.add(Triple(a, b, s * INITIAL_WEIGHT))
        }
        return commit(plan)
    }

    /**
     * Chooses the hub that already serves x and y best (so a hub keeps being a hub), else the quietest hub, and adds
     * the missing spokes to [plan]. Hubs whose existing spokes contradict the wanted relation are skipped.
     * Returns false when no hub can serve the pair.
     */
    private fun pickHub(x: Int, y: Int, s: Float, plan: MutableList<Triple<Int, Int, Float>>): Boolean {
        var best: Int? = null
        var bestKey = Triple(-1f, 0, 0)
        for (h in 0 until hubCount) {
            val hub = Nodes.hub(h)
            val (xf, xt) = spoke(x, hub)
            val (yf, yt) = spoke(y, hub)
            val wx = weight(xf, xt)
            val wy = weight(yf, yt)
            if (wx != null && wy != null && sign(wx * wy) != s) continue
            val affinity = (if (wx != null) abs(wx) else 0f) + (if (wy != null) abs(wy) else 0f)
            val candidate = Triple(affinity, -degree(hub), -h)
            val better = best == null || compareValuesBy(candidate, bestKey, { it.first }, { it.second }, { it.third }) > 0
            if (better) { best = h; bestKey = candidate }
        }
        val h = best ?: return false
        val hub = Nodes.hub(h)
        val (xf, xt) = spoke(x, hub)
        val (yf, yt) = spoke(y, hub)
        val wx = weight(xf, xt)
        val wy = weight(yf, yt)
        when {
            wx != null -> plan.add(Triple(yf, yt, sign(wx) * s * INITIAL_WEIGHT))
            wy != null -> plan.add(Triple(xf, xt, sign(wy) * s * INITIAL_WEIGHT))
            else -> { plan.add(Triple(xf, xt, INITIAL_WEIGHT)); plan.add(Triple(yf, yt, s * INITIAL_WEIGHT)) }
        }
        return true
    }

    /**
     * Adds the planned connections, all or none. A byte neuron already at [MAX_LEAF_DEGREE] only makes room by dropping
     * its weakest connection, and only if that one is weaker than the newcomer. This is the sparsity guarantee.
     */
    private fun commit(plan: List<Triple<Int, Int, Float>>): Boolean {
        if (plan.isEmpty()) return false
        val dropping = ArrayList<Synapse>()
        for ((from, to, _) in plan) {
            for (leaf in listOf(from, to)) {
                if (Nodes.role(leaf) == NodeRole.HUB) continue
                val mine = synapses.values.filter { it.from == leaf || it.to == leaf }
                if (mine.size - dropping.count { it.from == leaf || it.to == leaf } < MAX_LEAF_DEGREE) continue
                val weakest = mine.filter { it !in dropping }.minByOrNull { abs(it.weight) } ?: return false
                if (abs(weakest.weight) >= INITIAL_WEIGHT) return false
                dropping.add(weakest)
            }
        }
        for (d in dropping) synapses.remove(key(d.from, d.to))
        for ((from, to, w) in plan) connect(from, to, w)
        return true
    }
}
