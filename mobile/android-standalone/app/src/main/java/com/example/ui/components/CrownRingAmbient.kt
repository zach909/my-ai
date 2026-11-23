package com.example.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import com.example.ui.theme.LocalNeuroPalette
import com.example.ui.theme.NeuroPalette
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Native Jetpack Compose Canvas 2D implementation of interface/ambient.ts:
 * - Adaptive Light/Dark/Dynamic ground with drifting radial glows
 * - 3D-projected barrel-tucked Crown Ring (6 rises, 6 dips) flipping end-over-end
 * - Central glowing sphere containing the animated green Shoggoth mascot with
 *   many eyes and a little yellow smiley face
 * - Green skill tentacles reaching toward the crown (one per active skill region)
 * - Breaking-ring / hollow-sphere mode when the alignment protocol removes the agent
 */
@Composable
fun CrownRingAmbient(
    enabled: Boolean,
    reducedMotion: Boolean,
    agentAlive: Boolean,
    energyPulse: Float,
    skillNames: List<String>,
    modifier: Modifier = Modifier
) {
    val palette = LocalNeuroPalette.current
    // Precompute the 3D crown ring cord geometry (exact proportions from interface/ambient.ts)
    val cord = remember { CrownCordGeometry(count = 288) }

    var animTimeSec by remember { mutableFloatStateOf(0.6f) }
    var smoothEnergy by remember { mutableFloatStateOf(0f) }
    var lastFrameNanos by remember { mutableLongStateOf(0L) }

    LaunchedEffect(enabled, reducedMotion) {
        if (!enabled || reducedMotion) return@LaunchedEffect
        lastFrameNanos = 0L
        while (true) {
            withFrameNanos { nanos ->
                val prev = lastFrameNanos
                lastFrameNanos = nanos
                if (prev > 0L) {
                    val dt = ((nanos - prev) / 1_000_000_000f).coerceIn(0f, 0.05f)
                    smoothEnergy += (energyPulse - smoothEnergy) * (1f - kotlin.math.exp(-dt * 4f))
                    animTimeSec += dt * (1f + smoothEnergy * 2.8f)
                }
            }
        }
    }

    Canvas(modifier = modifier.fillMaxSize()) {
        // Base adaptive radial ground
        drawRect(
            brush = Brush.radialGradient(
                colors = listOf(palette.groundSecondary, palette.ground),
                center = Offset(size.width * 0.5f, size.height * 0.4f),
                radius = max(size.width, size.height) * 0.9f
            )
        )

        if (!enabled) return@Canvas

        val t = if (reducedMotion) 0.4f else animTimeSec
        val maxDim = max(size.width, size.height)

        // Drifting atmospheric glows
        val glowACenter = Offset(
            size.width * (0.12f + 0.08f * sin(t * 0.14f)),
            size.height * (0.14f + 0.06f * cos(t * 0.11f))
        )
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(palette.ambientGlowA, Color.Transparent),
                center = glowACenter,
                radius = maxDim * 0.46f
            ),
            radius = maxDim * 0.46f,
            center = glowACenter
        )
        val glowBCenter = Offset(
            size.width * (0.86f - 0.07f * cos(t * 0.10f)),
            size.height * (0.84f - 0.06f * sin(t * 0.13f))
        )
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(palette.ambientGlowB, Color.Transparent),
                center = glowBCenter,
                radius = maxDim * 0.40f
            ),
            radius = maxDim * 0.40f,
            center = glowBCenter
        )

        val cx = size.width * 0.5f
        val cy = size.height * 0.5f
        val tanHalf = kotlin.math.tan((40.0 * PI) / 360.0).toFloat()
        val aspect = if (size.height > 0f) size.width / size.height else 1f
        val need = 1.85f
        val dist = max(need / tanHalf, need / (tanHalf * max(0.4f, aspect)))
        val focal = (size.height * 0.5f) / tanHalf
        val sphereRadius = 0.92f * (focal / dist) * (1f + if (reducedMotion) 0f else sin(t * 1.4f) * 0.018f + smoothEnergy * 0.04f)

        if (!agentAlive) {
            // Hollow sphere when the alignment protocol has removed the agent
            drawCircle(
                color = palette.hollowSphereFill,
                radius = sphereRadius,
                center = Offset(cx, cy)
            )
            drawCircle(
                color = palette.primaryLine.copy(alpha = 0.25f),
                radius = sphereRadius,
                center = Offset(cx, cy),
                style = Stroke(width = 2.5f)
            )
            return@Canvas
        }

        // Project and depth-sort crown ring beads
        val a = t * 0.82f
        val b = if (reducedMotion) 0.2f else sin(t * 0.30f) * 0.55f
        val c = if (reducedMotion) 0.1f else sin(t * 0.21f) * 0.40f
        val ca = cos(a); val sa = sin(a)
        val cb = cos(b); val sb = sin(b)
        val cc = cos(c); val sc = sin(c)

        val m00 = cb * cc; val m01 = -cb * sc; val m02 = sb
        val m10 = ca * sc + sa * sb * cc; val m11 = ca * cc - sa * sb * sc; val m12 = -sa * cb
        val m20 = sa * sc - ca * sb * cc; val m21 = sa * cc + ca * sb * sc; val m22 = ca * cb

        val proj = cord.project(cx, cy, dist, focal, m00, m01, m02, m10, m11, m12, m20, m21, m22)

        // Back half of crown ring (Z <= 0)
        drawCordHalf(proj, front = false, beadBase = cord.beadRadius, palette = palette)

        // Central glass sphere + green skill tentacles + Shoggoth mascot
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(palette.sphereCore, palette.sphereEdge),
                center = Offset(cx - sphereRadius * 0.24f, cy - sphereRadius * 0.28f),
                radius = sphereRadius * 1.2f
            ),
            radius = sphereRadius,
            center = Offset(cx, cy)
        )
        drawSkillTentacles(cx, cy, sphereRadius, t, skillNames, palette)
        drawShoggothMascot(cx, cy, sphereRadius * 0.50f, t, reducedMotion, palette)

        // Sphere specular rim
        drawCircle(
            color = palette.sphereRim,
            radius = sphereRadius,
            center = Offset(cx, cy),
            style = Stroke(width = 2.2f)
        )

        // Front half of crown ring (Z > 0)
        drawCordHalf(proj, front = true, beadBase = cord.beadRadius, palette = palette)
    }
}

private fun DrawScope.drawCordHalf(
    proj: Array<ProjectedBead>,
    front: Boolean,
    beadBase: Float,
    palette: NeuroPalette
) {
    val backBeadTone = if (palette.isDark) {
        lerp(palette.coralDeep, Color(0xFF4A2521), 0.35f)
    } else {
        lerp(palette.coralDeep, Color(0xFF74322A), 0.35f)
    }
    val frontBeadTone = if (palette.isDark) {
        lerp(palette.coralAccent, palette.coralSoft, 0.35f)
    } else {
        lerp(palette.coralAccent, palette.ground, 0.08f)
    }
    val specularTint = if (palette.isDark) palette.coralSoft else Color.White

    for (p in proj) {
        val isFront = p.z > 0f
        if (isFront != front) continue
        val shade = ((p.z + 1.5f) / 3.0f).coerceIn(0f, 1f)
        val beadColor = lerp(backBeadTone, frontBeadTone, shade).copy(alpha = if (palette.isDark) 0.95f else 0.88f)
        val radius = max(2f, beadBase * p.scale)
        drawCircle(
            color = beadColor,
            radius = radius,
            center = Offset(p.x, p.y)
        )
        if (shade > 0.5f) {
            val highlightAlpha = ((shade - 0.45f) * 0.7f).coerceIn(0f, 0.48f)
            drawCircle(
                color = specularTint.copy(alpha = highlightAlpha),
                radius = radius * 0.42f,
                center = Offset(p.x - radius * 0.22f, p.y - radius * 0.25f)
            )
        }
    }
}

private fun DrawScope.drawSkillTentacles(
    cx: Float,
    cy: Float,
    sr: Float,
    t: Float,
    skills: List<String>,
    palette: NeuroPalette
) {
    if (skills.isEmpty()) return
    val count = skills.size.coerceAtMost(12)
    val hold = sr * 1.32f
    val segs = 12
    val spin = t * 0.10f
    for (k in 0 until count) {
        val phase = (skills[k].hashCode() and 0xFFFF) / 65535f * 6.283f
        val ang = spin + (k.toFloat() / count) * 6.2832f
        val len = sr * (0.82f + 0.36f * ((k % 3) / 2f))
        var x = cx + cos(ang) * sr * 0.36f
        var y = cy + sin(ang) * sr * 0.36f
        var heading = ang
        val thick = (sr * 0.14f).coerceAtMost((6.2832f * sr * 0.36f / count) * 0.72f)
        val path = Path().apply { moveTo(x, y) }
        for (i in 1..segs) {
            val u = i.toFloat() / segs
            val sway = sin(t * 1.1f + phase + u * 6.5f) * 0.45f * u
            heading += sway * (10f / segs)
            x += cos(heading) * len / segs
            y += sin(heading) * len / segs
            val rx = x - cx
            val ry = y - cy
            val rd = hypot(rx, ry)
            if (rd > hold) {
                x = cx + (rx / rd) * hold
                y = cy + (ry / rd) * hold
                heading = atan2(ry, rx) + (PI.toFloat() * 0.5f)
            }
            path.lineTo(x, y)
        }
        drawPath(
            path = path,
            color = palette.tentacleStroke,
            style = Stroke(width = max(2f, thick * 0.7f), cap = StrokeCap.Round, join = StrokeJoin.Round)
        )
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(palette.tentacleGlow, Color.Transparent),
                center = Offset(x, y),
                radius = max(4f, thick * 0.9f)
            ),
            radius = max(4f, thick * 0.9f),
            center = Offset(x, y)
        )
    }
}

private fun DrawScope.drawShoggothMascot(
    cx: Float,
    cy: Float,
    u: Float,
    t: Float,
    reducedMotion: Boolean,
    palette: NeuroPalette
) {
    val bobY = cy - u * 0.14f + if (reducedMotion) 0f else sin(t * 1.6f) * u * 0.03f
    val edge = if (palette.isDark) palette.ground else Color(0xFF1F1618)
    val green = palette.shoggothBody
    val spot = if (palette.isDark) palette.ink else Color(0xFFFFF8F5)

    // Lower tentacles
    val tentOffsets = floatArrayOf(-1.1f, -0.7f, -0.3f, 0.25f, 0.7f, 1.05f)
    for (i in tentOffsets.indices) {
        val ang = tentOffsets[i] * 0.55f
        val sway = if (reducedMotion) 0f else sin(t * 1.3f + i * 1.7f) * 0.18f * u
        val bx = cx + sin(ang) * u * 0.52f
        val by = bobY + u * 0.35f
        val tx = bx + sin(ang) * u * 0.62f + sway
        val ty = by + u * 0.68f
        val tPath = Path().apply {
            moveTo(bx, by)
            quadraticTo(bx + sway * 0.4f, by + u * 0.35f, tx, ty)
        }
        drawPath(tPath, color = edge, style = Stroke(width = u * 0.30f, cap = StrokeCap.Round))
        drawPath(tPath, color = green, style = Stroke(width = u * 0.22f, cap = StrokeCap.Round))
    }

    // Wobbling organic body
    val bodyPath = Path()
    val steps = 40
    for (i in 0..steps) {
        val th = (i.toFloat() / steps) * 6.2832f
        val r = u * (0.72f + 0.06f * sin(th * 3f + t * 0.9f) + 0.03f * sin(th * 5f - t * 1.2f))
        val px = cx + cos(th) * r * 1.05f
        val py = bobY + sin(th) * r * 0.95f
        if (i == 0) bodyPath.moveTo(px, py) else bodyPath.lineTo(px, py)
    }
    bodyPath.close()
    drawPath(bodyPath, color = green)
    drawPath(bodyPath, color = edge, style = Stroke(width = max(1.5f, u * 0.05f)))

    // Holes / spots
    val spots = listOf(
        Triple(-0.30f, -0.35f, 0.05f),
        Triple(0.25f, -0.40f, 0.045f),
        Triple(0.38f, -0.12f, 0.05f),
        Triple(-0.10f, 0.20f, 0.04f),
        Triple(0.15f, 0.30f, 0.04f)
    )
    for ((sx, sy, sr) in spots) {
        drawOval(
            color = spot,
            topLeft = Offset(cx + sx * u - sr * u * 1.2f, bobY + sy * u - sr * u),
            size = Size(sr * u * 2.4f, sr * u * 2.0f)
        )
    }

    // Three eyes
    val eyes = listOf(
        Triple(-0.02f, -0.16f, 0.20f),
        Triple(0.38f, 0.14f, 0.15f),
        Triple(-0.20f, 0.34f, 0.12f)
    )
    val lookX = if (reducedMotion) 0f else cos(t * 0.5f) * 0.3f
    val lookY = if (reducedMotion) 0f else sin(t * 0.4f) * 0.2f
    for ((ex, ey, er) in eyes) {
        val eyeCenter = Offset(cx + ex * u, bobY + ey * u)
        drawOval(
            color = spot,
            topLeft = Offset(eyeCenter.x - er * u * 1.2f, eyeCenter.y - er * u * 0.8f),
            size = Size(er * u * 2.4f, er * u * 1.6f)
        )
        drawCircle(
            color = edge,
            radius = er * u * 0.32f,
            center = Offset(eyeCenter.x + lookX * er * u, eyeCenter.y + lookY * er * u)
        )
    }

    // Little yellow smiley face on the side
    val fx = cx - u * 0.72f
    val fy = bobY + u * 0.14f + if (reducedMotion) 0f else sin(t * 1.2f) * u * 0.03f
    val faceR = u * 0.27f
    drawCircle(color = palette.shoggothSmiley, radius = faceR, center = Offset(fx, fy))
    drawCircle(color = edge, radius = faceR, center = Offset(fx, fy), style = Stroke(width = max(1f, u * 0.04f)))
    drawCircle(color = edge, radius = u * 0.03f, center = Offset(fx - u * 0.08f, fy - u * 0.05f))
    drawCircle(color = edge, radius = u * 0.03f, center = Offset(fx + u * 0.08f, fy - u * 0.05f))
    drawArc(
        color = edge,
        startAngle = 20f,
        sweepAngle = 140f,
        useCenter = false,
        topLeft = Offset(fx - u * 0.12f, fy - u * 0.08f),
        size = Size(u * 0.24f, u * 0.20f),
        style = Stroke(width = max(1f, u * 0.035f), cap = StrokeCap.Round)
    )
}

private data class ProjectedBead(
    val x: Float,
    val y: Float,
    val z: Float,
    val scale: Float
)

private class CrownCordGeometry(private val count: Int) {
    private val scale = 0.023f
    private val pitch = 22f
    private val step = (2.0 * PI / 24.0).toFloat()
    private val r = pitch / (sqrt(2f) * sin(step))
    private val rise = r * sqrt(2f * cos(step) * (1f - cos(step)))
    private val tipIn = 0.10f
    private val midOut = 0.04f
    private val fit = 0.88f
    val beadRadius = 3.3f * scale * fit

    private val px = FloatArray(count)
    private val py = FloatArray(count)
    private val pz = FloatArray(count)

    init {
        for (n in 0 until count) {
            val th = (n.toFloat() / count) * (2.0 * PI).toFloat()
            val rad = r * (1f + midOut - (tipIn + midOut) * (0.5f + 0.5f * cos(12f * th)))
            px[n] = rad * cos(th) * scale * fit
            py[n] = rise * cos(6f * th) * scale * fit
            pz[n] = -rad * sin(th) * scale * fit
        }
    }

    fun project(
        cx: Float,
        cy: Float,
        dist: Float,
        focal: Float,
        m00: Float, m01: Float, m02: Float,
        m10: Float, m11: Float, m12: Float,
        m20: Float, m21: Float, m22: Float
    ): Array<ProjectedBead> {
        val list = Array(count) { i ->
            val x = px[i]; val y = py[i]; val z = pz[i]
            val rx = m00 * x + m01 * y + m02 * z
            val ry = m10 * x + m11 * y + m12 * z
            val rz = m20 * x + m21 * y + m22 * z
            val k = focal / max(0.5f, dist - rz)
            ProjectedBead(cx + rx * k, cy - ry * k, rz, k)
        }
        list.sortBy { it.z }
        return list
    }
}
