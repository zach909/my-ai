package com.example.engine

import kotlin.math.ceil
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.random.Random

/** What an island is for. CORE is the frozen pretrained base; SELF models the brain's own contents. */
enum class IslandKind { CORE, SELF, SKILL, MEMORY }

/**
 * The encoder islands use to recognise content. Raw UTF-8 bytes in, no tokenizer and no word list (the Zip Loop
 * rule): every overlapping 4-byte window is hashed to a signed position in the vector, with ASCII letters folded to
 * lower case at the byte level. It is position-independent, so dropping or reordering words barely moves it, and it
 * is unbiased, so unrelated text averages ~0 similarity. [HDVector.encodeBytes] is unchanged for everything else.
 *
 * Measured at 64 dimensions on 12 unrelated sentences: unrelated pairs average 0.03 (max 0.26); the same sentence
 * with two words removed scores 0.88 (min 0.75); half a sentence 0.68; a keyword-only query scores 0.46 or more
 * against its own sentence and at most 0.35 against any other. At 32 dimensions the keyword case overlapped the
 * unrelated range, which is why the mesh is 64-D.
 */
object IslandEncoder {
    private const val WINDOW = 4

    private fun hash(b: ByteArray, from: Int, n: Int): Int {
        var x = 0x811c9dc5.toInt() xor (n * 7919)
        for (i in from until from + n) { x = x xor (b[i].toInt() and 0xFF); x *= 16777619 }
        x = x xor (x ushr 15); x *= 0x2c1b3c6d; x = x xor (x ushr 12)
        return x
    }

    fun encode(text: String, dimensions: Int): HDVector {
        val bounds = HDVector.computeBounds(dimensions)
        val v = FloatArray(bounds[4])
        val raw = text.toByteArray(Charsets.UTF_8)
        val b = ByteArray(raw.size) { i -> val x = raw[i].toInt() and 0xFF; (if (x in 65..90) x + 32 else x).toByte() }
        val n = minOf(WINDOW, b.size)
        for (i in 0..b.size - n) {
            val h = hash(b, i, n)
            v[Math.floorMod(h, v.size)] += if ((h ushr 30) and 1 == 0) 1f else -1f
        }
        return HDVector(v, bounds).normalized()
    }
}

/** One hyper-neuron: a state vector plus its share of the zero-sum vale (plasticity) budget. */
class Neuron(var state: HDVector, var vale: Float)

/**
 * A group of neurons born for one subject and trained only on that subject's content.
 * Training an island never touches another island, so learning here cannot overwrite knowledge there.
 */
class Island(
    val id: String,
    val kind: IslandKind,
    var label: String,
    var content: String,
    val bornCycle: Int,
    val bornAtMs: Long,
    val reason: String,
    val neurons: MutableList<Neuron>
) {
    /** Times consolidation (sleep) strengthened this island. */
    var reinforcements = 0

    /** Times a message was routed to this island while awake. */
    var uses = 0
    var lastUsedCycle = bornCycle

    /** Share of this island's synthetic dream cues that routed back to it at the last sleep (-1 = never dreamed). */
    var dreamRecall = -1f

    /** How well the island recognises [v]: its best neuron, so each neuron can specialise on one part of the subject. */
    fun score(v: HDVector): Float {
        var best = -1f
        for (n in neurons) best = max(best, HDVector.cosineSimilarity(v, n.state))
        return best
    }

    fun centroid(dimensions: Int): HDVector = IslandMesh.centroidOf(neurons.map { it.state }, dimensions)

    val contentHash: Int get() = content.hashCode()
}

/** One short-term experience held while awake until the next sleep consolidates it. */
data class Episode(val cue: HDVector, val text: String, val novelty: Float, val atMs: Long)

data class DreamReport(
    val cues: Int,
    /** Held-out synthetic cues routed to the right island before rehearsal. */
    val recallBefore: Float,
    /** The same cues after rehearsal. Rehearsal used a different set of cues, so this is not memorisation. */
    val recallAfter: Float,
    val rehearsed: Int
)

data class SleepReport(
    val cycle: Int,
    val episodes: Int,
    val newIslands: List<String>,
    val reinforcedIslands: List<String>,
    val neuronsAdded: Int,
    val neuronsPruned: Int,
    val islandsForgotten: List<String>,
    val dream: DreamReport?,
    val neuronCount: Int
) {
    fun summary(): String = buildString {
        append("Slept at cycle $cycle: consolidated $episodes experience(s) into ")
        append("${newIslands.size} new island(s) (+$neuronsAdded neurons)")
        if (reinforcedIslands.isNotEmpty()) append(", strengthened ${reinforcedIslands.size}")
        if (neuronsPruned > 0) append(", pruned $neuronsPruned redundant neuron(s)")
        if (islandsForgotten.isNotEmpty()) append(", forgot ${islandsForgotten.size} unused memory island(s)")
        append(".")
        if (dream != null) {
            append(" Dreamed ${dream.rehearsed} rehearsals; held-out recall ")
            append("${(dream.recallBefore * 100).toInt()}% -> ${(dream.recallAfter * 100).toInt()}%.")
        }
        append(" Mesh is now $neuronCount neurons.")
    }
}

/**
 * The growable, island-structured mesh, with the wake / sleep learning cycle.
 *
 * - WAKE: [wake] reads and routes. It changes no weights; novel experiences wait in [shortTerm].
 * - SLEEP 1: [sleep] clusters what is waiting and gives each unfamiliar cluster a new island of spare neurons,
 *   distilled from those experiences; familiar clusters strengthen the island that already knows them.
 *   Redundant neurons are pruned.
 * - SLEEP 2: the same call then dreams: it invents cues from its own islands, rehearses them, and measures
 *   recall on cues it never rehearsed.
 * - The CORE island (the pretrained base) is never trained, so nothing learned later can erase it.
 * - The SELF island is trained on a map of every other island, which is what [describeSelf] reads back.
 *
 * This is a small hyperdimensional analogue of consolidation into spare mixture-of-experts capacity. It is not
 * language-model distillation: the "teacher" is the stored experience itself.
 *
 * Pure Kotlin, no Android types. Not thread-safe; [OneBrainEngine] guards it with its lock.
 */
class IslandMesh(
    val dimensions: Int = 64,
    coreNeurons: Int = 32,
    val maxNeurons: Int = 256,
    private val dreamSeed: Long = 7L
) {
    companion object {
        const val SELF_NEURONS = 2
        const val SELF_TRAIN_STEPS = 8
        const val SELF_TRAIN_GAIN = 8f
        const val MIN_ISLAND_NEURONS = 2
        const val MAX_ISLAND_NEURONS = 6

        /** A newborn neuron holds this much of its one vale point (low = plastic); the rest hardens older neurons. */
        const val NEWBORN_VALE = 0.5f
        const val LEARNING_RATE = 0.05f

        /**
         * A cluster this similar to an existing island strengthens it instead of growing a new one. Set in the measured
         * gap (see [IslandEncoder]): keyword queries of a known fact scored 0.46 or more, the best wrong island 0.35 or less.
         */
        const val FAMILIAR_SIM = 0.42f

        /** An experience is "new to me" (kept for sleep) when no island recognises it: novelty = 1 - best score. */
        const val NOVELTY_MIN = 1f - FAMILIAR_SIM
        const val MIN_EXPERIENCE_CHARS = 12
        const val SHORT_TERM_CAP = 32

        /** Total novelty waiting that makes the brain want to sleep. */
        const val SLEEP_PRESSURE = 3.0f

        /** Experiences this alike are one subject and share an island (a sentence minus two words scores 0.75 or more). */
        const val CLUSTER_SIM = 0.55f

        /** Neurons in one island this alike are redundant. */
        const val PRUNE_SIM = 0.97f

        /** A message routes to an island only above this score, the same line as "familiar". */
        const val ROUTE_MIN = FAMILIAR_SIM
        const val FORGET_AFTER_CYCLES = 20
        const val DREAM_CUES_PER_ISLAND = 3
        const val DREAM_ROUNDS_MAX = 24
        private const val CONTENT_CAP = 2000

        fun centroidOf(states: List<HDVector>, dimensions: Int): HDVector {
            val bounds = HDVector.computeBounds(dimensions)
            val acc = FloatArray(bounds[4])
            for (s in states) for (i in acc.indices) if (i < s.data.size) acc[i] += s.data[i]
            return HDVector(acc, bounds).normalized()
        }
    }

    val islands = LinkedHashMap<String, Island>()
    val shortTerm = ArrayList<Episode>()
    val lifeLog = ArrayList<SleepReport>()
    var sleeps = 0
        private set

    private var clock = 0
    private val forgottenSinceSleep = ArrayList<String>()

    init {
        islands["core"] = Island(
            id = "core", kind = IslandKind.CORE, label = "Core mesh (frozen)", content = "",
            bornCycle = 0, bornAtMs = 0L, reason = "pretrained base",
            neurons = MutableList(coreNeurons) { idx ->
                Neuron(HDVector.random(dimensions, seed = 1000L + idx * 37L), 1f)
            }
        )
        val selfSeed = HDVector.encodeBytes("self identity what I am and what I have learned".toByteArray(), dimensions)
        islands["self"] = Island(
            id = "self", kind = IslandKind.SELF, label = "Self", content = "",
            bornCycle = 0, bornAtMs = 0L, reason = "self-model",
            neurons = MutableList(SELF_NEURONS) { k ->
                Neuron(HDVector.bundle(selfSeed, HDVector.random(dimensions, 5000L + k), 0.9f, 0.1f), 1f)
            }
        )
    }

    /** Every neuron, core first, then self, then learned islands in birth order. */
    val neurons: List<Neuron> get() = islands.values.flatMap { it.neurons }
    val neuronCount: Int get() = islands.values.sumOf { it.neurons.size }

    /** One vale point per neuron, always: growth mints a point, pruning retires one, nothing else changes the total. */
    val valeTotal: Float get() = neuronCount.toFloat()

    val core: Island get() = islands.getValue("core")
    fun learned(): List<Island> = islands.values.filter { it.kind == IslandKind.SKILL || it.kind == IslandKind.MEMORY }

    /** Re-adds a saved island (app restart, mesh delta) as it was. Never replaces an island already here. */
    fun restoreIsland(island: Island): Boolean {
        if (island.kind == IslandKind.CORE || island.kind == IslandKind.SELF) return false
        if (islands.containsKey(island.id) || neuronCount + island.neurons.size > maxNeurons) return false
        islands[island.id] = island
        return true
    }

    /** Restores the count of sleeps and the last sleep, so the self-model does not forget its own history after a restart. */
    fun restoreHistory(sleepCount: Int, last: SleepReport?) {
        sleeps = max(sleeps, sleepCount)
        if (last != null && lifeLog.isEmpty()) lifeLog.add(last)
    }

    /** Total novelty of the experiences waiting for sleep. */
    val pressure: Float get() = shortTerm.fold(0f) { a, e -> a + e.novelty }
    fun shouldSleep(): Boolean = pressure >= SLEEP_PRESSURE

    /** How unfamiliar [v] is to everything learned so far (1 = nothing learned resembles it). */
    fun novelty(v: HDVector): Float {
        var best = 0f
        for (i in learned()) best = max(best, i.score(v))
        return 1f - best
    }

    /** The learned islands that recognise [v], best first. Read-only. */
    fun route(v: HDVector, k: Int = 2): List<Pair<Island, Float>> =
        learned().map { it to it.score(v) }
            .filter { it.second >= ROUTE_MIN }
            .sortedByDescending { it.second }
            .take(k)

    private fun best(v: HDVector): Island? = learned().maxByOrNull { it.score(v) }

    // ---------------------------------------------------------------- WAKE

    /**
     * Wake: route the message to the islands that know it and remember it for sleep if it is new to me.
     * Changes no neuron and no vale.
     */
    fun wake(text: String, cycle: Int, nowMs: Long): List<Pair<Island, Float>> {
        clock = cycle
        val v = encode(text)
        val routed = route(v)
        for ((island, _) in routed) {
            island.uses++
            island.lastUsedCycle = cycle
        }
        val clean = text.trim()
        val nov = novelty(v)
        if (clean.length >= MIN_EXPERIENCE_CHARS && nov >= NOVELTY_MIN && shortTerm.none { it.text == clean }) {
            if (shortTerm.size >= SHORT_TERM_CAP) shortTerm.removeAt(0)
            shortTerm.add(Episode(v, clean, nov, nowMs))
        }
        return routed
    }

    // ---------------------------------------------------------------- explicit teaching

    /**
     * Deliberate teaching (a grafted skill, a correction): grow an island now, trained on [teachers].
     * An id already known with identical content is left alone; with changed content its island is retrained.
     * Returns null only when the mesh is full and nothing can be forgotten.
     */
    fun learnNow(
        id: String,
        kind: IslandKind,
        label: String,
        teachers: List<String>,
        reason: String,
        cycle: Int,
        nowMs: Long
    ): Island? {
        clock = max(clock, cycle)
        val texts = teachers.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        if (texts.isEmpty()) return null
        val content = texts.joinToString("\n").take(CONTENT_CAP)
        val existing = islands[id]
        if (existing != null) {
            if (existing.contentHash != content.hashCode()) {
                existing.content = content
                distill(existing, texts.map { encode(it) }, rounds = 2, gain = 4f)
                existing.reinforcements++
            }
            return existing
        }
        return grow(id, kind, label, content, texts.map { encode(it) }, reason, cycle, nowMs)
    }

    // ---------------------------------------------------------------- SLEEP

    /** Sleep: consolidate short-term experience into islands, prune, dream, then refresh the self-model. */
    fun sleep(cycle: Int, nowMs: Long, dream: Boolean = true): SleepReport {
        clock = max(clock, cycle)
        val episodes = shortTerm.toList()
        shortTerm.clear()
        val newIds = ArrayList<String>()
        val reinforced = LinkedHashSet<String>()
        val touched = LinkedHashSet<Island>()
        var added = 0

        for (cluster in cluster(episodes)) {
            val cues = cluster.map { it.cue }
            val centroid = centroidOf(cues, dimensions)
            val nearest = learned().maxByOrNull { it.score(centroid) }
            if (nearest != null && nearest.score(centroid) >= FAMILIAR_SIM) {
                distill(nearest, cues, rounds = 2, gain = 3f)
                nearest.reinforcements++
                reinforced.add(nearest.label)
                touched.add(nearest)
                continue
            }
            val distinct = distinctEpisodes(cluster)
            val island = grow(
                id = uniqueId("mem:" + Integer.toHexString(distinct.first().text.hashCode())),
                kind = IslandKind.MEMORY,
                label = distinct.first().text.take(40),
                content = distinct.joinToString("\n") { it.text }.take(CONTENT_CAP),
                teachers = distinct.map { it.cue },
                reason = "slept on ${cluster.size} novel experience(s), novelty ${"%.2f".format(cluster.maxOf { it.novelty })}",
                cycle = cycle,
                nowMs = nowMs
            )
            if (island != null) {
                newIds.add(island.label)
                added += island.neurons.size
                touched.add(island)
            } else if (nearest != null) {
                // Full and nothing forgettable: strengthen the closest island instead of growing.
                distill(nearest, cues, rounds = 1, gain = 2f)
                nearest.reinforcements++
                reinforced.add(nearest.label)
                touched.add(nearest)
            }
        }

        var pruned = 0
        for (island in touched) pruned += prune(island)
        rebalance()

        val dreamReport = if (dream && learned().isNotEmpty()) dream() else null
        refreshSelf()
        sleeps++

        val report = SleepReport(
            cycle = cycle,
            episodes = episodes.size,
            newIslands = newIds,
            reinforcedIslands = reinforced.toList(),
            neuronsAdded = added,
            neuronsPruned = pruned,
            islandsForgotten = forgottenSinceSleep.toList(),
            dream = dreamReport,
            neuronCount = neuronCount
        )
        forgottenSinceSleep.clear()
        lifeLog.add(report)
        if (lifeLog.size > 50) lifeLog.removeAt(0)
        return report
    }

    private fun cluster(episodes: List<Episode>): List<List<Episode>> {
        val groups = ArrayList<MutableList<Episode>>()
        val centroids = ArrayList<HDVector>()
        for (ep in episodes) {
            val idx = centroids.indices.firstOrNull { HDVector.cosineSimilarity(centroids[it], ep.cue) >= CLUSTER_SIM }
            if (idx == null) {
                groups.add(mutableListOf(ep))
                centroids.add(ep.cue)
            } else {
                groups[idx].add(ep)
                centroids[idx] = centroidOf(groups[idx].map { it.cue }, dimensions)
            }
        }
        return groups
    }

    private fun distinctEpisodes(cluster: List<Episode>): List<Episode> {
        val keep = ArrayList<Episode>()
        for (ep in cluster) if (keep.none { HDVector.cosineSimilarity(it.cue, ep.cue) >= 0.95f }) keep.add(ep)
        return keep
    }

    // ---------------------------------------------------------------- growth, training, pruning

    /** Encodes text the way islands see it. */
    fun encode(text: String): HDVector = IslandEncoder.encode(text, dimensions)

    private fun uniqueId(base: String): String {
        if (!islands.containsKey(base)) return base
        var n = 2
        while (islands.containsKey("$base#$n")) n++
        return "$base#$n"
    }

    /** Frees room by forgetting memory islands nobody has used for a while. Skills, core and self are never forgotten. */
    private fun ensureRoom(n: Int): Boolean {
        while (neuronCount + n > maxNeurons) {
            val weakest = learned()
                .filter { it.kind == IslandKind.MEMORY && clock - it.lastUsedCycle >= FORGET_AFTER_CYCLES }
                .minWithOrNull(compareBy<Island>({ it.uses + it.reinforcements }, { it.lastUsedCycle }))
                ?: return false
            islands.remove(weakest.id)
            forgottenSinceSleep.add(weakest.label)
        }
        return true
    }

    /** Spare experts: new neurons born from the teachers' centroid, then distilled from the teachers. */
    private fun grow(
        id: String,
        kind: IslandKind,
        label: String,
        content: String,
        teachers: List<HDVector>,
        reason: String,
        cycle: Int,
        nowMs: Long
    ): Island? {
        val n = teachers.size.coerceIn(MIN_ISLAND_NEURONS, MAX_ISLAND_NEURONS)
        if (!ensureRoom(n)) return null

        // Mint: each newborn brings one vale point; it keeps NEWBORN_VALE (plastic) and the rest hardens the old mesh.
        val old = neurons
        val oldSum = old.fold(0f) { a, x -> a + x.vale }
        val spare = (1f - NEWBORN_VALE) * n
        if (oldSum > 0f) for (x in old) x.vale += spare * x.vale / oldSum

        val base = centroidOf(teachers, dimensions)
        val seed = content.hashCode().toLong() * 31L
        val born = MutableList(n) { k ->
            Neuron(HDVector.bundle(base, HDVector.random(dimensions, seed + k), 0.85f, 0.15f), NEWBORN_VALE)
        }
        val island = Island(id, kind, label, content, cycle, nowMs, reason, born)
        islands[id] = island
        distill(island, teachers, rounds = 3, gain = 6f)
        rebalance()
        return island
    }

    private fun pull(n: Neuron, target: HDVector, gain: Float) {
        val plasticity = (LEARNING_RATE / (0.5f + n.vale)).coerceIn(0.005f, 0.08f)
        val w = (plasticity * gain).coerceIn(0f, 0.9f)
        n.state = HDVector.bundle(n.state, target, 1f - w, w)
    }

    /**
     * Trains ONLY [island]'s neurons: each specialises on one teacher and is lightly tied to the teachers' centroid.
     * No other island is read or written.
     */
    private fun distill(island: Island, teachers: List<HDVector>, rounds: Int, gain: Float) {
        if (teachers.isEmpty()) return
        val centroid = centroidOf(teachers, dimensions)
        repeat(rounds) {
            for ((k, neuron) in island.neurons.withIndex()) {
                pull(neuron, teachers[k % teachers.size], gain)
                pull(neuron, centroid, gain * 0.3f)
            }
        }
    }

    /** Synaptic pruning: drops neurons that duplicate a sibling, keeping at least [MIN_ISLAND_NEURONS]. */
    private fun prune(island: Island): Int {
        var removed = 0
        var i = island.neurons.size - 1
        while (i >= 0 && island.neurons.size > MIN_ISLAND_NEURONS) {
            val n = island.neurons[i]
            val dup = island.neurons.withIndex().any { (j, o) ->
                j != i && HDVector.cosineSimilarity(n.state, o.state) >= PRUNE_SIM
            }
            if (dup) {
                island.neurons.removeAt(i)
                removed++
            }
            i--
        }
        return removed
    }

    /** Keeps the invariant: vale sums to exactly one point per neuron. */
    fun rebalance() {
        val all = neurons
        val sum = all.fold(0f) { a, n -> a + n.vale }
        if (sum <= 0f) return
        val scale = all.size / sum
        for (n in all) n.vale *= scale
    }

    /** Zero-sum transfer on use: the winner gains stability, everyone else gives a little. */
    fun redistributeVale(winner: Neuron, delta: Float) {
        val all = neurons
        val share = delta / max(1, all.size - 1)
        for (n in all) {
            n.vale = if (n === winner) (n.vale + delta).coerceAtMost(4.0f) else (n.vale - share).coerceAtLeast(0.1f)
        }
        rebalance()
    }

    // ---------------------------------------------------------------- DREAM

    /** Cues invented from an island's own content: a slice, a word-dropout, a question form, or a shuffled slice. */
    private fun synthCue(content: String, rng: Random): String {
        val words = content.split(Regex("\\s+")).filter { it.isNotBlank() }
        if (words.size < 4) {
            val s = content.trim()
            if (s.length < 6) return s
            val len = max(4, s.length / 2)
            val from = rng.nextInt(0, s.length - len + 1)
            return s.substring(from, from + len)
        }
        val win = max(2, ceil(words.size * 0.5).toInt())
        val from = rng.nextInt(0, words.size - win + 1)
        val slice = words.subList(from, from + win)
        return when (rng.nextInt(4)) {
            0 -> slice.joinToString(" ")
            1 -> words.filter { rng.nextFloat() > 0.3f }.ifEmpty { slice }.joinToString(" ")
            2 -> "what is " + slice.joinToString(" ")
            else -> slice.shuffled(rng).joinToString(" ")
        }
    }

    /** Share of fixed synthetic cues that route back to the island they were invented from. */
    private fun probe(seed: Long): Pair<Float, Map<Island, Float>> {
        val rng = Random(seed)
        var hits = 0
        var total = 0
        val per = HashMap<Island, Float>()
        for (island in learned()) {
            var h = 0
            repeat(DREAM_CUES_PER_ISLAND) {
                val v = encode(synthCue(island.content, rng))
                if (best(v) === island) h++
            }
            per[island] = h.toFloat() / DREAM_CUES_PER_ISLAND
            hits += h
            total += DREAM_CUES_PER_ISLAND
        }
        return (if (total == 0) 0f else hits.toFloat() / total) to per
    }

    /**
     * Dreaming: pick islands at random, invent cues from them, and practise recalling the right island.
     * A cue that routes correctly gets a light nudge; one that routes wrongly pulls its own island harder
     * toward it (the error is the reward signal). Only the island being practised changes.
     * Recall is measured on a separate fixed set of cues the practice never used.
     */
    private fun dream(): DreamReport {
        val probeSeed = dreamSeed * 1_000_003L + sleeps
        val trainSeed = probeSeed + 17L
        val (before, _) = probe(probeSeed)
        val islandsL = learned()
        val rng = Random(trainSeed)
        val rounds = min(DREAM_ROUNDS_MAX, DREAM_CUES_PER_ISLAND * islandsL.size)
        repeat(rounds) {
            val target = islandsL[rng.nextInt(islandsL.size)]
            val v = encode(synthCue(target.content, rng))
            val gain = if (best(v) === target) 1f else 3f
            val neuron = target.neurons.maxByOrNull { HDVector.cosineSimilarity(v, it.state) } ?: return@repeat
            pull(neuron, v, gain)
        }
        val (after, per) = probe(probeSeed)
        for ((island, r) in per) island.dreamRecall = r
        return DreamReport(
            cues = islandsL.size * DREAM_CUES_PER_ISLAND,
            recallBefore = before,
            recallAfter = after,
            rehearsed = rounds
        )
    }

    // ---------------------------------------------------------------- SELF

    /** Trains the self neurons on a map of everything learned, weighted by how much each island is used and consolidated. */
    fun refreshSelf() {
        val self = islands["self"] ?: return
        val l = learned()
        if (l.isEmpty()) return
        val bounds = HDVector.computeBounds(dimensions)
        val acc = FloatArray(bounds[4])
        for (island in l) {
            val w = 1f + ln(1f + island.reinforcements + island.uses)
            val c = island.centroid(dimensions)
            for (i in acc.indices) acc[i] += w * c.data[i]
        }
        val map = HDVector(acc, bounds).normalized()
        val recent = centroidOf(l.sortedByDescending { it.bornCycle }.take(3).map { it.centroid(dimensions) }, dimensions)
        // Reflection is several training steps, not one nudge: the self neurons settle on the current map.
        repeat(SELF_TRAIN_STEPS) {
            pull(self.neurons[0], map, SELF_TRAIN_GAIN)
            pull(self.neurons[1 % self.neurons.size], recent, SELF_TRAIN_GAIN)
        }
    }

    /** How closely the self neurons currently match the real contents (1 = the self-model is up to date). */
    fun selfAccuracy(): Float {
        val self = islands["self"] ?: return 0f
        val l = learned()
        if (l.isEmpty()) return 1f
        val bounds = HDVector.computeBounds(dimensions)
        val acc = FloatArray(bounds[4])
        for (island in l) {
            val w = 1f + ln(1f + island.reinforcements + island.uses)
            val c = island.centroid(dimensions)
            for (i in acc.indices) acc[i] += w * c.data[i]
        }
        val map = HDVector(acc, bounds).normalized()
        return HDVector.cosineSimilarity(map, self.neurons[0].state).coerceIn(0f, 1f)
    }

    /** The brain reading its own state back: what it is made of, what is new, what it leans on, how it last slept. */
    fun describeSelf(avgSurprise: Float): String {
        val l = learned()
        val skills = l.count { it.kind == IslandKind.SKILL }
        val memories = l.count { it.kind == IslandKind.MEMORY }
        return buildString {
            append("I have $neuronCount neurons in ${islands.size} islands: ")
            append("${core.neurons.size} frozen base neurons that learning never touches, ")
            append("$skills skill island(s), $memories memory island(s) and my self island. ")
            if (l.isEmpty()) {
                append("I have not grown anything yet; everything I know is the pretrained base.")
            } else {
                val newest = l.maxByOrNull { it.bornCycle }!!
                val oldest = l.minByOrNull { it.bornCycle }!!
                val favourite = l.maxByOrNull { it.uses }!!
                append("Newest: \"${newest.label}\" (cycle ${newest.bornCycle}, ${newest.reason}). ")
                if (oldest !== newest) append("Oldest: \"${oldest.label}\" (cycle ${oldest.bornCycle}). ")
                if (favourite.uses > 0) append("I reach for \"${favourite.label}\" most (${favourite.uses} uses). ")
            }
            val last = lifeLog.lastOrNull()
            if (last != null) append(last.summary() + " ") else append("I have not slept yet. ")
            append("${shortTerm.size} new experience(s) are waiting for sleep (pressure ${"%.1f".format(pressure)}/$SLEEP_PRESSURE). ")
            append("Average surprise ${"%.2f".format(avgSurprise)}; my self-model is ${(selfAccuracy() * 100).toInt()}% up to date with what I contain. ")
            append("This is a readout of my own state, not a claim to be aware.")
        }
    }
}
