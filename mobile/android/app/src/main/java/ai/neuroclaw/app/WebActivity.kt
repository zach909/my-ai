package ai.neuroclaw.app

import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.util.Base64
import android.view.KeyEvent
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.URLUtil
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast

/**
 * The shared NeuroClaw interface (the home chat at "/", Settings at "/settings", and the rest), full screen, served by
 * the PC, so the phone shows and does exactly what the browser does. Uses Android's built-in WebView; nothing third-party.
 * The page handles its own login (session cookie), so no password is passed in.
 * A server that cannot be reached shows a page that says so and offers to try again, instead of a blank screen.
 * Files the pages offer to download (Settings > Data > Download chats, exports) go to the phone's Downloads folder:
 * a WebView drops them silently unless the app handles them.
 */
class WebActivity : Activity() {
    private lateinit var web: WebView
    private var chooser: ValueCallback<Array<Uri>>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val base = Shared.brain(this).settings.serverUrl
        web = WebView(this).apply {
            setBackgroundColor(Look.GROUND) // no white flash before the page's own dark ground arrives
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = object : WebViewClient() {
                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) view.loadDataWithBaseURL(null, errorPage(base, error.description.toString()), "text/html", "utf-8", null)
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (base.isNotEmpty() && request.url.toString().startsWith(base)) return false
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    return true
                }
            }
            webChromeClient = object : WebChromeClient() {
                // Camera and microphone only for the NeuroClaw server the person entered, and Android still asks for its own permission.
                override fun onPermissionRequest(request: PermissionRequest) {
                    if (base.isNotEmpty() && request.origin.toString().startsWith(base)) request.grant(request.resources) else request.deny()
                }
                override fun onShowFileChooser(
                    view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams,
                ): Boolean {
                    chooser?.onReceiveValue(null)
                    chooser = callback
                    startActivityForResult(params.createIntent(), REQ_FILE)
                    return true
                }
            }
        }
        web.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ -> download(base, url, userAgent, contentDisposition, mimeType) }
        // Drawn edge to edge like the rest of the app; the page is padded by the system bars and the keyboard.
        val root = FrameLayout(this).apply {
            setBackgroundColor(Look.GROUND)
            addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        }
        setContentView(root)
        Look.fitSystemBars(this, root)
        val path = intent.getStringExtra(EXTRA_PATH)?.takeIf { it.startsWith("/") } ?: "/"
        when {
            base.isEmpty() -> {
                Toast.makeText(this, "Enter your PC address on the main screen and tap Save first.", Toast.LENGTH_LONG).show()
                finish()
            }
            savedInstanceState != null && web.restoreState(savedInstanceState) != null -> Unit
            else -> web.loadUrl("$base$path")
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_FILE) {
            chooser?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            chooser = null
        } else super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && web.canGoBack()) { web.goBack(); return true }
        return super.onKeyDown(keyCode, event)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    // A page that is out of sight stops its timers and animation (the ring) instead of running down the battery.
    override fun onPause() { super.onPause(); web.onPause() }
    override fun onResume() { super.onResume(); web.onResume() }
    override fun onDestroy() { web.destroy(); super.onDestroy() }

    /** Hand a file the page offered to Android's download manager, signed in the way the page is (its cookie, or the Remote Access password). */
    private fun download(base: String, url: String, userAgent: String, contentDisposition: String, mimeType: String) {
        if (base.isEmpty() || !url.startsWith(base)) {
            // Not the NeuroClaw server: let whatever the person has installed deal with it.
            try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) { Toast.makeText(this, "Nothing on this phone can open that.", Toast.LENGTH_LONG).show() }
            return
        }
        try {
            val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
            val request = DownloadManager.Request(Uri.parse(url))
                .setTitle(name)
                .setMimeType(mimeType)
                .addRequestHeader("User-Agent", userAgent)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            CookieManager.getInstance().getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
            val password = Shared.brain(this).settings.password
            if (password.isNotEmpty()) {
                request.addRequestHeader("Authorization", "Basic " + Base64.encodeToString("neuroclaw:$password".toByteArray(), Base64.NO_WRAP))
            }
            getSystemService(DownloadManager::class.java).enqueue(request)
            Toast.makeText(this, "Downloading $name to your Downloads folder", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Could not start the download: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun errorPage(base: String, reason: String): String {
        val where = android.text.TextUtils.htmlEncode(base)
        val why = android.text.TextUtils.htmlEncode(reason)
        // The house look, in the one page that cannot be served by the engine (it is the engine that did not answer).
        return "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
            "<body style='margin:0;padding:24px;background:radial-gradient(120% 90% at 50% 40%,#1b1216,#110c0e 70%) fixed,#110c0e;" +
            "color:#f8ede9;font-family:ui-rounded,system-ui,sans-serif'>" +
            "<div style='background:rgba(255,240,232,.08);border:1px solid rgba(255,228,218,.2);border-radius:32px;padding:24px'>" +
            "<h2 style='margin-top:0'>Can't reach NeuroClaw</h2><p style='color:rgba(248,237,233,.62)'>$where did not answer ($why).</p>" +
            "<p style='color:rgba(248,237,233,.62)'>Check that NeuroClaw is running on your PC, that this phone is on the same network, and that the address on the main screen is right. It looks like http://192.168.1.20:7861. " +
            "Press Back to use the chat on this phone, which works without your PC.</p>" +
            "<p><a style='display:inline-block;color:#ffc4b4;background:rgba(255,154,132,.16);border:1px solid rgba(255,154,132,.5);" +
            "border-radius:999px;padding:10px 20px;text-decoration:none;font-weight:700' href='$where/'>Try again</a></p></div></body>"
    }

    companion object {
        const val EXTRA_PATH = "path"
        private const val REQ_FILE = 71
    }
}
