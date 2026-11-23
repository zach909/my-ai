package com.example.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp

enum class ThemeMode(val storageKey: String, val label: String) {
    SYSTEM("SYSTEM", "System"),
    LIGHT("LIGHT", "Light"),
    DARK("DARK", "Dark");

    companion object {
        fun fromKey(key: String?): ThemeMode =
            entries.firstOrNull { it.storageKey.equals(key, ignoreCase = true) } ?: SYSTEM
    }
}

@Immutable
data class NeuroPalette(
    val isDark: Boolean,
    val ground: Color,
    val groundSecondary: Color,
    val surfaceElevated: Color,
    val ink: Color,
    val inkDim: Color,
    val inkFaint: Color,
    val coralAccent: Color,
    val coralSoft: Color,
    val coralDeep: Color,
    val glassFill: Color,
    val glassSurface: Color,
    val glassLine: Color,
    val glassHighlight: Color,
    val glassGradientStart: Color,
    val glassGradientEnd: Color,
    val highlightGradientStart: Color,
    val highlightGradientEnd: Color,
    val navBarFill: Color,
    val agentBubbleFill: Color,
    val buttonNeutralFill: Color,
    val disabledButtonFill: Color,
    val primaryFill: Color,
    val primaryLine: Color,
    val inputFill: Color,
    val inputFocusLine: Color,
    val shoggothGreen: Color,
    val shoggothBody: Color,
    val shoggothSmiley: Color,
    val errorPink: Color,
    val errorFill: Color,
    val ambientGlowA: Color,
    val ambientGlowB: Color,
    val hollowSphereFill: Color,
    val sphereCore: Color,
    val sphereEdge: Color,
    val sphereRim: Color,
    val tentacleStroke: Color,
    val tentacleGlow: Color
)

val NeuroDarkPalette = NeuroPalette(
    isDark = true,
    ground = Color(0xFF110C0E),
    groundSecondary = Color(0xFF1B1216),
    surfaceElevated = Color(0xFF24181C),
    ink = Color(0xFFF8EDE9),
    inkDim = Color(0xA8F8EDE9),
    inkFaint = Color(0x6EF8EDE9),
    coralAccent = Color(0xFFE3A99D),
    coralSoft = Color(0xFFEFD0C8),
    coralDeep = Color(0xFFC98476),
    glassFill = Color(0x14FFF0E8),
    glassSurface = Color(0xCC1F1519),
    glassLine = Color(0x33FFE4DA),
    glassHighlight = Color(0x2EFFFFFF),
    glassGradientStart = Color(0x1EFFF0E8),
    glassGradientEnd = Color(0x181A1014),
    highlightGradientStart = Color(0x2CE3A99D),
    highlightGradientEnd = Color(0x1A1F1519),
    navBarFill = Color(0xCC140C0E),
    agentBubbleFill = Color(0xCC1F1519),
    buttonNeutralFill = Color(0x14FFEEE6),
    disabledButtonFill = Color(0x0DFFF0E8),
    primaryFill = Color(0x2BE3A99D),
    primaryLine = Color(0x80E3A99D),
    inputFill = Color(0x70140C0E),
    inputFocusLine = Color(0xB8E3A99D),
    shoggothGreen = Color(0xFF8FE3A8),
    shoggothBody = Color(0xFF8DB27F),
    shoggothSmiley = Color(0xFFF6E878),
    errorPink = Color(0xFFFF9AA8),
    errorFill = Color(0x1EFF9AA8),
    ambientGlowA = Color(0x55D6968A),
    ambientGlowB = Color(0x3FE2BEAA),
    hollowSphereFill = Color(0x8C1A0D10),
    sphereCore = Color(0xD83A1F24),
    sphereEdge = Color(0xE81C0E12),
    sphereRim = Color(0x4AE3A99D),
    tentacleStroke = Color(0xCC5BC080),
    tentacleGlow = Color(0xFFE2FFEC)
)

val NeuroLightPalette = NeuroPalette(
    isDark = false,
    ground = Color(0xFFFDF6F4),
    groundSecondary = Color(0xFFF4E8E4),
    surfaceElevated = Color(0xFFFFFFFF),
    ink = Color(0xFF231417),
    inkDim = Color(0xB8231417),
    inkFaint = Color(0x7A231417),
    coralAccent = Color(0xFFB5493A),
    coralSoft = Color(0xFF8E2F23),
    coralDeep = Color(0xFF9C3E31),
    glassFill = Color(0xAAFFFFFF),
    glassSurface = Color(0xE6FFF9F7),
    glassLine = Color(0x3D6E3B33),
    glassHighlight = Color(0x99FFFFFF),
    glassGradientStart = Color(0xDEFFFFFF),
    glassGradientEnd = Color(0xB8F9ECE8),
    highlightGradientStart = Color(0x38D67C6C),
    highlightGradientEnd = Color(0xD8FFF8F6),
    navBarFill = Color(0xE8FBF1EE),
    agentBubbleFill = Color(0xEBFFFFFF),
    buttonNeutralFill = Color(0xB8FFFFFF),
    disabledButtonFill = Color(0x4DE5D2CD),
    primaryFill = Color(0x28B5493A),
    primaryLine = Color(0x8FB5493A),
    inputFill = Color(0xE8FFFFFF),
    inputFocusLine = Color(0xCCB5493A),
    shoggothGreen = Color(0xFF176D3F),
    shoggothBody = Color(0xFF6A9F5B),
    shoggothSmiley = Color(0xFFF5D849),
    errorPink = Color(0xFFBA1A34),
    errorFill = Color(0x1ABA1A34),
    ambientGlowA = Color(0x36D67D6D),
    ambientGlowB = Color(0x2EC99482),
    hollowSphereFill = Color(0x4DEFDCD6),
    sphereCore = Color(0xD4F8E6E0),
    sphereEdge = Color(0xE6DFBDB4),
    sphereRim = Color(0x66B5493A),
    tentacleStroke = Color(0xCC288F52),
    tentacleGlow = Color(0xFF7DE8A6)
)

fun paletteFromColorScheme(colorScheme: ColorScheme, darkTheme: Boolean): NeuroPalette {
    val base = if (darkTheme) NeuroDarkPalette else NeuroLightPalette
    val primary = colorScheme.primary
    val secondary = colorScheme.secondary
    val background = colorScheme.background
    val surface = colorScheme.surface
    val surfaceVariant = colorScheme.surfaceVariant
    val onBackground = colorScheme.onBackground
    val error = colorScheme.error

    return if (darkTheme) {
        val softPrimary = lerp(primary, colorScheme.onPrimaryContainer, 0.35f)
        base.copy(
            isDark = true,
            ground = background,
            groundSecondary = lerp(background, surface, 0.65f),
            surfaceElevated = lerp(surface, surfaceVariant, 0.55f),
            ink = onBackground,
            inkDim = onBackground.copy(alpha = 0.72f),
            inkFaint = onBackground.copy(alpha = 0.45f),
            coralAccent = primary,
            coralSoft = softPrimary,
            coralDeep = secondary,
            glassFill = onBackground.copy(alpha = 0.08f),
            glassSurface = lerp(surface, background, 0.35f).copy(alpha = 0.84f),
            glassLine = softPrimary.copy(alpha = 0.22f),
            glassGradientStart = onBackground.copy(alpha = 0.11f),
            glassGradientEnd = surface.copy(alpha = 0.24f),
            highlightGradientStart = primary.copy(alpha = 0.20f),
            highlightGradientEnd = surface.copy(alpha = 0.28f),
            navBarFill = lerp(background, surface, 0.35f).copy(alpha = 0.86f),
            agentBubbleFill = lerp(surface, surfaceVariant, 0.35f).copy(alpha = 0.82f),
            buttonNeutralFill = onBackground.copy(alpha = 0.08f),
            disabledButtonFill = onBackground.copy(alpha = 0.05f),
            primaryFill = primary.copy(alpha = 0.18f),
            primaryLine = primary.copy(alpha = 0.52f),
            inputFill = background.copy(alpha = 0.55f),
            inputFocusLine = primary.copy(alpha = 0.75f),
            errorPink = error,
            errorFill = error.copy(alpha = 0.14f),
            ambientGlowA = primary.copy(alpha = 0.34f),
            ambientGlowB = secondary.copy(alpha = 0.26f),
            hollowSphereFill = surface.copy(alpha = 0.58f),
            sphereCore = lerp(surfaceVariant, primary, 0.18f).copy(alpha = 0.85f),
            sphereEdge = background.copy(alpha = 0.92f),
            sphereRim = primary.copy(alpha = 0.32f)
        )
    } else {
        val deepPrimary = lerp(primary, onBackground, 0.18f)
        base.copy(
            isDark = false,
            ground = background,
            groundSecondary = lerp(background, surfaceVariant, 0.45f),
            surfaceElevated = surface,
            ink = onBackground,
            inkDim = onBackground.copy(alpha = 0.74f),
            inkFaint = onBackground.copy(alpha = 0.50f),
            coralAccent = primary,
            coralSoft = deepPrimary,
            coralDeep = secondary,
            glassFill = surface.copy(alpha = 0.74f),
            glassSurface = surface.copy(alpha = 0.90f),
            glassLine = primary.copy(alpha = 0.24f),
            glassGradientStart = surface.copy(alpha = 0.90f),
            glassGradientEnd = lerp(surface, surfaceVariant, 0.35f).copy(alpha = 0.76f),
            highlightGradientStart = primary.copy(alpha = 0.18f),
            highlightGradientEnd = surface.copy(alpha = 0.88f),
            navBarFill = lerp(surface, background, 0.3f).copy(alpha = 0.92f),
            agentBubbleFill = surface.copy(alpha = 0.92f),
            buttonNeutralFill = surface.copy(alpha = 0.78f),
            disabledButtonFill = surfaceVariant.copy(alpha = 0.38f),
            primaryFill = primary.copy(alpha = 0.14f),
            primaryLine = primary.copy(alpha = 0.55f),
            inputFill = surface.copy(alpha = 0.90f),
            inputFocusLine = primary.copy(alpha = 0.82f),
            errorPink = error,
            errorFill = error.copy(alpha = 0.12f),
            ambientGlowA = primary.copy(alpha = 0.20f),
            ambientGlowB = secondary.copy(alpha = 0.16f),
            hollowSphereFill = surfaceVariant.copy(alpha = 0.45f),
            sphereCore = lerp(surface, primary, 0.12f).copy(alpha = 0.88f),
            sphereEdge = lerp(surfaceVariant, primary, 0.18f).copy(alpha = 0.92f),
            sphereRim = primary.copy(alpha = 0.42f)
        )
    }
}

val LocalNeuroPalette = staticCompositionLocalOf { NeuroDarkPalette }

object NeuroColors {
    val IsDark: Boolean
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.isDark
    val Ground: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.ground
    val GroundSecondary: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.groundSecondary
    val SurfaceElevated: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.surfaceElevated
    val Ink: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.ink
    val InkDim: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.inkDim
    val InkFaint: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.inkFaint
    val CoralAccent: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.coralAccent
    val CoralSoft: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.coralSoft
    val CoralDeep: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.coralDeep
    val GlassFill: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.glassFill
    val GlassSurface: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.glassSurface
    val GlassLine: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.glassLine
    val GlassHighlight: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.glassHighlight
    val GlassGradientStart: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.glassGradientStart
    val GlassGradientEnd: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.glassGradientEnd
    val HighlightGradientStart: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.highlightGradientStart
    val HighlightGradientEnd: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.highlightGradientEnd
    val NavBarFill: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.navBarFill
    val AgentBubbleFill: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.agentBubbleFill
    val ButtonNeutralFill: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.buttonNeutralFill
    val DisabledButtonFill: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.disabledButtonFill
    val PrimaryFill: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.primaryFill
    val PrimaryLine: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.primaryLine
    val InputFill: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.inputFill
    val InputFocusLine: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.inputFocusLine
    val ShoggothGreen: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.shoggothGreen
    val ShoggothBody: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.shoggothBody
    val ShoggothSmiley: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.shoggothSmiley
    val ErrorPink: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.errorPink
    val ErrorFill: Color
        @Composable @ReadOnlyComposable get() = LocalNeuroPalette.current.errorFill
}
