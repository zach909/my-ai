package ai.neuroclaw.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.provider.Settings as AndroidSettings
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.TextView

/**
 * The one look, for the screens that are native. The owner chose the look of the terminal page plus the ring behind
 * it (AGENTS.md, "VISUAL STYLE") and wants it everywhere; the pages the phone shows in a web view already have it,
 * and this makes the native screens match: soft coral on warm dark, no blue, everything round, glass fills, the
 * same ring behind. The numbers below are the ones in interface/ambient.ts; nothing here is a second design.
 *
 * Not reproduced, because Android views cannot do it: the blur behind glass (the fills are translucent instead, over
 * the same ring) and the rounded system type (the phone's own sans-serif is used; no font is shipped).
 */
object Look {
    val GROUND = Color.parseColor("#110c0e")
    val GROUND_2 = Color.parseColor("#1b1216")
    val INK = Color.parseColor("#f8ede9")
    val DIM = Color.argb(0x9E, 0xf8, 0xed, 0xe9)         // rgba(248,237,233,.62)
    val FAINT = Color.argb(0x66, 0xf8, 0xed, 0xe9)       // placeholder text, .4
    val LINE = Color.argb(0x33, 0xff, 0xe4, 0xda)        // rgba(255,228,218,.2)
    val LINE_FOCUS = Color.argb(0xB3, 0xff, 0x9a, 0x84)  // focused input, .7
    val GLASS = Color.argb(0x14, 0xff, 0xf0, 0xe8)       // rgba(255,240,232,.08)
    val BUTTON = Color.argb(0x12, 0xff, 0xee, 0xe6)      // rgba(255,238,230,.07)
    val INPUT = Color.argb(0x66, 0x14, 0x0c, 0x0e)       // rgba(20,12,14,.4)
    val ACCENT = Color.parseColor("#ff9a84")
    val SOFT = Color.parseColor("#ffc4b4")
    val PRIMARY_FILL = Color.argb(0x29, 0xff, 0x9a, 0x84) // rgba(255,154,132,.16)
    val PRIMARY_LINE = Color.argb(0x80, 0xff, 0x9a, 0x84) // rgba(255,154,132,.5)
    val ERROR = Color.parseColor("#ff9aa8")
    val ONLINE = Color.parseColor("#8fe3a8")

    /** Tag a Button with this before styleTree() and it gets the coral glass style. */
    const val PRIMARY = "nc-primary"
    /** Tag a TextView with this before styleTree() and it gets the dimmed text colour. */
    const val DIMMED = "nc-dim"

    fun dp(context: Context, v: Int): Int = (v * context.resources.displayMetrics.density).toInt()

    /** A rounded, translucent surface with a 1px line. A radius bigger than half the height makes it a pill. */
    fun shape(context: Context, fill: Int, line: Int, radiusDp: Int): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        setColor(fill)
        cornerRadius = dp(context, radiusDp).toFloat()
        setStroke(maxOf(1, dp(context, 1)), line)
    }

    /**
     * A glass panel. `solid` is for panels that float over other apps (the bubble and the assistant sheet), which
     * have no ring behind them to show through, so the fill is nearly opaque there.
     */
    fun glass(view: View, radiusDp: Int = 32, solid: Boolean = false) {
        val fill = if (solid) Color.argb(0xF2, 0x1b, 0x12, 0x16) else GLASS
        view.background = shape(view.context, fill, LINE, radiusDp)
    }

    fun button(b: Button, primary: Boolean = false) {
        val c = b.context
        b.background = shape(c, if (primary) PRIMARY_FILL else BUTTON, if (primary) PRIMARY_LINE else LINE, 999)
        b.setTextColor(if (primary) SOFT else INK)
        b.isAllCaps = false
        b.typeface = Typeface.DEFAULT_BOLD
        b.stateListAnimator = null // the stock button lifts with a shadow; ours is flat glass
        b.minWidth = 0
        b.minimumWidth = 0
        b.minHeight = dp(c, 44) // a comfortable tap target
        b.minimumHeight = dp(c, 44)
        b.setPadding(dp(c, 18), dp(c, 9), dp(c, 18), dp(c, 9))
        springOnPress(b)
    }

    fun input(e: EditText, radiusDp: Int = 999) {
        val c = e.context
        e.background = shape(c, INPUT, LINE, radiusDp)
        e.setTextColor(INK)
        e.setHintTextColor(FAINT)
        e.highlightColor = Color.argb(0x55, 0xff, 0x9a, 0x84)
        e.setPadding(dp(c, 18), dp(c, 10), dp(c, 18), dp(c, 10))
        e.setOnFocusChangeListener { v, focused -> v.background = shape(v.context, INPUT, if (focused) LINE_FOCUS else LINE, radiusDp) }
    }

    /** Colour every Button, EditText and TextView under `root`, so screens built in code need no per-widget styling. */
    fun styleTree(root: View) {
        when (root) {
            is Button -> button(root, root.tag == PRIMARY)
            is EditText -> input(root)
            is TextView -> root.setTextColor(if (root.tag == DIMMED) DIM else INK)
            else -> Unit
        }
        if (root is ViewGroup) for (i in 0 until root.childCount) styleTree(root.getChildAt(i))
    }

    /**
     * Press shrinks to .95 and lets go with a spring, like the buttons on the web pages. Left out when the person
     * has animations turned off in Android's developer settings (the app's counterpart of prefers-reduced-motion).
     */
    @SuppressLint("ClickableViewAccessibility")
    private fun springOnPress(v: View) {
        v.setOnTouchListener { view, e ->
            if (animationsOn(view.context)) {
                when (e.actionMasked) {
                    MotionEvent.ACTION_DOWN -> view.animate().scaleX(0.95f).scaleY(0.95f).setDuration(90).setInterpolator(DecelerateInterpolator()).start()
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL ->
                        view.animate().scaleX(1f).scaleY(1f).setDuration(260).setInterpolator(OvershootInterpolator(3f)).start()
                }
            }
            false // never swallow the touch: the click still happens
        }
    }

    private fun animationsOn(context: Context): Boolean =
        AndroidSettings.Global.getFloat(context.contentResolver, AndroidSettings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f

    /**
     * Draw behind the system bars, as Android 15 does anyway for an app like this one, and pad `view` by the bars and
     * the keyboard so nothing sits under them. `view` should be the screen's top-level view.
     */
    @Suppress("DEPRECATION") // the systemWindowInset* getters are the only way below Android 11
    fun fitSystemBars(activity: Activity, view: View) {
        if (Build.VERSION.SDK_INT >= 30) activity.window.setDecorFitsSystemWindows(false)
        view.setOnApplyWindowInsetsListener { v, insets ->
            val left: Int
            val top: Int
            val right: Int
            val bottom: Int
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                val keyboard = insets.getInsets(WindowInsets.Type.ime())
                left = bars.left; top = bars.top; right = bars.right
                bottom = maxOf(bars.bottom, keyboard.bottom)
            } else {
                left = insets.systemWindowInsetLeft
                top = insets.systemWindowInsetTop
                right = insets.systemWindowInsetRight
                bottom = insets.systemWindowInsetBottom
            }
            v.setPadding(left, top, right, bottom)
            insets
        }
        view.requestApplyInsets()
    }

    /**
     * The ring behind a native screen: the very ambient.css and ambient.js the web pages use (generated into
     * assets/look by scripts/sync-ambient.mjs), drawn by the WebView's own Canvas 2D. They are inlined into one page
     * and loaded with no address, so the page has no file or network access and never navigates anywhere.
     * Put it at the bottom of a FrameLayout, and call onPause/onResume/destroy from the screen's lifecycle.
     */
    @SuppressLint("SetJavaScriptEnabled")
    fun ring(context: Context): WebView = WebView(context).apply {
        setBackgroundColor(GROUND)
        settings.javaScriptEnabled = true // ambient.js draws the ring
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        isFocusable = false
        isClickable = false
        isLongClickable = false
        isHapticFeedbackEnabled = false
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest): Boolean = true
        }
        val css = runCatching { context.assets.open("look/ambient.css").bufferedReader().use { it.readText() } }.getOrDefault("")
        val js = runCatching { context.assets.open("look/ambient.js").bufferedReader().use { it.readText() } }.getOrDefault("")
        // If the files are missing the screen is still the same colours, just without the ring.
        loadDataWithBaseURL(
            null,
            "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
                "<style>$css</style><body class=nc-soft><script>$js</script></body>",
            "text/html", "utf-8", null,
        )
    }
}
