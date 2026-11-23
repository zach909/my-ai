package com.example.engine

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sqrt
import kotlin.random.Random

/**
 * Pure Kotlin Hyperdimensional Vector matching asi_core/hyperdim_thinking.py:
 * partitioned into semantic (40%), context (25%), value (10%), temporary (15%), and meta (10%).
 */
class HDVector(
    val data: FloatArray,
    val bounds: IntArray
) {
    val dimensions: Int get() = data.size

    fun copy(): HDVector = HDVector(data.copyOf(), bounds.copyOf())

    fun norm(): Float {
        var sum = 0f
        for (v in data) sum += v * v
        return sqrt(sum).coerceAtLeast(1e-6f)
    }

    fun normalized(): HDVector {
        val n = norm()
        return HDVector(FloatArray(data.size) { i -> data[i] / n }, bounds.copyOf())
    }

    fun semanticSlice(): FloatArray = data.copyOfRange(0, bounds[0])
    fun contextSlice(): FloatArray = data.copyOfRange(bounds[0], bounds[1])
    fun valueSlice(): FloatArray = data.copyOfRange(bounds[1], bounds[2])
    fun tempSlice(): FloatArray = data.copyOfRange(bounds[2], bounds[3])
    fun metaSlice(): FloatArray = data.copyOfRange(bounds[3], bounds[4])

    companion object {
        private const val SEM_FRAC = 0.40f
        private const val CTX_FRAC = 0.25f
        private const val VAL_FRAC = 0.10f
        private const val TMP_FRAC = 0.15f

        fun computeBounds(dimensions: Int): IntArray {
            val sem = max(1, (dimensions * SEM_FRAC).roundToInt())
            val ctx = max(1, (dimensions * CTX_FRAC).roundToInt())
            val valSz = max(1, (dimensions * VAL_FRAC).roundToInt())
            val tmp = max(1, (dimensions * TMP_FRAC).roundToInt())
            val meta = max(1, dimensions - sem - ctx - valSz - tmp)
            val b0 = sem
            val b1 = b0 + ctx
            val b2 = b1 + valSz
            val b3 = b2 + tmp
            val b4 = b3 + meta
            return intArrayOf(b0, b1, b2, b3, b4)
        }

        fun zeros(dimensions: Int): HDVector {
            val b = computeBounds(dimensions)
            return HDVector(FloatArray(b[4]), b)
        }

        fun random(dimensions: Int, seed: Long): HDVector {
            val rng = Random(seed)
            val b = computeBounds(dimensions)
            val arr = FloatArray(b[4]) { rng.nextFloat() * 2f - 1f }
            return HDVector(arr, b).normalized()
        }

        /**
         * Raw byte-level encoding (no tokenizer, honoring NeuroClaw's Zip Loop principle):
         * projects UTF-8 byte n-grams directly into the hypervector subspaces.
         */
        fun encodeBytes(bytes: ByteArray, dimensions: Int): HDVector {
            val b = computeBounds(dimensions)
            val vec = FloatArray(b[4])
            if (bytes.isEmpty()) return HDVector(vec, b)
            for (idx in bytes.indices) {
                val byteVal = bytes[idx].toInt() and 0xFF
                val nextVal = if (idx + 1 < bytes.size) (bytes[idx + 1].toInt() and 0xFF) else 0
                val h1 = ((byteVal * 2654435761L) xor (idx * 31L)).toInt()
                val h2 = (((byteVal shl 8) or nextVal) * 2246822519L).toInt()
                val pos1 = abs(h1) % b[4]
                val pos2 = abs(h2) % b[4]
                val sign1 = if ((byteVal and 1) == 0) 1f else -1f
                val sign2 = if (((byteVal + nextVal) and 1) == 0) 1f else -1f
                vec[pos1] += sign1 * (0.6f + (byteVal / 255f) * 0.4f)
                vec[pos2] += sign2 * 0.5f
            }
            return HDVector(vec, b).normalized()
        }

        fun bind(a: HDVector, b: HDVector): HDVector {
            val len = minOf(a.dimensions, b.dimensions)
            val out = FloatArray(len) { i -> a.data[i] * b.data[i] }
            return HDVector(out, a.bounds.copyOf())
        }

        fun bundle(a: HDVector, b: HDVector, weightA: Float = 0.5f, weightB: Float = 0.5f): HDVector {
            val len = minOf(a.dimensions, b.dimensions)
            val out = FloatArray(len) { i -> a.data[i] * weightA + b.data[i] * weightB }
            return HDVector(out, a.bounds.copyOf()).normalized()
        }

        fun permute(a: HDVector, shift: Int = 1): HDVector {
            val len = a.dimensions
            val out = FloatArray(len)
            val s = ((shift % len) + len) % len
            for (i in 0 until len) {
                out[(i + s) % len] = a.data[i]
            }
            return HDVector(out, a.bounds.copyOf())
        }

        fun cosineSimilarity(a: HDVector, b: HDVector): Float {
            val len = minOf(a.dimensions, b.dimensions)
            var dot = 0f
            var na = 0f
            var nb = 0f
            for (i in 0 until len) {
                dot += a.data[i] * b.data[i]
                na += a.data[i] * a.data[i]
                nb += b.data[i] * b.data[i]
            }
            val denom = sqrt(na * nb)
            return if (denom < 1e-8f) 0f else (dot / denom).coerceIn(-1f, 1f)
        }
    }
}
