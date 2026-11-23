package com.example.engine

import kotlin.math.abs

// Dependency-free checks for the island mesh (the project takes no third-party code, so no JUnit).
// Pure Kotlin, no Android types. Run from the repo root with any Kotlin compiler, for example:
//   kotlinc app/src/main/java/com/example/engine/HDVector.kt app/src/main/java/com/example/engine/IslandMesh.kt \
//     app/src/test/java/com/example/engine/IslandMeshChecks.kt -include-runtime -d /tmp/island-checks.jar \
//     && java -jar /tmp/island-checks.jar
// Exits non-zero if any check fails.

fun assertTrue(cond: Boolean) { if (!cond) throw AssertionError("expected true") }
fun assertTrue(message: String, cond: Boolean) { if (!cond) throw AssertionError(message) }
fun assertFalse(cond: Boolean) { if (cond) throw AssertionError("expected false") }
fun assertFalse(message: String, cond: Boolean) { if (cond) throw AssertionError(message) }
fun assertEquals(expected: Any?, actual: Any?) { if (expected != actual) throw AssertionError("expected <$expected> but was <$actual>") }
fun assertEquals(expected: Float, actual: Float, delta: Float) {
    if (abs(expected - actual) > delta) throw AssertionError("expected <$expected> but was <$actual>")
}
fun assertEquals(message: String, expected: Any?, actual: Any?) { if (expected != actual) throw AssertionError("$message: expected <$expected> but was <$actual>") }
fun assertNull(x: Any?) { if (x != null) throw AssertionError("expected null") }
fun assertNotNull(x: Any?) { if (x == null) throw AssertionError("expected not null") }

fun main() {
    val c = IslandMeshChecks()
    var failed = 0
    for ((name, run) in c.all()) {
        try { run(); println("ok   $name") } catch (t: Throwable) { failed++; println("FAIL $name: ${t.message}") }
    }
    println("${c.all().size} checks, $failed failed")
    if (failed > 0) kotlin.system.exitProcess(1)
}

class IslandMeshChecks {
    fun all(): List<Pair<String, () -> Unit>> = listOf(
        "startsAsFrozenCorePlusSelf" to ::startsAsFrozenCorePlusSelf,
        "wakeChangesNoWeightsOnlyRemembersNovelExperience" to ::wakeChangesNoWeightsOnlyRemembersNovelExperience,
        "tooShortOrDuplicateExperiencesAreNotKept" to ::tooShortOrDuplicateExperiencesAreNotKept,
        "wantsToSleepOnlyOncePressureBuilds" to ::wantsToSleepOnlyOncePressureBuilds,
        "sleepGrowsNewIslandsFromNovelExperienceAndConservesVale" to ::sleepGrowsNewIslandsFromNovelExperienceAndConservesVale,
        "coreBaseIsNeverTrained" to ::coreBaseIsNeverTrained,
        "learningOneIslandLeavesEveryOtherIslandUntouched" to ::learningOneIslandLeavesEveryOtherIslandUntouched,
        "newIslandsAreTrainedOnTheirOwnContent" to ::newIslandsAreTrainedOnTheirOwnContent,
        "relearningSameContentIsANoOpAndChangedContentRetrainsInPlace" to ::relearningSameContentIsANoOpAndChangedContentRetrainsInPlace,
        "familiarExperienceIsNotBufferedAndStrengthensItsIsland" to ::familiarExperienceIsNotBufferedAndStrengthensItsIsland,
        "sleepingOnSomethingFamiliarReinforcesInsteadOfGrowing" to ::sleepingOnSomethingFamiliarReinforcesInsteadOfGrowing,
        "redundantNeuronsArePruned" to ::redundantNeuronsArePruned,
        "capForgetsOldUnusedMemoriesButNeverSkillsOrCore" to ::capForgetsOldUnusedMemoriesButNeverSkillsOrCore,
        "fullMeshWithNothingForgettableRefusesToGrow" to ::fullMeshWithNothingForgettableRefusesToGrow,
        "dreamingIsMeasuredOnCuesItNeverRehearsedAndIsDeterministic" to ::dreamingIsMeasuredOnCuesItNeverRehearsedAndIsDeterministic,
        "dreamingTouchesOnlyLearnedIslands" to ::dreamingTouchesOnlyLearnedIslands,
        "selfIslandTracksWhatHasBeenLearnedAndDescribesIt" to ::selfIslandTracksWhatHasBeenLearnedAndDescribesIt,
        "selfWithNothingLearnedSaysSo" to ::selfWithNothingLearnedSaysSo,
        "valeStaysConservedThroughGrowthPruningAndUse" to ::valeStaysConservedThroughGrowthPruningAndUse
    )


    private val dim = 64
    private val enc = IslandMesh(dim)::encode

    private val topics = listOf(
        "The Schwarzschild radius of a black hole grows linearly with its mass",
        "Grover search finds a marked item among N in about root N iterations",
        "Photosynthesis in the chloroplast converts light and water into sugar",
        "A thin lens focuses parallel rays at a distance of one focal length",
        "Molar mass is the sum of the atomic masses of every atom in the molecule",
        "Binary addition carries a one into the next column when two ones meet"
    )

    private fun states(i: Island) = i.neurons.map { it.state.data.copyOf() }
    private fun sameStates(a: List<FloatArray>, b: List<FloatArray>) =
        a.size == b.size && a.indices.all { a[it].contentEquals(b[it]) }

    private fun assertValeConserved(m: IslandMesh) {
        val sum = m.neurons.sumOf { it.vale.toDouble() }.toFloat()
        assertTrue("vale ${sum} vs ${m.valeTotal}", abs(sum - m.valeTotal) < 0.01f)
    }

    private fun wakeAll(m: IslandMesh, texts: List<String>, cycle0: Int = 1) =
        texts.forEachIndexed { i, t -> m.wake(t, cycle0 + i, 1000L + i) }

    fun startsAsFrozenCorePlusSelf() {
        val m = IslandMesh()
        assertEquals(34, m.neuronCount)
        assertEquals(34f, m.valeTotal, 0f)
        assertTrue(m.learned().isEmpty())
        assertValeConserved(m)
    }

    fun wakeChangesNoWeightsOnlyRemembersNovelExperience() {
        val m = IslandMesh()
        val before = m.neurons.map { it.state.data.copyOf() to it.vale }
        wakeAll(m, topics.take(3))
        val after = m.neurons.map { it.state.data to it.vale }
        assertEquals(before.size, after.size)
        for (i in before.indices) {
            assertTrue(before[i].first.contentEquals(after[i].first))
            assertEquals(before[i].second, after[i].second, 0f)
        }
        assertEquals(3, m.shortTerm.size)
        assertEquals(34, m.neuronCount)
    }

    fun tooShortOrDuplicateExperiencesAreNotKept() {
        val m = IslandMesh()
        m.wake("hi", 1, 0L)
        m.wake(topics[0], 2, 0L)
        m.wake(topics[0], 3, 0L)
        assertEquals(1, m.shortTerm.size)
    }

    fun wantsToSleepOnlyOncePressureBuilds() {
        val m = IslandMesh()
        wakeAll(m, topics.take(1))
        assertFalse(m.shouldSleep())
        wakeAll(m, topics.drop(1).take(3), cycle0 = 2)
        assertTrue(m.shouldSleep())
    }

    fun sleepGrowsNewIslandsFromNovelExperienceAndConservesVale() {
        val m = IslandMesh()
        wakeAll(m, topics.take(4))
        val report = m.sleep(10, 5000L)
        assertTrue(report.newIslands.isNotEmpty())
        assertTrue(report.neuronsAdded >= IslandMesh.MIN_ISLAND_NEURONS)
        assertEquals(34 + report.neuronsAdded - report.neuronsPruned, m.neuronCount)
        assertTrue(m.shortTerm.isEmpty())
        assertValeConserved(m)
        for (i in m.learned()) assertTrue(i.neurons.size in IslandMesh.MIN_ISLAND_NEURONS..IslandMesh.MAX_ISLAND_NEURONS)
    }

    fun coreBaseIsNeverTrained() {
        val m = IslandMesh()
        val core = states(m.core)
        wakeAll(m, topics)
        m.sleep(20, 1L)
        m.learnNow("skill:x", IslandKind.SKILL, "X", listOf("compile neuron definitions"), "test", 21, 2L)
        m.sleep(30, 3L)
        assertTrue(sameStates(core, states(m.core)))
    }

    fun learningOneIslandLeavesEveryOtherIslandUntouched() {
        val m = IslandMesh()
        val a = m.learnNow("skill:a", IslandKind.SKILL, "Optics", listOf(topics[3], "lens focal length ray"), "t", 1, 1L)!!
        val aBefore = states(a)
        val coreBefore = states(m.core)
        val b = m.learnNow("skill:b", IslandKind.SKILL, "Logic", listOf(topics[5], "binary carry column"), "t", 2, 2L)!!
        assertNotNull(b)
        assertTrue("island A was changed by learning B", sameStates(aBefore, states(a)))
        assertTrue(sameStates(coreBefore, states(m.core)))
        assertValeConserved(m)
    }

    fun newIslandsAreTrainedOnTheirOwnContent() {
        val m = IslandMesh()
        val text = topics[0]
        val island = m.learnNow("skill:bh", IslandKind.SKILL, "Black holes", listOf(text), "t", 1, 1L)!!
        val own = island.score(enc(text))
        val other = island.score(enc(topics[5]))
        assertTrue("own=$own other=$other", own > 0.8f)
        assertTrue(own > other)
    }

    fun relearningSameContentIsANoOpAndChangedContentRetrainsInPlace() {
        val m = IslandMesh()
        val i1 = m.learnNow("skill:s", IslandKind.SKILL, "S", listOf(topics[1]), "t", 1, 1L)!!
        val n = m.neuronCount
        val snap = states(i1)
        val i2 = m.learnNow("skill:s", IslandKind.SKILL, "S", listOf(topics[1]), "t", 2, 2L)!!
        assertTrue(i1 === i2)
        assertTrue(sameStates(snap, states(i2)))
        val i3 = m.learnNow("skill:s", IslandKind.SKILL, "S", listOf(topics[2]), "t", 3, 3L)!!
        assertEquals(n, m.neuronCount)
        assertFalse(sameStates(snap, states(i3)))
    }

    fun familiarExperienceIsNotBufferedAndStrengthensItsIsland() {
        val m = IslandMesh()
        val isl = m.learnNow("skill:bh", IslandKind.SKILL, "Black holes", listOf(topics[0]), "t", 1, 1L)!!
        val routed = m.wake(topics[0], 2, 2L)
        assertTrue(routed.first().first === isl)
        assertEquals(1, isl.uses)
        assertTrue(m.shortTerm.isEmpty())
    }

    fun sleepingOnSomethingFamiliarReinforcesInsteadOfGrowing() {
        val m = IslandMesh()
        val isl = m.learnNow("skill:bh", IslandKind.SKILL, "Black holes", listOf(topics[0]), "t", 1, 1L)!!
        val n = m.neuronCount
        // A buffered episode that the island recognises well: force it in via the same text with a slight tail.
        m.shortTerm.add(Episode(enc(topics[0]), topics[0], 0.9f, 1L))
        val r = m.sleep(5, 5L, dream = false)
        assertEquals(n, m.neuronCount)
        assertTrue(r.newIslands.isEmpty())
        assertEquals(1, isl.reinforcements)
    }

    fun redundantNeuronsArePruned() {
        val m = IslandMesh()
        // Two near-identical experiences in one cluster still make one island, and no two of its neurons stay duplicates.
        m.shortTerm.add(Episode(enc(topics[0]), topics[0], 0.9f, 1L))
        m.shortTerm.add(Episode(enc(topics[0]), topics[0] + " ", 0.9f, 2L))
        m.sleep(3, 3L, dream = false)
        val isl = m.learned().single()
        for (i in isl.neurons.indices) for (j in i + 1 until isl.neurons.size) {
            if (isl.neurons.size > IslandMesh.MIN_ISLAND_NEURONS) {
                assertTrue(HDVector.cosineSimilarity(isl.neurons[i].state, isl.neurons[j].state) < IslandMesh.PRUNE_SIM)
            }
        }
        assertValeConserved(m)
    }

    fun capForgetsOldUnusedMemoriesButNeverSkillsOrCore() {
        val m = IslandMesh(maxNeurons = 40)
        val skill = m.learnNow("skill:keep", IslandKind.SKILL, "Keep", listOf(topics[0]), "t", 1, 1L)!!
        m.learnNow("mem:old", IslandKind.MEMORY, "Old", listOf(topics[1]), "t", 2, 2L)!!
        // Mesh is 34 + 2 + 2 = 38. Four new neurons need 42 > 40, so the unused memory (2) must go: 36 + 4 = 40.
        m.wake("a long enough message to advance the clock", 100, 3L)
        val fresh = m.learnNow("mem:new", IslandKind.MEMORY, "New", listOf(topics[2], topics[3], topics[4], topics[5]), "t", 101, 4L)
        assertNotNull(fresh)
        assertTrue(m.neuronCount <= 40)
        assertNull(m.islands["mem:old"])
        assertNotNull(m.islands[skill.id])
        assertNotNull(m.islands["core"])
        assertValeConserved(m)
    }

    fun fullMeshWithNothingForgettableRefusesToGrow() {
        val m = IslandMesh(maxNeurons = 36)
        // Three teachers need 3 neurons: 34 + 3 = 37 > 36, and a skill island is never forgotten to make room.
        val r = m.learnNow("skill:big", IslandKind.SKILL, "Big", listOf(topics[0], topics[1], topics[2]), "t", 1, 1L)
        assertNull(r)
        assertEquals(34, m.neuronCount)
    }

    fun dreamingIsMeasuredOnCuesItNeverRehearsedAndIsDeterministic() {
        fun run(): DreamReport {
            val m = IslandMesh()
            m.learnNow("skill:a", IslandKind.SKILL, "Black holes", listOf(topics[0], "event horizon escape velocity"), "t", 1, 1L)
            m.learnNow("skill:b", IslandKind.SKILL, "Quantum", listOf(topics[1], "qubit measurement grover"), "t", 2, 2L)
            m.learnNow("skill:c", IslandKind.SKILL, "Optics", listOf(topics[3], "lens photon wavelength"), "t", 3, 3L)
            return m.sleep(10, 10L).dream!!
        }
        val a = run()
        val b = run()
        assertEquals(a, b)
        assertTrue(a.cues == 9 && a.rehearsed > 0)
        assertTrue("before=${a.recallBefore} after=${a.recallAfter}", a.recallAfter >= a.recallBefore)
    }

    fun dreamingTouchesOnlyLearnedIslands() {
        val m = IslandMesh()
        val core = states(m.core)
        m.learnNow("skill:a", IslandKind.SKILL, "A", listOf(topics[0]), "t", 1, 1L)
        m.sleep(5, 5L)
        assertTrue(sameStates(core, states(m.core)))
    }

    fun selfIslandTracksWhatHasBeenLearnedAndDescribesIt() {
        val m = IslandMesh()
        val s0 = m.islands.getValue("self").neurons[0].state.data.copyOf()
        m.learnNow("skill:a", IslandKind.SKILL, "Black holes", listOf(topics[0]), "growth", 1, 1L)
        m.learnNow("skill:b", IslandKind.SKILL, "Quantum", listOf(topics[1]), "growth", 2, 2L)
        m.sleep(5, 5L)
        assertFalse(s0.contentEquals(m.islands.getValue("self").neurons[0].state.data))
        assertTrue(m.selfAccuracy() > 0.5f)
        val text = m.describeSelf(0.2f)
        assertTrue(text, text.contains("2 skill island(s)"))
        assertTrue(text, text.contains("32 frozen base neurons"))
        assertTrue(text, text.contains("Black holes") || text.contains("Quantum"))
        assertTrue(text.contains("not a claim to be aware"))
    }

    fun selfWithNothingLearnedSaysSo() {
        val text = IslandMesh().describeSelf(0.18f)
        assertTrue(text, text.contains("not grown anything yet"))
        assertTrue(text, text.contains("not slept yet"))
    }

    fun valeStaysConservedThroughGrowthPruningAndUse() {
        val m = IslandMesh()
        repeat(3) { r ->
            wakeAll(m, topics, cycle0 = r * 10 + 1)
            m.sleep(r * 10 + 9, 1L)
            m.redistributeVale(m.neurons[r], 0.08f)
            assertValeConserved(m)
        }
    }
}
