package com.example.engine

import com.example.model.NeuroLangConnection
import com.example.model.NeuroLangNeuron

data class NeuroLangParseResult(
    val neurons: List<NeuroLangNeuron>,
    val errors: List<String>,
    val connectionCount: Int
) {
    val isValid: Boolean get() = errors.isEmpty() && neurons.isNotEmpty()
}

/**
 * Pure Kotlin NeuroLang (NDL) parser matching asi_core/neural_dsl.py and builder-page.ts:
 *   name="neuron_name"
 *   "neuron_name"@vale="3" (or @value="3")
 *   "neuron_name"@definition="Hello! How can I help?"
 *   "neuron_name"@connections=".target*0.8+0.1;other*0.5"
 *   "neuron_name"@code="..."
 *   "neuron_name"@type="..."
 */
object NeuroLangParser {
    private val nameLineRegex = Regex("""^name\s*=\s*"([^"]*)"\s*$""")
    private val attrLineRegex = Regex("""^"?([^"@]+)"?@(\w+)\s*=\s*"([^"]*)"\s*$""")
    private val connTermRegex = Regex("""^\.?([\w.-]+)\*([+-]?[\d.]+)(?:\+([+-]?[\d.]+))?$""")
    private val knownAttrs = setOf("vale", "value", "definition", "connections", "code", "type")

    fun parse(source: String): NeuroLangParseResult {
        val map = LinkedHashMap<String, MutableNeuron>()
        val errors = ArrayList<String>()

        source.lines().forEachIndexed { idx, raw ->
            val lineno = idx + 1
            val line = raw.trim()
            if (line.isEmpty() || line.startsWith("#")) return@forEachIndexed

            val nameMatch = nameLineRegex.matchEntire(line)
            if (nameMatch != null) {
                val n = nameMatch.groupValues[1].trim()
                if (n.isEmpty()) {
                    errors.add("Line $lineno: empty neuron name")
                } else {
                    map.getOrPut(n) { MutableNeuron(n) }
                }
                return@forEachIndexed
            }

            val attrMatch = attrLineRegex.matchEntire(line)
            if (attrMatch != null) {
                val owner = attrMatch.groupValues[1].trim()
                val attr = attrMatch.groupValues[2].trim().lowercase()
                val value = attrMatch.groupValues[3]
                if (attr !in knownAttrs) {
                    errors.add("Line $lineno: unknown attribute '@$attr'")
                    return@forEachIndexed
                }
                val neuron = map.getOrPut(owner) { MutableNeuron(owner) }
                when (attr) {
                    "vale", "value" -> {
                        val parsed = value.toFloatOrNull()
                        if (parsed == null) {
                            errors.add("Line $lineno: invalid numeric @$attr value '$value'")
                        } else {
                            neuron.vale = parsed
                        }
                    }
                    "definition" -> neuron.definition = value
                    "code" -> neuron.code = value
                    "type" -> neuron.type = value
                    "connections" -> {
                        val terms = value.split(";").map { it.trim() }.filter { it.isNotEmpty() }
                        for (term in terms) {
                            val cm = connTermRegex.matchEntire(term)
                            if (cm == null) {
                                errors.add("Line $lineno: invalid connection '$term' (expected target*weight[+bias])")
                            } else {
                                val target = cm.groupValues[1]
                                val weight = cm.groupValues[2].toFloatOrNull() ?: 1f
                                val bias = cm.groupValues[3].toFloatOrNull() ?: 0f
                                neuron.connections.add(NeuroLangConnection(target, weight, bias))
                            }
                        }
                    }
                }
                return@forEachIndexed
            }

            errors.add("Line $lineno: could not parse '$line'")
        }

        if (map.isEmpty() && errors.isEmpty()) {
            errors.add("No NeuroLang neuron definitions found.")
        }

        val neurons = map.values.map {
            NeuroLangNeuron(
                name = it.name,
                vale = it.vale,
                definition = it.definition,
                connections = it.connections.toList(),
                code = it.code,
                type = it.type
            )
        }
        val connCount = neurons.sumOf { it.connections.size }
        return NeuroLangParseResult(neurons = neurons, errors = errors, connectionCount = connCount)
    }

    private class MutableNeuron(
        val name: String,
        var vale: Float = 1f,
        var definition: String = "",
        val connections: ArrayList<NeuroLangConnection> = ArrayList(),
        var code: String? = null,
        var type: String? = null
    )
}
