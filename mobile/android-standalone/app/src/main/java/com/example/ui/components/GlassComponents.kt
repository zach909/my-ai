package com.example.ui.components

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.example.ui.theme.NeuroColors
import com.example.ui.theme.NeuroCorner

@Composable
fun GlassPanel(
    modifier: Modifier = Modifier,
    cornerRadius: Dp = 32.dp,
    highlighted: Boolean = false,
    contentPadding: PaddingValues = PaddingValues(20.dp),
    content: @Composable ColumnScope.() -> Unit
) {
    val shape = RoundedCornerShape(cornerRadius)
    val fill = if (highlighted) {
        Brush.verticalGradient(
            listOf(NeuroColors.HighlightGradientStart, NeuroColors.HighlightGradientEnd)
        )
    } else {
        Brush.verticalGradient(
            listOf(NeuroColors.GlassGradientStart, NeuroColors.GlassGradientEnd)
        )
    }
    val border = if (highlighted) NeuroColors.PrimaryLine else NeuroColors.GlassLine

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(fill)
            .border(1.dp, border, shape)
            .padding(contentPadding),
        content = content
    )
}

@Composable
fun CoralPillButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    primary: Boolean = true,
    enabled: Boolean = true
) {
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed && enabled) 0.95f else 1f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessMedium),
        label = "pillScale"
    )

    Button(
        onClick = onClick,
        enabled = enabled,
        interactionSource = interactionSource,
        shape = NeuroCorner.Pill,
        colors = ButtonDefaults.buttonColors(
            containerColor = if (primary) NeuroColors.PrimaryFill else NeuroColors.ButtonNeutralFill,
            contentColor = if (primary) NeuroColors.CoralSoft else NeuroColors.Ink,
            disabledContainerColor = NeuroColors.DisabledButtonFill,
            disabledContentColor = NeuroColors.InkFaint
        ),
        border = BorderStroke(1.dp, if (primary) NeuroColors.PrimaryLine else NeuroColors.GlassLine),
        contentPadding = PaddingValues(horizontal = 18.dp, vertical = 10.dp),
        modifier = modifier
            .scale(scale)
            .minimumInteractiveComponentSize()
            .defaultMinSize(minHeight = 48.dp)
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelLarge
        )
    }
}

@Composable
fun PillTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    singleLine: Boolean = true,
    maxLines: Int = if (singleLine) 1 else 6,
    shape: Shape = if (singleLine) NeuroCorner.Pill else RoundedCornerShape(24.dp),
    textStyle: androidx.compose.ui.text.TextStyle = MaterialTheme.typography.bodyLarge
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        placeholder = {
            Text(
                text = placeholder,
                color = NeuroColors.InkFaint,
                style = textStyle
            )
        },
        singleLine = singleLine,
        maxLines = maxLines,
        shape = shape,
        textStyle = textStyle.copy(color = NeuroColors.Ink),
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = NeuroColors.InputFill,
            unfocusedContainerColor = NeuroColors.InputFill,
            focusedBorderColor = NeuroColors.InputFocusLine,
            unfocusedBorderColor = NeuroColors.GlassLine,
            cursorColor = NeuroColors.CoralAccent,
            focusedTextColor = NeuroColors.Ink,
            unfocusedTextColor = NeuroColors.Ink
        ),
        modifier = modifier.fillMaxWidth()
    )
}

@Composable
fun StatusChip(
    label: String,
    modifier: Modifier = Modifier,
    toneColor: Color = NeuroColors.CoralSoft,
    onClick: (() -> Unit)? = null
) {
    val border = toneColor.copy(alpha = 0.45f)
    val bg = toneColor.copy(alpha = 0.12f)
    Surface(
        shape = CircleShape,
        color = bg,
        border = BorderStroke(1.dp, border),
        modifier = modifier.then(
            if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier
        )
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = toneColor
            )
        }
    }
}

@Composable
fun SectionHeader(
    title: String,
    subtitle: String? = null,
    modifier: Modifier = Modifier
) {
    Box(modifier = modifier.fillMaxWidth()) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleLarge,
                color = NeuroColors.CoralSoft
            )
            if (!subtitle.isNullOrBlank()) {
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodyMedium,
                    color = NeuroColors.InkDim
                )
            }
        }
    }
}
