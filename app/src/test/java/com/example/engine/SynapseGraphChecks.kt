package com.example.engine

import kotlin.math.abs
import kotlin.random.Random

// Dependency-free checks for the hub-routed synapse graph (the project takes no third-party code, so no JUnit).
// Pure Kotlin, no Android types. Run from the repo root with any Kotlin compiler, for example:
//   kotlinc app/src/main/java/com/example/engine/SynapseGraph.kt \
//     app/src/test/java/com/example/engine/SynapseGraphChecks.kt -include-runtime -d /tmp/synapse-checks.jar \
//     && java -cp /tmp/synapse-checks.jar com.example.engine.SynapseGraphChecks
// Exits non-zero if any check fails.

object SynapseGraphChecks {
    private fun check(message: String, cond: Boolean) { if (!cond) throw AssertionError(message) }

    @JvmStatic
    fun main(args: Array<String>) {
        var failed = 0
        for ((name, run) in all()) {
            try { run(); println("ok   $name") } catch (t: Throwable) { failed++; println("FAIL $name: ${t.message}") }
        }
        println("${all().size} checks, $failed failed")
        if (failed > 0) kotlin.system.exitProcess(1)
    }

    private fun all(): List<Pair<String, () -> Unit>> = listOf(
        "startsHubRoutedNotAllToAll" to ::startsHubRoutedNotAllToAll,
        "hubRoutingKeepsMostOfTheRecall" to ::hubRoutingKeepsMostOfTheRecall,
        "signalsOnlyTravelForwardThroughLegalLinks" to ::signalsOnlyTravelForwardThroughLegalLinks,
        "twoHopDriveIsTheProductOfTheWeights" to ::twoHopDriveIsTheProductOfTheWeights,
        "aConnectionThatFadesToNothingIsDeletedButItsNeuronsStay" to ::aConnectionThatFadesToNothingIsDeletedButItsNeuronsStay,
        "aConnectionWithNoWeightIsNeverMade" to ::aConnectionWithNoWeightIsNeverMade,
        "connectionsUsedTogetherStrengthenInsteadOfFading" to ::connectionsUsedTogetherStrengthenInsteadOfFading,
        "aConnectionContradictedByUseShrinksToNothingAndIsDeleted" to ::aConnectionContradictedByUseShrinksToNothingAndIsDeleted,
        "highTogetherThreeTimesGeneratesAConnection" to ::highTogetherThreeTimesGeneratesAConnection,
        "twoTimesIsNotEnoughAndOldEvidenceExpires" to ::twoTimesIsNotEnoughAndOldEvidenceExpires,
        "aPairAlreadyRoutedThroughAHubDoesNotGetADirectShortcut" to ::aPairAlreadyRoutedThroughAHubDoesNotGetADirectShortcut,
        "sameLayerNeuronsAreTiedTogetherThroughAHub" to ::sameLayerNeuronsAreTiedTogetherThroughAHub,
        "oppositeThreeTimesGeneratesAnInhibitoryConnection" to ::oppositeThreeTimesGeneratesAnInhibitoryConnection,
        "oppositeAcrossLayersGeneratesANegativeDirectConnection" to ::oppositeAcrossLayersGeneratesANegativeDirectConnection,
        "aFullNeuronOnlyMakesRoomByDroppingAWeakerConnection" to ::aFullNeuronOnlyMakesRoomByDroppingAWeakerConnection,
        "growthNeverDriftsBackToAllToAll" to ::growthNeverDriftsBackToAllToAll,
        "stepsAreDeterministic" to ::stepsAreDeterministic,
        "saveAndRestoreIsExact" to ::saveAndRestoreIsExact
    )

    // ---------------------------------------------------------------- fixtures

    private val ins = (97..120).toList()           // 24 input bytes
    private val outs = (97..126).toList()          // 30 output bytes

    /** A dense, hub-dominated byte graph like the pretrained one: ~half of all pairs, one strong shared direction plus noise. */
    private fun dense(): List<ByteEdge> {
        val edges = ArrayList<ByteEdge>()
        for ((i, a) in ins.withIndex()) for ((o, b) in outs.withIndex()) {
            if ((i * 5 + o * 3) % 2 != 0) continue
            val u = 1f / (1f + i * 0.15f)
            val v = 1f / (1f + o * 0.1f)
            val noise = (((i * 31 + o * 17) % 11) - 5) * 0.03f
            edges.add(ByteEdge(a, b, 0.9f * u * v + noise))
        }
        return edges
    }

    private fun bare(inputs: List<Int> = emptyList(), outputs: List<Int> = emptyList()): SynapseGraph {
        val g = SynapseGraph()
        inputs.forEach { g.addNeuron(Nodes.input(it)) }
        outputs.forEach { g.addNeuron(Nodes.output(it)) }
        return g
    }

    private fun maxLeafDegree(g: SynapseGraph): Int =
        g.neuronIds().maxOfOrNull { g.degree(it) } ?: 0

    // ---------------------------------------------------------------- the starting shape

    private fun startsHubRoutedNotAllToAll() {
        val d = dense()
        val g = SynapseGraph()
        g.loadDense(d)
        check("far fewer connections than the dense graph: ${g.size} vs ${d.size}", g.size < d.size / 2)
        for (s in g.all()) {
            check("every link touches a hub", Nodes.role(s.from) == NodeRole.HUB || Nodes.role(s.to) == NodeRole.HUB)
            check("no byte links straight to a byte", !(Nodes.role(s.from) == NodeRole.INPUT && Nodes.role(s.to) == NodeRole.OUTPUT))
            check("weights stay in range", abs(s.weight) <= SynapseGraph.WEIGHT_MAX && abs(s.weight) >= SynapseGraph.PRUNE_BELOW)
        }
        val leafMax = g.neuronIds().maxOf { g.degree(it) }
        val hubMax = (0 until g.hubCount).maxOf { g.degree(Nodes.hub(it)) }
        check("a byte neuron holds at most ${SynapseGraph.HUBS_PER_LEAF} connections, got $leafMax", leafMax <= SynapseGraph.HUBS_PER_LEAF)
        check("hubs are the hubs: busiest hub $hubMax vs busiest byte $leafMax", hubMax > 4 * leafMax)
        check("all 54 byte neurons exist", g.neuronIds().size == ins.size + outs.size)
    }

    private fun hubRoutingKeepsMostOfTheRecall() {
        val d = dense()
        val g = SynapseGraph()
        g.loadDense(d)
        fun denseRecall(active: Collection<Int>, k: Int): Set<Int> {
            val score = HashMap<Int, Float>()
            for (e in d) if (e.fromByte in active) score[e.toByte] = (score[e.toByte] ?: 0f) + e.weight
            return score.entries.sortedWith(compareByDescending<Map.Entry<Int, Float>> { it.value }.thenBy { it.key }).take(k).map { it.key }.toSet()
        }
        val rng = Random(3)
        val cases = ins.map { listOf(it) } + List(200) { ins.shuffled(rng).take(rng.nextInt(3, 9)) }
        var overlap = 0f
        for (c in cases) overlap += g.recall(c, 5).toSet().intersect(denseRecall(c, 5)).size / 5f
        val mean = overlap / cases.size
        check("top-5 recall overlap with the dense graph is ${"%.2f".format(mean)}, want >= 0.6", mean >= 0.6f)
    }

    private fun signalsOnlyTravelForwardThroughLegalLinks() {
        val g = bare(listOf(97, 98), listOf(97, 98))
        check("input -> hub", g.connect(Nodes.input(97), Nodes.hub(0), 0.5f))
        check("hub -> output", g.connect(Nodes.hub(0), Nodes.output(97), 0.5f))
        check("input -> output shortcut", g.connect(Nodes.input(97), Nodes.output(98), 0.5f))
        check("hub -> later hub", g.connect(Nodes.hub(0), Nodes.hub(1), 0.5f))
        check("no hub -> earlier hub", !g.connect(Nodes.hub(1), Nodes.hub(0), 0.5f))
        check("no output -> input", !g.connect(Nodes.output(97), Nodes.input(97), 0.5f))
        check("no input -> input", !g.connect(Nodes.input(97), Nodes.input(98), 0.5f))
        check("no output -> hub", !g.connect(Nodes.output(97), Nodes.hub(0), 0.5f))
        check("no connecting a neuron that does not exist", !g.connect(Nodes.input(200), Nodes.hub(0), 0.5f))
    }

    private fun twoHopDriveIsTheProductOfTheWeights() {
        val g = bare(listOf(97), listOf(98))
        g.connect(Nodes.input(97), Nodes.hub(0), 0.5f)
        g.connect(Nodes.hub(0), Nodes.output(98), 0.4f)
        val drive = g.propagate(listOf(97))
        check("hub drive", abs(drive.getValue(Nodes.hub(0)) - 0.5f) < 1e-6f)
        check("output drive is 0.5 x 0.4", abs(drive.getValue(Nodes.output(98)) - 0.2f) < 1e-6f)
        check("nothing active, nothing driven", g.propagate(emptyList()).isEmpty())
        check("recall names the byte", g.recall(listOf(97)) == listOf(98))
    }

    // ---------------------------------------------------------------- fade and delete

    private fun aConnectionThatFadesToNothingIsDeletedButItsNeuronsStay() {
        val g = bare(listOf(97), listOf(98))
        check("made", g.connect(Nodes.input(97), Nodes.output(98), 0.03f))
        g.step(emptyList())
        check("one step of fading does not delete it", g.size == 1)
        var n = 1
        while (g.size > 0 && n < 500) { g.step(emptyList()); n++ }
        check("deleted once it faded to nothing (after $n steps)", g.size == 0)
        check("the neurons survive, so they can grow new connections", g.hasNeuron(Nodes.input(97)) && g.hasNeuron(Nodes.output(98)))
        check("the deletion is counted", g.totalPruned == 1)
    }

    private fun aConnectionWithNoWeightIsNeverMade() {
        val g = bare(listOf(97), listOf(98))
        check("zero weight is multiplying by nothing", !g.connect(Nodes.input(97), Nodes.output(98), 0f))
        check("so is a weight below the floor", !g.connect(Nodes.input(97), Nodes.output(98), SynapseGraph.PRUNE_BELOW / 2))
        check("not a number", !g.connect(Nodes.input(97), Nodes.output(98), Float.NaN))
        check("none exist", g.size == 0)
    }

    private fun connectionsUsedTogetherStrengthenInsteadOfFading() {
        val g = bare(listOf(97), listOf(98))
        g.connect(Nodes.input(97), Nodes.hub(0), 0.5f)
        g.connect(Nodes.hub(0), Nodes.output(98), 0.5f)
        repeat(20) { g.step(listOf(97)) }
        val a = g.weight(Nodes.input(97), Nodes.hub(0))!!
        val b = g.weight(Nodes.hub(0), Nodes.output(98))!!
        check("both stronger than they started: $a, $b", a > 0.5f && b > 0.5f)
        check("never deleted while in use", g.size >= 2)
    }

    private fun aConnectionContradictedByUseShrinksToNothingAndIsDeleted() {
        // x drives o1 up (strong +) and o2 down (strong -). A weak positive x->p link is contradicted whenever p is driven negative.
        val g = bare(listOf(97), listOf(98, 99))
        g.connect(Nodes.input(97), Nodes.output(98), 0.9f)
        g.connect(Nodes.hub(0), Nodes.output(99), -0.9f)
        g.connect(Nodes.input(97), Nodes.hub(0), 0.9f)
        g.connect(Nodes.input(97), Nodes.output(99), 0.1f)   // says "97 excites 99", but 99 is net negative
        var n = 0
        while (g.weight(Nodes.input(97), Nodes.output(99)) != null && n < 50) { g.step(listOf(97)); n++ }
        check("the contradicted connection was deleted (took $n steps)", g.weight(Nodes.input(97), Nodes.output(99)) == null)
        check("the ones that agree with use survived", g.weight(Nodes.input(97), Nodes.output(98)) != null)
    }

    // ---------------------------------------------------------------- generating connections

    /**
     * Inputs a and c fire together. a feeds hub 0 and c feeds hub 1, so hub 1 is high every time a fires but a has no
     * spoke to it (and no route to it through another hub): a and hub 1 are high together with nothing connecting them.
     */
    private fun missingSpokeGraph(): SynapseGraph {
        val g = bare(listOf(97, 99))
        g.connect(Nodes.input(97), Nodes.hub(0), 0.8f)
        g.connect(Nodes.input(99), Nodes.hub(1), 0.8f)
        return g
    }

    private fun highTogetherThreeTimesGeneratesAConnection() {
        val g = missingSpokeGraph()
        val a = Nodes.input(97)
        val h1 = Nodes.hub(1)
        g.step(listOf(97, 99)); check("not after 1", g.weight(a, h1) == null)
        g.step(listOf(97, 99)); check("not after 2", g.weight(a, h1) == null)
        val r = g.step(listOf(97, 99))
        val w = g.weight(a, h1)
        check("generated on the 3rd, excitatory", w != null && w > 0f)
        check("report counts what was formed", r.formed >= 1 && g.totalFormed == r.formed)
    }

    private fun twoTimesIsNotEnoughAndOldEvidenceExpires() {
        val g = missingSpokeGraph()
        val a = Nodes.input(97)
        val h1 = Nodes.hub(1)
        repeat(2) { g.step(listOf(97, 99)) }
        repeat(SynapseGraph.FORM_WINDOW_STEPS + 10) { g.step(emptyList()) }
        g.step(listOf(97, 99))
        check("two old sightings plus one new one is not three", g.weight(a, h1) == null)
        repeat(2) { g.step(listOf(97, 99)) }
        check("three sightings inside the window do generate it", g.weight(a, h1) != null)
    }

    /** The flaw the real graph exposed: pairs already routed through a hub were getting a second, direct link. */
    private fun aPairAlreadyRoutedThroughAHubDoesNotGetADirectShortcut() {
        val g = bare(listOf(97), listOf(98))
        g.connect(Nodes.input(97), Nodes.hub(0), 0.8f)
        g.connect(Nodes.hub(0), Nodes.output(98), 0.8f)
        repeat(20) { g.step(listOf(97)) }
        check("a and o are high together every time, yet stay routed through the hub", g.weight(Nodes.input(97), Nodes.output(98)) == null)
        check("no new connections at all", g.size == 2 && g.totalFormed == 0)
    }

    private fun sameLayerNeuronsAreTiedTogetherThroughAHub() {
        val g = bare(listOf(97, 98))
        repeat(2) { g.step(listOf(97, 98)) }
        check("nothing after 2", g.size == 0)
        g.step(listOf(97, 98))
        check("two spokes, one hub", g.size == 2)
        val hub = (0 until g.hubCount).firstOrNull {
            val w1 = g.weight(Nodes.input(97), Nodes.hub(it)); val w2 = g.weight(Nodes.input(98), Nodes.hub(it))
            w1 != null && w2 != null && w1 > 0f && w2 > 0f
        }
        check("both inputs feed the same hub with positive weight", hub != null)
        check("never a direct byte-to-byte link", g.all().none { Nodes.role(it.from) == NodeRole.INPUT && Nodes.role(it.to) == NodeRole.INPUT })
    }

    private fun oppositeThreeTimesGeneratesAnInhibitoryConnection() {
        val g = bare(listOf(97), listOf(98, 99))
        g.connect(Nodes.input(97), Nodes.output(98), 0.8f)    // 97 excites 98 ...
        g.connect(Nodes.input(97), Nodes.output(99), -0.8f)   // ... and suppresses 99: they are always opposite
        repeat(2) { g.step(listOf(97)) }
        check("nothing generated after 2 opposites", g.size == 2)
        g.step(listOf(97))
        val hub = (0 until g.hubCount).firstOrNull {
            val w1 = g.weight(Nodes.hub(it), Nodes.output(98)); val w2 = g.weight(Nodes.hub(it), Nodes.output(99))
            w1 != null && w2 != null && w1 > 0f && w2 < 0f
        }
        check("a hub now excites one and inhibits the other", hub != null)
    }

    private fun oppositeAcrossLayersGeneratesANegativeDirectConnection() {
        val g = bare(listOf(97), listOf(98))
        g.connect(Nodes.input(97), Nodes.hub(0), 0.8f)
        g.connect(Nodes.input(97), Nodes.hub(1), 0.8f)
        g.connect(Nodes.hub(1), Nodes.output(98), -0.8f)      // o goes strongly negative; hub 0 is high but has no link to o
        repeat(3) { g.step(listOf(97)) }
        val w = g.weight(Nodes.hub(0), Nodes.output(98))
        check("hub 0 -> o was generated, and negative: $w", w != null && w < 0f)
    }

    private fun aFullNeuronOnlyMakesRoomByDroppingAWeakerConnection() {
        val g = bare((97..104).toList(), listOf(110, 111))
        val o = Nodes.output(110)
        val p = Nodes.output(111)
        for (b in 97..104) g.connect(Nodes.input(b), o, 0.9f)    // o is full, every connection strong
        g.connect(Nodes.input(97), p, 0.9f)
        check("o starts full", g.degree(o) == SynapseGraph.MAX_LEAF_DEGREE)
        repeat(5) { g.step(listOf(97)) }                          // o and p fire together; they want a hub, but o has no room
        check("o stayed at the cap", g.degree(o) == SynapseGraph.MAX_LEAF_DEGREE)
        check("no hub link was forced in", (0 until g.hubCount).none { g.weight(Nodes.hub(it), o) != null })

        g.connect(Nodes.input(104), o, 0.05f)                     // now one of o's connections is weak
        g.step(listOf(97))
        check("o still at the cap", g.degree(o) == SynapseGraph.MAX_LEAF_DEGREE)
        check("the weak one was dropped", g.weight(Nodes.input(104), o) == null)
        check("a hub link took its place", (0 until g.hubCount).any { g.weight(Nodes.hub(it), o) != null })
    }

    // ---------------------------------------------------------------- the whole thing, over time

    private fun workload(g: SynapseGraph, steps: Int, seed: Int) {
        val rng = Random(seed)
        repeat(steps) { g.step(ins.shuffled(rng).take(rng.nextInt(2, 14))) }
    }

    private fun growthNeverDriftsBackToAllToAll() {
        val d = dense()
        val g = SynapseGraph()
        g.loadDense(d)
        workload(g, 1500, seed = 11)
        check("no byte neuron above the cap: ${maxLeafDegree(g)}", g.neuronIds().all { g.degree(it) <= SynapseGraph.MAX_LEAF_DEGREE })
        val possible = ins.size * outs.size
        check("still sparse: ${g.size} connections vs $possible possible pairs", g.size < possible / 3)
        val hubMax = (0 until g.hubCount).maxOf { g.degree(Nodes.hub(it)) }
        check("hubs are still the busiest nodes", hubMax > maxLeafDegree(g))
        check("it did grow and prune: formed ${g.totalFormed}, pruned ${g.totalPruned}", g.totalFormed > 0 && g.totalPruned > 0)
        check("every weight in range", g.all().all { abs(it.weight) <= SynapseGraph.WEIGHT_MAX && abs(it.weight) >= SynapseGraph.PRUNE_BELOW })
    }

    private fun stepsAreDeterministic() {
        val a = SynapseGraph(); val b = SynapseGraph()
        a.loadDense(dense()); b.loadDense(dense())
        workload(a, 400, seed = 5); workload(b, 400, seed = 5)
        val x = a.all().map { Triple(it.from, it.to, it.weight) }
        val y = b.all().map { Triple(it.from, it.to, it.weight) }
        check("same history, same graph", x == y)
    }

    private fun saveAndRestoreIsExact() {
        val g = SynapseGraph()
        g.loadDense(dense())
        workload(g, 300, seed = 9)
        val copy = SynapseGraph()
        copy.restore(g.neuronIds(), g.all(), g.steps, g.totalFormed, g.totalPruned)
        check("same connections", g.all().map { Triple(it.from, it.to, it.weight) } == copy.all().map { Triple(it.from, it.to, it.weight) })
        check("same neurons", g.neuronIds() == copy.neuronIds())
        check("same counters", g.steps == copy.steps && g.totalFormed == copy.totalFormed && g.totalPruned == copy.totalPruned)
        check("same recall", g.recall(listOf(97, 100, 105), 5) == copy.recall(listOf(97, 100, 105), 5))
    }
}
