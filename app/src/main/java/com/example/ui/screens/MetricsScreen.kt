package com.example.ui.screens

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.example.model.BrainCheckpoint
import com.example.ui.components.CoralPillButton
import com.example.ui.components.GlassPanel
import com.example.ui.components.PillTextField
import com.example.ui.components.SectionHeader
import com.example.ui.components.StatusChip
import com.example.ui.theme.NeuroColors
import com.example.viewmodel.NeuroUiState

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun MetricsScreen(
    state: NeuroUiState,
    onRunDrills: () -> Unit,
    onRunEndurance: (Int) -> Unit,
    onCaptureCheckpoint: (String) -> Unit,
    onRestoreCheckpoint: (BrainCheckpoint) -> Unit,
    onImportWeightsUri: (android.net.Uri) -> Unit,
    onExportDelta: () -> Unit,
    onTeachYesNo: (String, String, Boolean) -> Unit,
    onAskYesNo: (String, String) -> Unit,
    modifier: Modifier = Modifier
) {
    var selectedTab by remember { mutableIntStateOf(0) }
    var question by remember { mutableStateOf("Is this a priority action?") }
    var exampleText by remember { mutableStateOf("") }
    var checkpointLabel by remember { mutableStateOf("") }

    val weightsPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) onImportWeightsUri(uri)
    }

    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.TopCenter
    ) {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .widthIn(max = 760.dp)
                .padding(horizontal = 16.dp),
            contentPadding = PaddingValues(vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            item {
                SectionHeader(
                    title = "OneBrain Mesh, Endurance & Weights",
                    subtitle = "Telemetry, Vale matrix, endurance loops, mistake log, byte weights & checkpoints."
                )
            }

            item {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    listOf("Telemetry", "Endurance", "Weights", "Drills & Yes/No").forEachIndexed { idx, label ->
                        CoralPillButton(
                            text = label,
                            primary = selectedTab == idx,
                            onClick = { selectedTab = idx },
                            modifier = Modifier.testTag("metrics_tab_$idx")
                        )
                    }
                }
            }

            when (selectedTab) {
                0 -> {
                    item {
                        val stats = state.meshStats
                        val accuracyPct = if (state.drillResults.isEmpty()) 92 else {
                            (state.drillResults.count { it.passed } * 100) / state.drillResults.size
                        }
                        GlassPanel {
                            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text("Mesh Telemetry", style = MaterialTheme.typography.titleLarge, color = NeuroColors.CoralSoft)
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                                ) {
                                    MetricTile("Neurons", "${stats.neuronCount} x ${stats.dimensions}D", Modifier.weight(1f))
                                    MetricTile("OneBrain Edges", "${stats.oneBrainEdges}", Modifier.weight(1f))
                                    MetricTile("Cycles", "${stats.cyclesRun}", Modifier.weight(1f))
                                }
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                                ) {
                                    MetricTile("Islands", "${stats.learnedIslands} learned", Modifier.weight(1f))
                                    MetricTile("Sleeps", "${stats.sleeps}", Modifier.weight(1f))
                                    MetricTile("Awaiting sleep", "${stats.pendingExperiences}", Modifier.weight(1f))
                                }
                                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                        Text("Vale Conservation", style = MaterialTheme.typography.bodyMedium, color = NeuroColors.Ink)
                                        Text(
                                            text = "${"%.2f".format(stats.valeTotal)} / ${"%.2f".format(stats.valeBudget)}",
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = if (stats.valeConserved) NeuroColors.ShoggothGreen else NeuroColors.ErrorPink
                                        )
                                    }
                                    LinearProgressIndicator(
                                        progress = { (stats.valeTotal / stats.valeBudget.coerceAtLeast(1f)).coerceIn(0f, 1f) },
                                        modifier = Modifier.fillMaxWidth().height(8.dp).clip(CircleShape),
                                        color = NeuroColors.CoralAccent,
                                        trackColor = NeuroColors.GlassFill
                                    )
                                }
                                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                        Text("Reasoning Accuracy", style = MaterialTheme.typography.bodyMedium, color = NeuroColors.Ink)
                                        Text("$accuracyPct%", style = MaterialTheme.typography.bodyMedium, color = NeuroColors.CoralSoft)
                                    }
                                    LinearProgressIndicator(
                                        progress = { accuracyPct / 100f },
                                        modifier = Modifier.fillMaxWidth().height(8.dp).clip(CircleShape),
                                        color = NeuroColors.ShoggothGreen,
                                        trackColor = NeuroColors.GlassFill
                                    )
                                }
                                FlowRow(
                                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                                    verticalArrangement = Arrangement.spacedBy(6.dp)
                                ) {
                                    stats.activeRegions.forEach { region ->
                                        StatusChip(label = region, toneColor = NeuroColors.ShoggothGreen)
                                    }
                                }
                            }
                        }
                    }

                    item {
                        GlassPanel {
                            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Text("32-Neuron Vale Matrix", style = MaterialTheme.typography.titleMedium, color = NeuroColors.CoralSoft)
                                Text(
                                    text = "Conserved plasticity across all hyper-neurons (${state.meshStats.memoryEntries} episodic traces).",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = NeuroColors.InkDim
                                )
                                val maxV = (state.valeDistribution.maxOrNull() ?: 1.5f).coerceAtLeast(1.5f)
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .height(74.dp),
                                    horizontalArrangement = Arrangement.spacedBy(3.dp),
                                    verticalAlignment = Alignment.Bottom
                                ) {
                                    state.valeDistribution.forEach { v ->
                                        val frac = (v / maxV).coerceIn(0.08f, 1f)
                                        Box(
                                            modifier = Modifier
                                                .weight(1f)
                                                .height((70f * frac).dp)
                                                .clip(RoundedCornerShape(4.dp))
                                                .background(if (v >= 1.05f) NeuroColors.ShoggothGreen else NeuroColors.CoralAccent)
                                        )
                                    }
                                }
                            }
                        }
                    }
                }

                1 -> {
                    item {
                        GlassPanel(highlighted = true) {
                            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text("Endurance Training", style = MaterialTheme.typography.titleLarge, color = NeuroColors.CoralSoft)
                                        Text(
                                            text = "Multi-round ZipLoop + Vale + Mistake replay consolidation.",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = NeuroColors.InkDim
                                        )
                                    }
                                    CoralPillButton(
                                        text = "Run 5 Rounds",
                                        onClick = { onRunEndurance(5) },
                                        modifier = Modifier.testTag("run_endurance_button")
                                    )
                                }
                                state.enduranceResults.forEach { r ->
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clip(RoundedCornerShape(18.dp))
                                            .background(NeuroColors.GlassFill)
                                            .padding(horizontal = 14.dp, vertical = 10.dp),
                                        horizontalArrangement = Arrangement.SpaceBetween,
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        Column {
                                            Text("Round ${r.round}", style = MaterialTheme.typography.titleSmall, color = NeuroColors.Ink)
                                            Text(
                                                text = "Surprise ${"%.2f".format(r.avgSurprise)} • Spread ${"%.2f".format(r.valeSpread)}",
                                                style = MaterialTheme.typography.bodySmall,
                                                color = NeuroColors.InkDim
                                            )
                                        }
                                        StatusChip(
                                            label = "${(r.accuracyScore * 100).toInt()}% • ${r.durationMs}ms",
                                            toneColor = NeuroColors.ShoggothGreen
                                        )
                                    }
                                }
                            }
                        }
                    }

                    item {
                        GlassPanel {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text("Mistake Tracker (${state.mistakes.size})", style = MaterialTheme.typography.titleLarge, color = NeuroColors.CoralSoft)
                                Text(
                                    text = "Corrections flagged in Chat are injected as high-surprise counter-traces.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = NeuroColors.InkDim
                                )
                                if (state.mistakes.isEmpty()) {
                                    Text(
                                        text = "No mistakes flagged yet. Tap 'Correct' under any agent message in Chat to record one.",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = NeuroColors.InkDim
                                    )
                                } else {
                                    state.mistakes.take(8).forEach { m ->
                                        Column(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .clip(RoundedCornerShape(16.dp))
                                                .background(NeuroColors.GlassFill)
                                                .padding(12.dp),
                                            verticalArrangement = Arrangement.spacedBy(2.dp)
                                        ) {
                                            Text("Prompt: ${m.prompt}", style = MaterialTheme.typography.labelMedium, color = NeuroColors.CoralSoft)
                                            Text("Prefer: ${m.correction}", style = MaterialTheme.typography.bodySmall, color = NeuroColors.ShoggothGreen)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                2 -> {
                    item {
                        GlassPanel(highlighted = true) {
                            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Text("Weights & Model Checkpoints", style = MaterialTheme.typography.titleLarge, color = NeuroColors.CoralSoft)
                                PillTextField(
                                    value = checkpointLabel,
                                    onValueChange = { checkpointLabel = it },
                                    placeholder = "Checkpoint label (optional)"
                                )
                                FlowRow(
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    verticalArrangement = Arrangement.spacedBy(8.dp)
                                ) {
                                    CoralPillButton(
                                        text = "Save Checkpoint",
                                        onClick = {
                                            onCaptureCheckpoint(checkpointLabel)
                                            checkpointLabel = ""
                                        },
                                        modifier = Modifier.testTag("save_checkpoint_button")
                                    )
                                    CoralPillButton(
                                        text = "Import model.json",
                                        primary = false,
                                        onClick = { weightsPicker.launch(arrayOf("application/json", "*/*")) },
                                        modifier = Modifier.testTag("import_weights_button")
                                    )
                                    CoralPillButton(
                                        text = "Export Delta JSON",
                                        primary = false,
                                        onClick = onExportDelta,
                                        modifier = Modifier.testTag("export_delta_button")
                                    )
                                }

                                state.checkpoints.forEach { cp ->
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clip(RoundedCornerShape(16.dp))
                                            .background(NeuroColors.GlassFill)
                                            .padding(12.dp),
                                        horizontalArrangement = Arrangement.SpaceBetween,
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        Column(modifier = Modifier.weight(1f)) {
                                            Text(cp.label, style = MaterialTheme.typography.titleSmall, color = NeuroColors.Ink)
                                            Text(
                                                text = "${cp.edgesCount} edges • Vale ${"%.2f".format(cp.valeTotal)} • ${cp.memoriesCount} cues",
                                                style = MaterialTheme.typography.bodySmall,
                                                color = NeuroColors.InkDim
                                            )
                                        }
                                        CoralPillButton(
                                            text = "Restore",
                                            primary = false,
                                            onClick = { onRestoreCheckpoint(cp) }
                                        )
                                    }
                                }
                            }
                        }
                    }

                    item {
                        GlassPanel {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text("Strongest OneBrain Byte Transitions", style = MaterialTheme.typography.titleMedium, color = NeuroColors.CoralSoft)
                                state.topByteEdges.forEach { edge ->
                                    Row(
                                        modifier = Modifier.fillMaxWidth(),
                                        horizontalArrangement = Arrangement.SpaceBetween
                                    ) {
                                        Text(
                                            text = "${edge.fromLabel}  ->  ${edge.toLabel}",
                                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                            color = NeuroColors.Ink
                                        )
                                        Text(
                                            text = "%.4f".format(edge.weight),
                                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                            color = if (edge.weight >= 0f) NeuroColors.ShoggothGreen else NeuroColors.ErrorPink
                                        )
                                    }
                                }
                            }
                        }
                    }
                }

                else -> {
                    item {
                        GlassPanel {
                            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text("Capability Drills", style = MaterialTheme.typography.titleLarge, color = NeuroColors.CoralSoft)
                                        Text(
                                            text = "Verify HD binding, Vale conservation, NeuroLang parsing, and Zip Loop byte recall.",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = NeuroColors.InkDim
                                        )
                                    }
                                    CoralPillButton(
                                        text = "Run Drills",
                                        onClick = onRunDrills,
                                        modifier = Modifier.testTag("run_drills_button")
                                    )
                                }
                                state.drillResults.forEach { res ->
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clip(RoundedCornerShape(18.dp))
                                            .background(NeuroColors.GlassFill)
                                            .padding(horizontal = 14.dp, vertical = 10.dp),
                                        horizontalArrangement = Arrangement.SpaceBetween,
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        Column(modifier = Modifier.weight(1f)) {
                                            Text(res.domain, style = MaterialTheme.typography.titleMedium, color = NeuroColors.Ink)
                                            Text(res.outputPreview, style = MaterialTheme.typography.bodySmall, color = NeuroColors.InkDim)
                                        }
                                        StatusChip(
                                            label = if (res.passed) "Pass • ${res.latencyMs}ms" else "Fail",
                                            toneColor = if (res.passed) NeuroColors.ShoggothGreen else NeuroColors.ErrorPink
                                        )
                                    }
                                }
                            }
                        }
                    }

                    item {
                        GlassPanel {
                            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Text("Yes / No Doorway Trainer", style = MaterialTheme.typography.titleLarge, color = NeuroColors.CoralSoft)
                                Text(
                                    text = "Teach binary classifiers inside the mesh (${state.yesNoExamples.size} examples stored; ${state.meshStats.unsyncedExamples} waiting for PC sync).",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = NeuroColors.InkDim
                                )
                                PillTextField(value = question, onValueChange = { question = it }, placeholder = "Question")
                                PillTextField(
                                    value = exampleText,
                                    onValueChange = { exampleText = it },
                                    placeholder = "Text example to classify or teach",
                                    singleLine = false,
                                    maxLines = 3
                                )
                                FlowRow(
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    verticalArrangement = Arrangement.spacedBy(8.dp)
                                ) {
                                    CoralPillButton(
                                        text = "Ask",
                                        primary = false,
                                        enabled = question.isNotBlank() && exampleText.isNotBlank(),
                                        onClick = { onAskYesNo(question, exampleText) },
                                        modifier = Modifier.testTag("ask_yesno_button")
                                    )
                                    CoralPillButton(
                                        text = "Teach Yes",
                                        enabled = question.isNotBlank() && exampleText.isNotBlank(),
                                        onClick = { onTeachYesNo(question, exampleText, true) },
                                        modifier = Modifier.testTag("teach_yes_button")
                                    )
                                    CoralPillButton(
                                        text = "Teach No",
                                        primary = false,
                                        enabled = question.isNotBlank() && exampleText.isNotBlank(),
                                        onClick = { onTeachYesNo(question, exampleText, false) },
                                        modifier = Modifier.testTag("teach_no_button")
                                    )
                                }
                                state.lastYesNoQuery?.let { q ->
                                    StatusChip(
                                        label = "Prediction: ${if (q.answer) "Yes" else "No"} (${(q.confidence * 100).toInt()}% across ${q.matchedExamples} examples)",
                                        toneColor = if (q.answer) NeuroColors.ShoggothGreen else NeuroColors.CoralSoft
                                    )
                                }
                            }
                        }
                    }

                    items(state.yesNoExamples.takeLast(6).reversed()) { ex ->
                        GlassPanel(cornerRadius = 22.dp, contentPadding = PaddingValues(14.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(ex.question, style = MaterialTheme.typography.labelLarge, color = NeuroColors.CoralSoft)
                                    Text(ex.text, style = MaterialTheme.typography.bodySmall, color = NeuroColors.InkDim)
                                }
                                StatusChip(
                                    label = if (ex.answer) "Yes" else "No",
                                    toneColor = if (ex.answer) NeuroColors.ShoggothGreen else NeuroColors.CoralAccent
                                )
                            }
                        }
                    }
                }
            }

            item { Spacer(Modifier.height(12.dp)) }
        }
    }
}

@Composable
private fun MetricTile(label: String, value: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(20.dp))
            .background(NeuroColors.GlassFill)
            .padding(12.dp)
    ) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = NeuroColors.InkDim)
        Spacer(Modifier.height(2.dp))
        Text(value, style = MaterialTheme.typography.titleMedium, color = NeuroColors.CoralSoft)
    }
}
