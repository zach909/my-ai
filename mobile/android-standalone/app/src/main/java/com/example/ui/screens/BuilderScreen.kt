package com.example.ui.screens

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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.example.engine.NeuroLangParser
import com.example.ui.components.CoralPillButton
import com.example.ui.components.GlassPanel
import com.example.ui.components.PillTextField
import com.example.ui.components.SectionHeader
import com.example.ui.components.StatusChip
import com.example.ui.theme.NeuroColors
import com.example.ui.theme.NeuroMonoFamily
import com.example.viewmodel.NeuroUiState

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun BuilderScreen(
    state: NeuroUiState,
    onBuildExtension: (String, String, String, Boolean) -> Pair<Boolean, String>,
    onToggleExtensionActive: (String) -> Unit,
    onDeleteExtension: (String) -> Unit,
    onToggleStoreInstall: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    var selectedTab by remember { mutableIntStateOf(0) }
    var extName by remember { mutableStateOf("") }
    var extDesc by remember { mutableStateOf("") }
    var extCode by remember {
        mutableStateOf("name=\"greeter\"\n\"greeter\"@vale=\"3\"\n\"greeter\"@definition=\"Hello! How can I help?\"")
    }
    var quantize8Bit by remember { mutableStateOf(true) }
    var buildFeedback by remember { mutableStateOf<Pair<Boolean, String>?>(null) }
    var expandedWikiId by remember { mutableStateOf<String?>(null) }

    val parsePreview = remember(extCode) { NeuroLangParser.parse(extCode) }

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
                    title = "Extension Builder & Store",
                    subtitle = "Compile NeuroLang extensions directly into OneBrain or install built-in skills."
                )
            }

            item {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    listOf("Create", "My Extensions (${state.builtExtensions.size})", "Templates", "Store", "Wiki").forEachIndexed { idx, label ->
                        CoralPillButton(
                            text = label,
                            primary = selectedTab == idx,
                            onClick = { selectedTab = idx },
                            modifier = Modifier.testTag("builder_tab_$idx")
                        )
                    }
                }
            }

            when (selectedTab) {
                0 -> {
                    item {
                        GlassPanel {
                            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text(
                                    text = "New NeuroLang Extension",
                                    style = MaterialTheme.typography.titleLarge,
                                    color = NeuroColors.CoralSoft
                                )
                                PillTextField(
                                    value = extName,
                                    onValueChange = { extName = it },
                                    placeholder = "Extension name (e.g. planner-expert)",
                                    modifier = Modifier.testTag("ext_name_input")
                                )
                                PillTextField(
                                    value = extDesc,
                                    onValueChange = { extDesc = it },
                                    placeholder = "What does this extension do?",
                                    modifier = Modifier.testTag("ext_desc_input")
                                )
                                PillTextField(
                                    value = extCode,
                                    onValueChange = { extCode = it },
                                    placeholder = "NeuroLang code",
                                    singleLine = false,
                                    maxLines = 10,
                                    shape = RoundedCornerShape(24.dp),
                                    textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = NeuroMonoFamily),
                                    modifier = Modifier.testTag("ext_code_input")
                                )

                                // Live syntax validation chip
                                if (parsePreview.isValid) {
                                    StatusChip(
                                        label = "Valid NDL: ${parsePreview.neurons.size} neuron(s), ${parsePreview.connectionCount} edge(s)",
                                        toneColor = NeuroColors.ShoggothGreen
                                    )
                                } else {
                                    StatusChip(
                                        label = parsePreview.errors.firstOrNull() ?: "Enter NeuroLang statements",
                                        toneColor = NeuroColors.ErrorPink
                                    )
                                }

                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Text(
                                        text = "Quantize to 8 bits when saving",
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = NeuroColors.Ink
                                    )
                                    Switch(
                                        checked = quantize8Bit,
                                        onCheckedChange = { quantize8Bit = it },
                                        colors = SwitchDefaults.colors(
                                            checkedThumbColor = NeuroColors.CoralSoft,
                                            checkedTrackColor = NeuroColors.PrimaryFill
                                        )
                                    )
                                }

                                CoralPillButton(
                                    text = "Build & Graft into OneBrain",
                                    onClick = {
                                        buildFeedback = onBuildExtension(extName, extDesc, extCode, quantize8Bit)
                                    },
                                    modifier = Modifier.testTag("build_extension_button")
                                )

                                buildFeedback?.let { (ok, msg) ->
                                    Text(
                                        text = msg,
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = if (ok) NeuroColors.ShoggothGreen else NeuroColors.ErrorPink
                                    )
                                }
                            }
                        }
                    }
                }

                1 -> {
                    if (state.builtExtensions.isEmpty()) {
                        item {
                            GlassPanel {
                                Text(
                                    text = "No custom extensions yet. Build one in Create or load a Template.",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = NeuroColors.InkDim
                                )
                            }
                        }
                    } else {
                        items(state.builtExtensions, key = { it.id }) { ext ->
                            GlassPanel(highlighted = ext.activeInMesh) {
                                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Row(
                                        modifier = Modifier.fillMaxWidth(),
                                        horizontalArrangement = Arrangement.SpaceBetween,
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        Column(modifier = Modifier.weight(1f)) {
                                            Text(
                                                text = ext.name,
                                                style = MaterialTheme.typography.titleMedium,
                                                color = NeuroColors.CoralSoft
                                            )
                                            Text(
                                                text = "${ext.neurons.size} neuron(s) • ${ext.connectionCount} connection(s)" +
                                                    if (ext.quantized8Bit) " • 8-bit" else "",
                                                style = MaterialTheme.typography.bodySmall,
                                                color = NeuroColors.InkDim
                                            )
                                        }
                                        StatusChip(
                                            label = if (ext.activeInMesh) "Grafted" else "Inactive",
                                            toneColor = if (ext.activeInMesh) NeuroColors.ShoggothGreen else NeuroColors.InkDim
                                        )
                                    }
                                    if (ext.description.isNotBlank()) {
                                        Text(
                                            text = ext.description,
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = NeuroColors.Ink
                                        )
                                    }
                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        CoralPillButton(
                                            text = if (ext.activeInMesh) "Detach" else "Graft",
                                            primary = !ext.activeInMesh,
                                            onClick = { onToggleExtensionActive(ext.id) }
                                        )
                                        CoralPillButton(
                                            text = "Delete",
                                            primary = false,
                                            onClick = { onDeleteExtension(ext.id) }
                                        )
                                    }
                                }
                            }
                        }
                    }
                }

                2 -> {
                    val templates = listOf(
                        Triple("Skill Plugin", "Extend the skill library with a routable NeuroLang expert.", "name=\"greeter\"\n\"greeter\"@vale=\"3\"\n\"greeter\"@definition=\"Hello! How can I help?\""),
                        Triple("Tool Integration", "Connect lookup and response neurons with weighted synapses.", "name=\"lookup\"\n\"lookup\"@vale=\"5\"\n\"lookup\"@definition=\"Looking that up for you.\"\nname=\"answer\"\n\"answer\"@connections=\".lookup*0.8+0.1\""),
                        Triple("Data Processor", "Three-stage pipeline from input_layer through hidden_layer to output_layer.", "name=\"input_layer\"\n\"input_layer\"@vale=\"10\"\nname=\"hidden_layer\"\n\"hidden_layer\"@connections=\".input_layer*0.5\"\nname=\"output_layer\"\n\"output_layer\"@connections=\".hidden_layer*0.5\""),
                        Triple("UI Prompt Trigger", "Define a lightweight interactive prompt label neuron.", "name=\"button_label\"\n\"button_label\"@vale=\"2\"\n\"button_label\"@definition=\"[[ask: Inspect Mesh | What is the current mesh and vale state?]]\"")
                    )
                    items(templates, key = { it.first }) { (title, desc, code) ->
                        GlassPanel {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(title, style = MaterialTheme.typography.titleMedium, color = NeuroColors.CoralSoft)
                                Text(desc, style = MaterialTheme.typography.bodyMedium, color = NeuroColors.InkDim)
                                CoralPillButton(
                                    text = "Use Template",
                                    onClick = {
                                        extName = title.lowercase().replace(" ", "-")
                                        extDesc = desc
                                        extCode = code
                                        selectedTab = 0
                                    }
                                )
                            }
                        }
                    }
                }

                3 -> {
                    items(state.storeItems, key = { it.id }) { item ->
                        GlassPanel(highlighted = item.installed) {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(item.title, style = MaterialTheme.typography.titleMedium, color = NeuroColors.CoralSoft)
                                    StatusChip(label = "${item.kind} • ${item.category}", toneColor = NeuroColors.InkDim)
                                }
                                Text(item.description, style = MaterialTheme.typography.bodyMedium, color = NeuroColors.Ink)
                                Text("By ${item.author}", style = MaterialTheme.typography.bodySmall, color = NeuroColors.InkDim)
                                CoralPillButton(
                                    text = if (item.installed) "Uninstall" else "Install into Mesh",
                                    primary = !item.installed,
                                    onClick = { onToggleStoreInstall(item.id) }
                                )
                            }
                        }
                    }
                }

                else -> {
                    items(state.wikiArticles, key = { it.id }) { article ->
                        val open = expandedWikiId == article.id
                        GlassPanel {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(article.title, style = MaterialTheme.typography.titleMedium, color = NeuroColors.CoralSoft)
                                Text(article.summary, style = MaterialTheme.typography.bodyMedium, color = NeuroColors.InkDim)
                                if (open) {
                                    Text(article.content, style = MaterialTheme.typography.bodyMedium, color = NeuroColors.Ink)
                                }
                                CoralPillButton(
                                    text = if (open) "Hide" else "Read",
                                    primary = !open,
                                    onClick = { expandedWikiId = if (open) null else article.id }
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
