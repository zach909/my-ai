package ai.neuroclaw.app

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.view.Gravity
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

/**
 * The conversation view, shared by the floating bubble's panel, the assistant sheet and the main screen: the
 * transcript, a message box, Send, a mic for voice-to-text, a camera button for a training photo, and a Screen
 * button so it can see what's on your screen (both go through the tap-to-capture pipeline, uploaded to the PC as
 * training data).
 *
 * Drawn in the house look (Look.kt): glass panel, round bubbles, pill buttons, coral. A reply can carry prompt
 * buttons, `[[ask: Label | prompt]]` (PromptButtons.kt, the same rule as the chat page): they are drawn as pills
 * and a tap sends the prompt as the next message, exactly as if it had been typed.
 */
class ChatPanel(context: Context, private val onClose: (() -> Unit)? = null) : LinearLayout(context) {
    private val list = LinearLayout(context).apply { orientation = VERTICAL }
    private val scroll = ScrollView(context).apply { addView(list) }
    private val input = EditText(context).apply {
        hint = "Talk to NeuroClaw"
        imeOptions = EditorInfo.IME_ACTION_SEND
        setSingleLine(false)
        maxLines = 4
    }
    private val send = Button(context).apply { text = "Send" }
    private val mic = Button(context).apply { text = "🎙" } // microphone glyph
    private val camera = Button(context).apply { text = "Photo" }
    private val screen = Button(context).apply { text = "Screen" }
    private var recognizer: SpeechRecognizer? = null
    private var listening = false

    init {
        orientation = VERTICAL
        setPadding(dp(14), dp(14), dp(14), dp(14))
        if (onClose != null) {
            addView(LinearLayout(context).apply {
                gravity = Gravity.END
                addView(Button(context).apply { text = "Close"; setOnClickListener { onClose.invoke() } })
            })
        }
        addView(scroll, LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))
        addView(LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(input, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
            addView(mic)
            addView(camera)
            addView(screen)
            addView(send)
        })
        // Panels that float over other apps (the bubble, the assistant sheet) have no ring behind them to show
        // through, so they get a nearly opaque glass; on the main screen the glass is see-through.
        Look.glass(this, 28, solid = onClose != null)
        Look.styleTree(this)
        Look.button(send, primary = true)
        send.setOnClickListener { submit() }
        input.setOnEditorActionListener { _, id, _ -> if (id == EditorInfo.IME_ACTION_SEND) { submit(); true } else false }
        mic.setOnClickListener { toggleListening() }
        camera.setOnClickListener {
            // Whatever is typed goes with the photo as its note.
            context.startActivity(
                Intent(context, CaptureActivity::class.java)
                    .putExtra(CaptureActivity.EXTRA_NOTE, input.text.toString())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }
        screen.setOnClickListener {
            context.startActivity(
                Intent(context, ScreenCaptureActivity::class.java)
                    .putExtra(ScreenCaptureActivity.EXTRA_NOTE, input.text.toString())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }
        addNote("NeuroClaw runs on this phone; it syncs with your PC when it can reach it.")
    }

    /** Voice-to-text: tap to start listening, tap again (or silence) to stop; the words land in the input box. */
    private fun toggleListening() {
        if (listening) { stopListening(); return }
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            Toast.makeText(context, "No speech recognizer on this device", Toast.LENGTH_SHORT).show()
            return
        }
        if (context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(context, "Grant microphone access first, in the app's main screen", Toast.LENGTH_LONG).show()
            return
        }
        val r = recognizer ?: SpeechRecognizer.createSpeechRecognizer(context).also { recognizer = it }
        r.setRecognitionListener(object : RecognitionListener {
            override fun onResults(results: Bundle) {
                val text = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (!text.isNullOrBlank()) input.setText(if (input.text.isBlank()) text else "${input.text} $text")
                listening = false; mic.text = "🎙"
            }
            override fun onError(error: Int) { listening = false; mic.text = "🎙" }
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        r.startListening(intent)
        listening = true
        mic.text = "⏹" // stop glyph
    }

    private fun stopListening() {
        recognizer?.stopListening()
        listening = false
        mic.text = "🎙"
    }

    /** Send what is typed, or `prompt` when a prompt button was tapped. Ignored while a reply is still coming. */
    private fun submit(prompt: String? = null) {
        val text = (prompt ?: input.text.toString()).trim()
        if (text.isEmpty() || !send.isEnabled) return
        if (prompt == null) input.setText("")
        addBubble(mine = true).addView(prose(text))
        send.isEnabled = false
        Shared.background({ Shared.brain(context).send(text) }) { reply ->
            addReply(reply.text)
            send.isEnabled = true
        }
    }

    /** A reply: its prose as text, its prompt buttons as pills in order. */
    private fun addReply(text: String) {
        val bubble = addBubble(mine = false)
        val failed = text.startsWith("The phone's network failed")
        for (part in PromptButtons.split(text)) {
            when {
                !part.isButton -> bubble.addView(prose(part.text, color = if (failed) Look.ERROR else Look.INK))
                // A phone has no desktop or app menu to place a button on, so a [[put: ...]] shows its label only.
                part.put != null -> bubble.addView(prose(part.text, color = Look.DIM))
                else -> bubble.addView(Button(context).apply {
                    this.text = part.text
                    Look.button(this, primary = true)
                    textSize = 14f
                    setOnClickListener { submit(part.prompt) }
                }, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4); bottomMargin = dp(4) })
            }
        }
        scrollToEnd()
    }

    private fun addNote(line: String) {
        list.addView(TextView(context).apply {
            text = line
            textSize = 13f
            setTextColor(Look.DIM)
        })
    }

    /** A rounded message bubble, yours on the right in coral glass, NeuroClaw's on the left in plain glass. */
    private fun addBubble(mine: Boolean): LinearLayout {
        val bubble = LinearLayout(context).apply {
            orientation = VERTICAL
            setPadding(dp(14), dp(10), dp(14), dp(10))
            background = Look.shape(context, if (mine) Look.PRIMARY_FILL else Look.GLASS, if (mine) Look.PRIMARY_LINE else Look.LINE, 24)
        }
        list.addView(bubble, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
            gravity = if (mine) Gravity.END else Gravity.START
            topMargin = dp(8)
        })
        scrollToEnd()
        return bubble
    }

    private fun prose(text: String, color: Int = Look.INK): TextView = TextView(context).apply {
        this.text = text
        textSize = 15f
        setTextColor(color)
        setTextIsSelectable(true)
    }

    private fun scrollToEnd() {
        scroll.post { scroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }

    private fun dp(v: Int) = Look.dp(context, v)
}
