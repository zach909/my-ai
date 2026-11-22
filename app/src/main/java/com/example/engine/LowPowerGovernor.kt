package com.example.engine

import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * Low power mode: when the battery is low and unplugged, run fewer neurons.
 *
 * The battery level that triggers it (the threshold) adapts to how often it has been crossed:
 * - crossed MORE times recently -> the threshold LOWERS (low power engages later),
 * - crossed FEWER times recently -> the threshold RISES (low power engages sooner).
 *
 * The threshold is derived from the recent crossing history each time, not nudged cumulatively, so it can
 * never drift out of range and old crossings fade as they leave the window. Pure logic, no Android types.
 */
class LowPowerGovernor(
    private val totalNeurons: Int,
    private val baseThreshold: Float = 0.30f,
    private val minThreshold: Float = 0.10f,
    private val maxThreshold: Float = 0.50f,
    /** How far each crossing above / below [targetCrossings] moves the threshold. */
    private val stepPerCrossing: Float = 0.03f,
    /** Crossings per window that leave the threshold at [baseThreshold]. */
    private val targetCrossings: Int = 2,
    private val windowMs: Long = 24L * 60 * 60 * 1000,
    /** Low power ends once the level is this far above the threshold (stops flip-flopping at the edge). */
    private val exitMargin: Float = 0.05f,
    /** Never run fewer than this share of the neurons. */
    private val minNeuronFraction: Float = 0.25f,
    initialCrossings: List<Long> = emptyList(),
) {
    private val crossings = ArrayDeque(initialCrossings.sorted())

    /** True while low power mode is on. */
    var active: Boolean = false
        private set

    /** Timestamps (ms) of recent crossings, so the caller can persist them. */
    fun crossingTimes(): List<Long> = crossings.toList()

    /** The current threshold: lower when crossed often in the window, higher when rarely. */
    fun threshold(nowMs: Long): Float {
        prune(nowMs)
        val raw = baseThreshold - stepPerCrossing * (crossings.size - targetCrossings)
        return raw.coerceIn(minThreshold, maxThreshold)
    }

    /**
     * Feed the latest battery reading ([level] is 0..1) and get how many neurons to run.
     * Entering low power (not low -> low) counts as one crossing.
     */
    fun activeNeurons(level: Float, charging: Boolean, nowMs: Long): Int {
        val t = threshold(nowMs)
        val lvl = level.coerceIn(0f, 1f)
        if (charging) {
            active = false
        } else if (!active && lvl <= t) {
            active = true
            crossings.addLast(nowMs)
        } else if (active && lvl >= t + exitMargin) {
            active = false
        }
        if (!active) return totalNeurons
        // Fewer neurons the further below the threshold, floored at minNeuronFraction.
        val fraction = (lvl / max(t, 0.01f)).coerceIn(minNeuronFraction, 1f)
        return min(totalNeurons, max(1, ceil(totalNeurons * fraction).toInt()))
    }

    private fun prune(nowMs: Long) {
        while (crossings.isNotEmpty() && nowMs - crossings.first() > windowMs) crossings.removeFirst()
    }
}
