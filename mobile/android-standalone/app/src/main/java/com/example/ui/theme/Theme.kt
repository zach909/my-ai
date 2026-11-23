package com.example.ui.theme

import android.app.Activity
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private val NeuroDarkColorScheme = darkColorScheme(
    primary = NeuroDarkPalette.coralAccent,
    onPrimary = NeuroDarkPalette.ground,
    primaryContainer = Color(0xFF4F2B26),
    onPrimaryContainer = NeuroDarkPalette.coralSoft,
    secondary = NeuroDarkPalette.coralDeep,
    onSecondary = NeuroDarkPalette.ink,
    secondaryContainer = NeuroDarkPalette.surfaceElevated,
    onSecondaryContainer = NeuroDarkPalette.coralSoft,
    tertiary = NeuroDarkPalette.shoggothGreen,
    onTertiary = NeuroDarkPalette.ground,
    background = NeuroDarkPalette.ground,
    onBackground = NeuroDarkPalette.ink,
    surface = NeuroDarkPalette.groundSecondary,
    onSurface = NeuroDarkPalette.ink,
    surfaceVariant = NeuroDarkPalette.surfaceElevated,
    onSurfaceVariant = NeuroDarkPalette.inkDim,
    outline = NeuroDarkPalette.glassLine,
    error = NeuroDarkPalette.errorPink,
    onError = NeuroDarkPalette.ground,
    errorContainer = NeuroDarkPalette.errorFill,
    onErrorContainer = NeuroDarkPalette.errorPink
)

private val NeuroLightColorScheme = lightColorScheme(
    primary = NeuroLightPalette.coralAccent,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFFADAD4),
    onPrimaryContainer = NeuroLightPalette.coralSoft,
    secondary = NeuroLightPalette.coralDeep,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFF3E4E0),
    onSecondaryContainer = NeuroLightPalette.ink,
    tertiary = NeuroLightPalette.shoggothGreen,
    onTertiary = Color.White,
    background = NeuroLightPalette.ground,
    onBackground = NeuroLightPalette.ink,
    surface = NeuroLightPalette.surfaceElevated,
    onSurface = NeuroLightPalette.ink,
    surfaceVariant = NeuroLightPalette.groundSecondary,
    onSurfaceVariant = NeuroLightPalette.inkDim,
    outline = NeuroLightPalette.glassLine,
    error = NeuroLightPalette.errorPink,
    onError = Color.White,
    errorContainer = NeuroLightPalette.errorFill,
    onErrorContainer = NeuroLightPalette.errorPink
)

@Composable
fun NeuroClawTheme(
    themeMode: ThemeMode = ThemeMode.SYSTEM,
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit
) {
    val systemDark = isSystemInDarkTheme()
    val darkTheme = when (themeMode) {
        ThemeMode.SYSTEM -> systemDark
        ThemeMode.DARK -> true
        ThemeMode.LIGHT -> false
    }

    val context = LocalContext.current
    val useDynamicScheme = dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
    val colorScheme = when {
        useDynamicScheme && darkTheme -> dynamicDarkColorScheme(context)
        useDynamicScheme && !darkTheme -> dynamicLightColorScheme(context)
        darkTheme -> NeuroDarkColorScheme
        else -> NeuroLightColorScheme
    }

    val palette = remember(colorScheme, darkTheme, useDynamicScheme) {
        if (useDynamicScheme) {
            paletteFromColorScheme(colorScheme, darkTheme)
        } else if (darkTheme) {
            NeuroDarkPalette
        } else {
            NeuroLightPalette
        }
    }

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? Activity)?.window ?: return@SideEffect
            val insetsController = WindowCompat.getInsetsController(window, view)
            insetsController.isAppearanceLightStatusBars = !darkTheme
            insetsController.isAppearanceLightNavigationBars = !darkTheme
        }
    }

    CompositionLocalProvider(LocalNeuroPalette provides palette) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = NeuroTypography,
            shapes = NeuroShapes,
            content = content
        )
    }
}
