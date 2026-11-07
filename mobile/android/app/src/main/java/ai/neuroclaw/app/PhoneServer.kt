package ai.neuroclaw.app

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.io.RandomAccessFile
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * NeuroClaw's own server, running on the phone: the computer's server, not a copy of it.
 *
 * `assets/neuroclaw-server.js` is the PC's engine and web server bundled for the phone (mobile/server, built by
 * scripts/release/build-mobile-server.mjs). It runs in a hidden WebView, as the phone brain does (PhoneNetwork.kt).
 * That code has no Node to call, so everything it needs from the phone comes through one door, `NativeHost.call`
 * (see mobile/server/src/shims/host.ts): files in this app's private storage, a log line, and the answers it gives
 * to requests. This class implements that door.
 *
 * The pages and the API are reached on a local address, http://127.0.0.1:<port>, which the app's own web screen
 * (WebActivity) loads. So the phone shows the very same pages the computer serves, from the phone itself, with no
 * PC needed. Nothing here listens on the network: the socket is bound to the loopback address only.
 *
 * Other apps on a phone can connect to 127.0.0.1 too, so every request must carry this install's secret
 * (a cookie that only [openUrl] sets); anything else is refused.
 */
class PhoneServer private constructor(private val context: Context) {
    enum class State { STARTING, READY, FAILED }

    @Volatile var state = State.STARTING
        private set
    @Volatile var error: String? = null
        private set

    private val appContext = context.applicationContext
    private val token = Settings(appContext).phoneToken
    private val home = File(appContext.filesDir, "phone-home").apply { mkdirs() }
    private val tmp = File(appContext.cacheDir, "phone-tmp").apply { mkdirs() }
    private val pool = Executors.newCachedThreadPool()
    private val connections = ConcurrentHashMap<Int, Connection>()
    private val nextId = AtomicInteger(1)
    private val listeners = ArrayList<() -> Unit>()
    private lateinit var socket: ServerSocket
    private var engine: WebView? = null

    /** The address of the local server. Valid once [start] has returned. */
    val baseUrl: String get() = "http://127.0.0.1:${socket.localPort}"

    /** The address a web screen should load to open `path`: it also sets the secret cookie, then goes to the page. */
    fun openUrl(path: String): String {
        val safe = if (path.startsWith("/") && !path.startsWith("//")) path else "/"
        return "$baseUrl/__nc_open?t=$token&to=${Uri.encode(safe)}"
    }

    /** Run `then` on the main thread when the engine is up (at once if it already is). */
    fun whenReady(then: () -> Unit) {
        synchronized(listeners) {
            if (state == State.STARTING) { listeners.add(then); return }
        }
        Shared.main.post { then() }
    }

    private fun finish(newState: State, why: String?) {
        val toRun: List<() -> Unit>
        synchronized(listeners) {
            state = newState
            error = why
            toRun = ArrayList(listeners)
            listeners.clear()
        }
        toRun.forEach { run -> Shared.main.post { run() } }
    }

    /** Open the local address and start the engine. Safe to call more than once. */
    @Synchronized
    fun start() {
        if (engine != null) return
        socket = openSocket()
        pool.execute { acceptLoop() }
        Shared.main.post { startEngine() }
    }

    /** The same port every time when it is free, because a web page's saved settings and sign-in belong to its address. */
    private fun openSocket(): ServerSocket {
        val prefs = appContext.getSharedPreferences("neuroclaw", Context.MODE_PRIVATE)
        val loopback = InetAddress.getByName("127.0.0.1")
        val wanted = prefs.getInt("phoneServerPort", 0)
        val s = try { ServerSocket(wanted, 50, loopback) } catch (_: IOException) { ServerSocket(0, 50, loopback) }
        prefs.edit().putInt("phoneServerPort", s.localPort).apply()
        return s
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Suppress("DEPRECATION") // allowUniversalAccessFromFileURLs: see the note where it is set
    private fun startEngine() {
        val view = WebView(appContext)
        view.settings.javaScriptEnabled = true
        // The engine page is this app's own code from its assets and loads nothing else. Letting it (and only it)
        // reach other web addresses is what lets the engine fetch the store, wiki and search without a native proxy.
        view.settings.allowUniversalAccessFromFileURLs = true
        view.addJavascriptInterface(Host(), "NativeHost")
        view.webViewClient = object : WebViewClient() {
            override fun onPageFinished(v: WebView, url: String?) {
                v.evaluateJavascript("NeuroClawServer.start()", null)
            }
        }
        view.loadDataWithBaseURL(
            "file:///android_asset/",
            "<!doctype html><html><body><script src=\"neuroclaw-server.js\"></script></body></html>",
            "text/html", "utf-8", null,
        )
        engine = view
    }

    // ------------------------------------------------------------------------------------------------------------
    // The local HTTP server: one request per connection, answered by the JavaScript server.
    // ------------------------------------------------------------------------------------------------------------

    private class Connection(val socket: Socket, val out: OutputStream) {
        @Volatile var headWritten = false
    }

    private fun acceptLoop() {
        while (!socket.isClosed) {
            val client = try { socket.accept() } catch (_: IOException) { return }
            pool.execute { serve(client) }
        }
    }

    private class Request(val method: String, val target: String, val headers: Map<String, String>, val body: ByteArray)

    private fun serve(client: Socket) {
        try {
            client.soTimeout = 60_000
            val input = BufferedInputStream(client.getInputStream())
            val out = client.getOutputStream()
            val request = readRequest(input)
            if (request == null) { client.close(); return }
            val cookies = request.headers["cookie"].orEmpty()
            val path = request.target.substringBefore('?')

            if (path == "/__nc_open") {
                val query = Uri.parse("http://x" + request.target)
                if (!sameSecret(query.getQueryParameter("t"))) { refuse(out); client.close(); return }
                val to = query.getQueryParameter("to").orEmpty().let { if (it.startsWith("/") && !it.startsWith("//")) it else "/" }
                val head = "HTTP/1.1 302 Found\r\nLocation: $to\r\nSet-Cookie: nc_phone=$token; Path=/; HttpOnly; SameSite=Strict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                out.write(head.toByteArray()); out.flush(); client.close()
                return
            }
            val presented = cookies.split(';').map { it.trim() }.firstOrNull { it.startsWith("nc_phone=") }?.removePrefix("nc_phone=")
            val host = request.headers["host"].orEmpty()
            if (!sameSecret(presented) || !(host.startsWith("127.0.0.1:") || host.startsWith("localhost:"))) { refuse(out); client.close(); return }

            val id = nextId.getAndIncrement()
            connections[id] = Connection(client, out)
            val headers = JSONObject()
            request.headers.forEach { (k, v) -> headers.put(k, v) }
            val script = "NeuroClawServer.request($id, ${JSONObject.quote(request.method)}, ${JSONObject.quote(request.target)}, " +
                "${JSONObject.quote(headers.toString())}, ${JSONObject.quote(Base64.encodeToString(request.body, Base64.NO_WRAP))})"
            Shared.main.post { engine?.evaluateJavascript(script, null) }
            // The answer arrives through Host.call("http.*"), which closes the socket when the response ends.
        } catch (_: Exception) {
            try { client.close() } catch (_: IOException) { }
        }
    }

    private fun sameSecret(presented: String?): Boolean =
        presented != null && MessageDigest.isEqual(presented.toByteArray(), token.toByteArray())

    private fun refuse(out: OutputStream) {
        val body = "Forbidden"
        out.write("HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body".toByteArray())
        out.flush()
    }

    private fun readRequest(input: InputStream): Request? {
        val head = ByteArrayOutputStream()
        var last4 = 0
        while (head.size() < 64 * 1024) {
            val b = input.read()
            if (b < 0) return null
            head.write(b)
            last4 = (last4 shl 8) or b
            if (last4 == 0x0D0A0D0A) break
        }
        val lines = head.toString("ISO-8859-1").split("\r\n")
        val first = lines.firstOrNull()?.split(' ') ?: return null
        if (first.size < 2) return null
        val headers = LinkedHashMap<String, String>()
        for (line in lines.drop(1)) {
            val i = line.indexOf(':')
            if (i > 0) headers[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
        }
        val length = headers["content-length"]?.toIntOrNull() ?: 0
        if (length < 0 || length > 64 * 1024 * 1024) return null
        val body = ByteArray(length)
        var read = 0
        while (read < length) {
            val n = input.read(body, read, length - read)
            if (n < 0) return null
            read += n
        }
        return Request(first[0], first[1], headers, body)
    }

    // ------------------------------------------------------------------------------------------------------------
    // The door the JavaScript uses (mobile/server/src/shims/host.ts).
    // ------------------------------------------------------------------------------------------------------------

    private class HostError(val code: String, message: String) : Exception(message)

    private inner class Host {
        @JavascriptInterface
        fun call(op: String, argsJson: String): String {
            return try {
                val value = dispatch(op, JSONObject(argsJson))
                JSONObject().put("ok", true).put("value", value ?: JSONObject.NULL).toString()
            } catch (e: HostError) {
                JSONObject().put("ok", false).put("code", e.code).put("message", e.message).toString()
            } catch (e: Exception) {
                JSONObject().put("ok", false).put("code", "EIO").put("message", e.message ?: e.javaClass.simpleName).toString()
            }
        }
    }

    private fun dispatch(op: String, a: JSONObject): Any? = when (op) {
        "log" -> { logLine(a.optString("level"), a.optString("message")); null }
        "ready" -> { finish(State.READY, null); null }
        "failed" -> { finish(State.FAILED, a.optString("error")); null }
        "http.head" -> { httpHead(a); null }
        "http.chunk" -> { httpChunk(a); null }
        "http.end" -> { httpEnd(a); null }
        else -> if (op.startsWith("fs.")) fsOp(op, a) else throw HostError("ENOSYS", "unknown host call $op")
    }

    private fun logLine(level: String, message: String) {
        when (level) {
            "error" -> Log.e(TAG, message)
            "warn" -> Log.w(TAG, message)
            else -> Log.i(TAG, message)
        }
    }

    private fun httpHead(a: JSONObject) {
        val c = connections[a.getInt("id")] ?: return
        val status = a.getInt("status")
        val sb = StringBuilder("HTTP/1.1 $status ${a.optString("message").ifEmpty { "OK" }}\r\n")
        val headers = a.optJSONObject("headers") ?: JSONObject()
        for (key in headers.keys()) {
            val lower = key.lowercase()
            if (lower == "connection" || lower == "transfer-encoding") continue
            val v = headers.get(key)
            if (v is org.json.JSONArray) for (i in 0 until v.length()) sb.append(key).append(": ").append(v.getString(i)).append("\r\n")
            else sb.append(key).append(": ").append(v.toString()).append("\r\n")
        }
        // No keep-alive: the end of the body is the end of the connection, so streamed replies need no framing.
        sb.append("Connection: close\r\n\r\n")
        c.out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
        c.out.flush()
        c.headWritten = true
    }

    private fun httpChunk(a: JSONObject) {
        val c = connections[a.getInt("id")] ?: return
        try { c.out.write(Base64.decode(a.getString("data"), Base64.DEFAULT)); c.out.flush() } catch (_: IOException) { connections.remove(a.getInt("id")) }
    }

    private fun httpEnd(a: JSONObject) {
        val c = connections.remove(a.getInt("id")) ?: return
        try { c.out.flush(); c.socket.close() } catch (_: IOException) { }
    }

    // ---- files: /phone/home and /phone/tmp are this app's private storage; /phone/app is the files shipped in the APK ----

    private fun normalize(virtual: String): String {
        val out = ArrayList<String>()
        for (part in virtual.split('/')) {
            when (part) {
                "", "." -> Unit
                ".." -> if (out.isNotEmpty()) out.removeAt(out.size - 1)
                else -> out.add(part)
            }
        }
        return "/" + out.joinToString("/")
    }

    /** The real file for a writable virtual path, or an error for anything outside the app's own storage. */
    private fun storage(virtual: String, write: Boolean): File {
        val v = normalize(virtual)
        if (v == "/phone/app" || v.startsWith("/phone/app/")) {
            if (write) throw HostError("EACCES", "the app's own files are read-only")
            throw HostError("ENOENT", "not in storage")
        }
        return when {
            v == "/phone/home" -> home
            v.startsWith("/phone/home/") -> File(home, v.removePrefix("/phone/home/"))
            v == "/phone/tmp" -> tmp
            v.startsWith("/phone/tmp/") -> File(tmp, v.removePrefix("/phone/tmp/"))
            v == "/phone" || v == "/" -> throw HostError(if (write) "EACCES" else "ENOENT", "no such place")
            else -> throw HostError("ENOENT", "outside the app")
        }
    }

    private fun assetPath(virtual: String): String? {
        val v = normalize(virtual)
        return if (v == "/phone/app") "app" else if (v.startsWith("/phone/app/")) "app/" + v.removePrefix("/phone/app/") else null
    }

    private fun assetIsDir(path: String): Boolean = (appContext.assets.list(path)?.isNotEmpty() == true)

    private fun assetBytes(path: String): ByteArray {
        try {
            return appContext.assets.open(path).use { it.readBytes() }
        } catch (_: IOException) {
            throw HostError(if (assetIsDir(path)) "EISDIR" else "ENOENT", "no such file")
        }
    }

    private fun readAll(virtual: String): ByteArray {
        val asset = assetPath(virtual)
        if (asset != null) return assetBytes(asset)
        val f = storage(virtual, false)
        if (!f.exists()) throw HostError("ENOENT", "no such file")
        if (f.isDirectory) throw HostError("EISDIR", "is a directory")
        return f.readBytes()
    }

    private fun fsOp(op: String, a: JSONObject): Any? {
        val path = a.optString("path")
        when (op) {
            "fs.stat" -> {
                val asset = assetPath(path)
                if (asset != null) {
                    if (assetIsDir(asset) || asset == "app") return JSONObject().put("kind", "dir").put("size", 0).put("mtimeMs", 0)
                    return JSONObject().put("kind", "file").put("size", assetBytes(asset).size).put("mtimeMs", 0)
                }
                val v = normalize(path)
                if (v == "/phone") return JSONObject().put("kind", "dir").put("size", 0).put("mtimeMs", 0)
                val f = storage(path, false)
                if (!f.exists()) throw HostError("ENOENT", "no such file or directory")
                return JSONObject().put("kind", if (f.isDirectory) "dir" else "file").put("size", f.length()).put("mtimeMs", f.lastModified())
            }
            "fs.readdir" -> {
                val out = org.json.JSONArray()
                val asset = assetPath(path)
                if (asset != null) {
                    val names: Array<String> = appContext.assets.list(asset) ?: emptyArray<String>()
                    if (names.isEmpty() && asset != "app") throw HostError(if (appContext.assets.list(asset) == null) "ENOENT" else "ENOTDIR", "not a directory")
                    for (n in names) out.put(JSONObject().put("name", n).put("kind", if (assetIsDir("$asset/$n")) "dir" else "file"))
                    return out
                }
                if (normalize(path) == "/phone") {
                    for (n in listOf("home", "tmp", "app")) out.put(JSONObject().put("name", n).put("kind", "dir"))
                    return out
                }
                val f = storage(path, false)
                if (!f.exists()) throw HostError("ENOENT", "no such directory")
                if (!f.isDirectory) throw HostError("ENOTDIR", "not a directory")
                for (c in f.listFiles() ?: emptyArray()) out.put(JSONObject().put("name", c.name).put("kind", if (c.isDirectory) "dir" else "file"))
                return out
            }
            "fs.read" -> return Base64.encodeToString(readAll(path), Base64.NO_WRAP)
            "fs.readRange" -> {
                val pos = a.getLong("pos")
                val len = a.getInt("len")
                if (assetPath(path) != null) {
                    val all = readAll(path)
                    val from = minOf(pos, all.size.toLong()).toInt()
                    return Base64.encodeToString(all.copyOfRange(from, minOf(all.size, from + len)), Base64.NO_WRAP)
                }
                val f = storage(path, false)
                if (!f.isFile) throw HostError("ENOENT", "no such file")
                RandomAccessFile(f, "r").use { r ->
                    r.seek(pos)
                    val buf = ByteArray(len)
                    val n = r.read(buf)
                    return Base64.encodeToString(if (n <= 0) ByteArray(0) else buf.copyOf(n), Base64.NO_WRAP)
                }
            }
            "fs.write" -> {
                val f = storage(path, true)
                if (f.isDirectory) throw HostError("EISDIR", "is a directory")
                if (f.parentFile?.isDirectory != true) throw HostError("ENOENT", "no such directory")
                java.io.FileOutputStream(f, a.optBoolean("append")).use { it.write(Base64.decode(a.getString("data"), Base64.DEFAULT)) }
                return null
            }
            "fs.writeAt" -> {
                val f = storage(path, true)
                if (!f.isFile) throw HostError("ENOENT", "no such file")
                RandomAccessFile(f, "rw").use { r -> r.seek(a.getLong("pos")); r.write(Base64.decode(a.getString("data"), Base64.DEFAULT)) }
                return null
            }
            "fs.mkdir" -> {
                val f = storage(path, true)
                if (a.optBoolean("recursive")) {
                    if (f.isFile) throw HostError("EEXIST", "file exists")
                    if (!f.isDirectory && !f.mkdirs()) throw HostError("EIO", "could not create the folder")
                } else {
                    if (f.exists()) throw HostError("EEXIST", "file exists")
                    if (f.parentFile?.isDirectory != true) throw HostError("ENOENT", "no such directory")
                    if (!f.mkdir()) throw HostError("EIO", "could not create the folder")
                }
                return null
            }
            "fs.rm" -> {
                val f = storage(path, true)
                val force = a.optBoolean("force")
                if (!f.exists()) { if (force) return null; throw HostError("ENOENT", "no such file or directory") }
                if (f.isDirectory) {
                    if (a.optBoolean("filesOnly")) throw HostError("EISDIR", "is a directory")
                    if (!a.optBoolean("recursive")) {
                        if (!a.optBoolean("dirsOnly")) throw HostError("EISDIR", "is a directory")
                        if ((f.list()?.size ?: 0) > 0) throw HostError("ENOTEMPTY", "directory not empty")
                    }
                    if (!f.deleteRecursively()) throw HostError("EIO", "could not remove it")
                } else {
                    if (a.optBoolean("dirsOnly")) throw HostError("ENOTDIR", "not a directory")
                    if (!f.delete()) throw HostError("EIO", "could not remove it")
                }
                return null
            }
            "fs.rename" -> {
                val from = storage(a.getString("from"), true)
                val to = storage(a.getString("to"), true)
                if (!from.exists()) throw HostError("ENOENT", "no such file or directory")
                if (to.parentFile?.isDirectory != true) throw HostError("ENOENT", "no such directory")
                java.nio.file.Files.move(from.toPath(), to.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING)
                return null
            }
            "fs.copy" -> {
                val to = storage(a.getString("to"), true)
                if (to.parentFile?.isDirectory != true) throw HostError("ENOENT", "no such directory")
                to.writeBytes(readAll(a.getString("from")))
                return null
            }
            "fs.realpath" -> {
                val asset = assetPath(path)
                if (asset != null) { if (asset != "app" && !assetIsDir(asset)) assetBytes(asset); return normalize(path) }
                if (normalize(path) != "/phone" && !storage(path, false).exists()) throw HostError("ENOENT", "no such file or directory")
                return normalize(path)
            }
            "fs.mkdtemp" -> {
                val prefix = a.getString("prefix")
                val random = ByteArray(4).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
                val virtual = normalize(prefix) + random
                val f = storage(virtual, true)
                if (!f.mkdirs()) throw HostError("EIO", "could not create the folder")
                return virtual
            }
        }
        throw HostError("ENOSYS", "unknown host call $op")
    }

    companion object {
        private const val TAG = "NeuroClawServer"
        @Volatile private var instance: PhoneServer? = null

        /** The one server for the whole app (the main screen, the web screen and the bubble all share it). */
        fun get(context: Context): PhoneServer =
            instance ?: synchronized(this) { instance ?: PhoneServer(context).also { instance = it } }
    }
}
