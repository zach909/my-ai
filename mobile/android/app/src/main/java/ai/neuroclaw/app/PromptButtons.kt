package ai.neuroclaw.app

/**
 * Prompt buttons in a reply: `[[ask: Label | prompt]]` is a button that says Label, and tapping it sends `prompt`
 * as the next message exactly as if it had been typed. `[[ask: Label]]` sends the label itself.
 *
 * This is the same rule as splitPromptButtons() in interface/prompt-buttons.ts (the chat page runs that one), so the
 * phone's chat and the page read a reply the same way: at most 12 buttons a message, labels up to 60 characters,
 * prompts up to 500, and a marker that is empty, too long or past the limit stays where it is, as text. Prose is
 * kept exactly as written. test/platform/mobile-native.test.mjs checks that the limits here match the TypeScript.
 *
 * `[[put: ...]]` offers to place a button on a computer's desktop or app menu. A phone has neither, so it is
 * read the same way but shown as its label only (see ChatPanel); nothing is placed.
 */
object PromptButtons {
    const val MAX_PER_MESSAGE = 12
    const val LABEL_MAX = 60
    const val PROMPT_MAX = 500

    /** A piece of a reply: prose (isButton false, text is the prose) or a button (text is the label). */
    class Part(val isButton: Boolean, val text: String, val prompt: String = "", val put: String? = null)

    private val marker = Regex("\\[\\[(ask|put):([^\\]]*)\\]\\]", RegexOption.IGNORE_CASE)

    fun split(raw: String): List<Part> {
        val parts = ArrayList<Part>()
        var last = 0
        var count = 0
        for (m in marker.findAll(raw)) {
            val isPut = m.groupValues[1].equals("put", ignoreCase = true)
            val bits = m.groupValues[2].split("|")
            if (bits[0].contains('\n') || bits[0].contains('\r')) continue
            val label = bits[0].trim()
            val prompt: String
            var place = "menu"
            if (isPut) {
                prompt = (if (bits.size > 1) bits[1] else bits[0]).trim()
                val where = (if (bits.size > 2) bits[2] else "menu").trim().lowercase()
                if (where != "menu" && where != "desktop") continue
                place = where
            } else {
                prompt = (if (bits.size > 1) bits.drop(1).joinToString("|") else bits[0]).trim()
            }
            if (count >= MAX_PER_MESSAGE || label.isEmpty() || prompt.isEmpty() || label.length > LABEL_MAX || prompt.length > PROMPT_MAX) continue
            if (m.range.first > last) parts.add(Part(false, raw.substring(last, m.range.first)))
            parts.add(Part(true, label, prompt, if (isPut) place else null))
            last = m.range.last + 1
            count++
        }
        if (last < raw.length) parts.add(Part(false, raw.substring(last)))
        return parts
    }
}
