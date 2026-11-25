package com.example.engine

import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

fun normalizeServerUrl(raw: String): String {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return ""
    val withScheme = if (trimmed.contains("://")) trimmed else "http://$trimmed"
    return withScheme.trimEnd('/')
}

/**
 * Sync client talking to a NeuroClaw desktop/server backend:
 *   POST /api/phone-sync  (exchanges unsynced turns, yes/no teach examples, and newer OneBrain)
 *   POST /api/captures    (uploads local training photos with notes)
 */
class SyncClient {
    class ServerError(val status: Int, message: String) : IOException(message)

    suspend fun sync(
        serverUrl: String,
        password: String,
        turnsJson: JSONArray,
        teachJson: JSONArray,
        oneBrainVersion: Long
    ): JSONObject = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("turns", turnsJson)
            .put("teach", teachJson)
            .put("oneBrainVersion", oneBrainVersion)
        postJson(serverUrl, password, "/api/phone-sync", body)
    }

    suspend fun uploadCapture(
        serverUrl: String,
        password: String,
        jpegBytes: ByteArray,
        note: String,
        capturedAtMs: Long
    ) = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("image", Base64.encodeToString(jpegBytes, Base64.NO_WRAP))
            .put("mime", "image/jpeg")
            .put("note", note)
            .put("capturedAt", capturedAtMs)
        postJson(serverUrl, password, "/api/captures", body)
    }

    private fun postJson(
        serverUrl: String,
        password: String,
        path: String,
        payload: JSONObject
    ): JSONObject {
        val normalized = normalizeServerUrl(serverUrl)
        if (normalized.isEmpty()) throw IOException("No PC address set")
        val conn = (URL(normalized + path).openConnection() as HttpURLConnection)
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 4_000
            conn.readTimeout = 30_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            if (password.isNotEmpty()) {
                val token = Base64.encodeToString("neuroclaw:$password".toByteArray(), Base64.NO_WRAP)
                conn.setRequestProperty("Authorization", "Basic $token")
            }
            conn.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            if (code !in 200..299) {
                val msg = runCatching { JSONObject(text).optString("error") }.getOrNull()
                throw ServerError(
                    code,
                    when {
                        code == 401 -> "Wrong Remote Access password for the PC"
                        !msg.isNullOrBlank() -> msg
                        else -> "PC answered HTTP $code"
                    }
                )
            }
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        } finally {
            conn.disconnect()
        }
    }
}
