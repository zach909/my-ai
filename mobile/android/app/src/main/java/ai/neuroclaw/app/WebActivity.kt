package ai.neuroclaw.app

import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.view.KeyEvent
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast

/**
 * The shared NeuroClaw interface (the home chat at "/", Settings at "/settings", and the rest), full screen. The
 * pages are served by NeuroClaw's own server running on this phone (PhoneServer.kt): the same server code a
 * computer runs, so the phone shows and does exactly what the computer does, with no PC involved. Uses Android's
 * built-in WebView; nothing third-party. The server's first start takes a few seconds, during which a page in the
 * same look says so; if it cannot start, the page says why and offers to try again.
 *
 * Files the pages offer to download (Settings > Data > Download chats, exports) go to the phone's Downloads
 * folder: a WebView drops them silently unless the app handles them.
 */
class WebActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var server: PhoneServer
    private var chooser: ValueCallback<Array<Uri>>? = null
    private var path = "/"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        server = PhoneServer.get(this).also { it.start() }
        val base = server.baseUrl
        path = intent.getStringExtra(EXTRA_PATH)?.takeIf { it.startsWith("/") && !it.startsWith("//") } ?: "/"
        web = WebView(this).apply {
            setBackgroundColor(Look.GROUND) // no white flash before the page's own dark ground arrives
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = object : WebViewClient() {
                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) view.loadDataWithBaseURL(null, errorPage(error.description.toString()), "text/html", "utf-8", null)
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.url.toString().startsWith(base)) return false
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    return true
                }
            }
            webChromeClient = object : WebChromeClient() {
                // Camera and microphone only for NeuroClaw's own server on this phone, and Android still asks for its own permission.
                override fun onPermissionRequest(request: PermissionRequest) {
                    if (request.origin.toString().startsWith(base)) request.grant(request.resources) else request.deny()
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

        if (savedInstanceState != null && web.restoreState(savedInstanceState) != null) return
        web.loadDataWithBaseURL(null, startingPage(), "text/html", "utf-8", null)
        server.whenReady { open() }
    }

    /** Go to the page once the server is up (or say why it is not). */
    private fun open() {
        if (isDestroyed) return
        if (server.state == PhoneServer.State.READY) web.loadUrl(server.openUrl(path))
        else web.loadDataWithBaseURL(null, errorPage(server.error ?: "it did not start"), "text/html", "utf-8", null)
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

    /** Hand a file the page offered to Android's download manager, signed in the way the page is (its cookie). */
    private fun download(base: String, url: String, userAgent: String, contentDisposition: String, mimeType: String) {
        if (!url.startsWith(base)) {
            // Not NeuroClaw's own server: let whatever the person has installed deal with it.
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
            getSystemService(DownloadManager::class.java).enqueue(request)
            Toast.makeText(this, "Downloading $name to your Downloads folder", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Could not start the download: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    /** The house look, in the two pages that cannot come from the server (it is the server that is not up yet). */
    private fun card(body: String): String =
        "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
            "<body style='margin:0;padding:24px;background:radial-gradient(120% 90% at 50% 40%,#1b1216,#110c0e 70%) fixed,#110c0e;" +
            "color:#f8ede9;font-family:ui-rounded,system-ui,sans-serif'>" +
            "<div style='background:rgba(255,240,232,.08);border:1px solid rgba(255,228,218,.2);border-radius:32px;padding:24px'>$body</div></body>"

    private fun startingPage(): String =
        card("<h2 style='margin-top:0'>Starting NeuroClaw</h2><p style='color:rgba(248,237,233,.62)'>NeuroClaw runs on this phone. The first start takes a little while.</p>")

    private fun errorPage(reason: String): String {
        val why = android.text.TextUtils.htmlEncode(reason)
        return card(
            "<h2 style='margin-top:0'>NeuroClaw did not start</h2><p style='color:rgba(248,237,233,.62)'>$why</p>" +
                "<p style='color:rgba(248,237,233,.62)'>Press Back and open it again. If this keeps happening, the phone may be low on memory: close other apps first.</p>",
        )
    }

    companion object {
        const val EXTRA_PATH = "path"
        private const val REQ_FILE = 71
    }
}
