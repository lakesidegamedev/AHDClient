package net.lakesidegames.briefing

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.atomic.AtomicReference

internal class NativeAskAuthRequired : Exception(T.s(R.string.ask_err_no_account))

/** An error whose message is already player copy in the player's language. */
internal class AskCopyException(message: String) : Exception(message)

/** Callbacks from one answer stream. Called on the network thread. */
internal interface AskStreamListener {
  fun onMeta(reqId: String, conversationID: String, followupsLeft: Int?)
  fun onStatus(label: String)
  fun onAction()
  fun onDelta(text: String)
}

/**
 * Ask's HTTP client. Holds the sign-in cookies it was given plus everything
 * the trusted hosts set during the hand-off. Every call blocks, so it only
 * runs on the session's worker threads, never on the UI thread.
 */
internal class NativeAskApi(initialCookies: Map<String, String>) {
  private val cookies = initialCookies.toMutableMap()
  private val cookieLock = Any()
  private val streamConnection = AtomicReference<HttpURLConnection?>(null)

  // ---- Session ----------------------------------------------------------

  fun connect(): JSONObject {
    try {
      return getJson("/api/me", allowReauth = false)
    } catch (_: NativeAskAuthRequired) {
      reauthenticate()
      return getJson("/api/me", allowReauth = false)
    }
  }

  /**
   * The Ask session expired or was never there: sign in again through the
   * game hand-off, then through Ask's own login. Throws NativeAskAuthRequired
   * when neither produces a session.
   */
  @Synchronized
  private fun reauthenticate() {
    clearAskCookie()
    login(preferGameHandoff = true)
    if (runCatching { getJson("/api/me", allowReauth = false) }.isSuccess) return
    clearAskCookie()
    login(preferGameHandoff = false)
  }

  // ---- Reads and small writes ---------------------------------------------

  fun me(): JSONObject = getJson("/api/me")
  fun conversations(): JSONObject = getJson("/api/conversations")
  fun conversation(id: String): JSONObject = getJson("/api/conversation?id=" + java.net.URLEncoder.encode(id, "UTF-8"))
  fun deleteConversation(id: String): JSONObject = postJson("/api/conversation/delete", JSONObject().put("id", id))
  fun feedback(answerId: Long, rating: String): JSONObject =
    postJson("/api/answer/feedback", JSONObject().put("answerId", answerId).put("rating", rating))
  fun stop(reqId: String) {
    runCatching { postJson("/api/ask/stop", JSONObject().put("reqId", reqId)) }
  }

  /** A share link for the conversation, or a player-facing failure. */
  fun share(id: String): String {
    val result = try {
      postJson("/api/conversation/share", JSONObject().put("id", id))
    } catch (failure: AskHttpException) {
      if (failure.status == 403) throw AskCopyException(T.s(R.string.ask_err_share_private))
      throw failure
    }
    val url = result.optString("url")
    if (!url.startsWith("https://")) throw AskCopyException(T.s(R.string.ask_err_share_later))
    return url
  }

  /** Map SVG for an `ahd-map` block. The service validates the spec and owns the geometry. */
  fun renderMap(spec: String): String {
    val parsed = try { JSONObject(spec) } catch (_: Exception) { throw AskCopyException(T.s(R.string.ask_err_map)) }
    val response = withRetry { request("POST", "/api/map/render", parsed.toString().toByteArray(StandardCharsets.UTF_8),
      "application/json", "image/svg+xml") }
    if (response.code !in 200..299) throw AskCopyException(T.s(R.string.ask_err_map))
    val text = String(response.body, StandardCharsets.UTF_8)
    if (!text.trimStart().startsWith("<svg")) throw AskCopyException(T.s(R.string.ask_err_map))
    return text
  }

  /** Upload a photo. Returns the service URL the question refers to. */
  fun upload(bytes: ByteArray, name: String, mime: String): String {
    val response = authed {
      request("POST", "/api/upload", bytes, mime, "application/json",
        mapOf("X-Filename" to java.net.URLEncoder.encode(name, "UTF-8")), readTimeout = 60_000)
    }
    val json = parseJson(response)
    val url = json.optString("url")
    if (!url.startsWith("/api/uploads/")) throw AskCopyException(T.s(R.string.ask_err_attach))
    return url
  }

  fun removeUpload(url: String) {
    runCatching {
      request("DELETE", "/api/upload", JSONObject().put("url", url).toString().toByteArray(StandardCharsets.UTF_8),
        "application/json", "application/json")
    }
  }

  /** Bytes of an uploaded photo, for thumbnails in a reopened chat. */
  fun uploadBytes(url: String): ByteArray {
    require(url.startsWith("/api/uploads/"))
    val response = withRetry { authed { request("GET", url, null, null, "image/*") } }
    if (response.code !in 200..299) throw AskHttpException(response.code, "", null)
    return response.body
  }

  // ---- Answer stream -----------------------------------------------------

  /**
   * Ask a question and stream the answer. Returns the final `done` payload.
   * Throws AskStreamDropped when the stream ended early: the caller keeps the
   * partial text. Throws AskHttpException for a refusal (quota, length).
   */
  fun ask(
    question: String,
    conversationID: String,
    attachmentUrls: List<String>,
    visualizations: Boolean,
    listener: AskStreamListener
  ): JSONObject {
    val attachments = JSONArray()
    attachmentUrls.forEach { attachments.put(JSONObject().put("url", it)) }
    val body = JSONObject()
      .put("question", question)
      .put("convId", conversationID)
      .put("game", "ahd")
      .put("useMcp", true)
      .put("length", "standard")
      .put("style", "standard")
      .put("effort", "auto")
      .put("visualizations", visualizations)
      .put("mode", "auto")
      .put("tz", TimeZone.getDefault().id)
      .put("attachments", attachments)
      .toString().toByteArray(StandardCharsets.UTF_8)

    var reauthed = false
    while (true) {
      val connection = open(URL("$NATIVE_ASK_ORIGIN/api/ask"), "POST", "text/event-stream", readTimeout = 90_000)
      streamConnection.set(connection)
      try {
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        connection.outputStream.use { it.write(body) }
        val code = connection.responseCode
        captureCookies(connection.url.host, connection)
        if (code == HttpURLConnection.HTTP_UNAUTHORIZED && !reauthed) {
          readBody(connection)
          reauthed = true
          reauthenticate()
          continue
        }
        if (code == HttpURLConnection.HTTP_UNAUTHORIZED) throw NativeAskAuthRequired()
        if (code !in 200..299) throw httpFailure(code, readBody(connection))
        if (!connection.contentType.orEmpty().contains("text/event-stream", ignoreCase = true)) {
          // Cached answers and privacy refusals come back as plain JSON.
          val payload = try { JSONObject(readBody(connection)) } catch (_: Exception) {
            throw AskCopyException(T.s(R.string.ask_err_unreadable_answer))
          }
          if (payload.optString("answer").isBlank()) throw AskCopyException(T.s(R.string.ask_err_empty))
          return payload
        }
        return readStream(connection, listener)
      } finally {
        streamConnection.compareAndSet(connection, null)
        connection.disconnect()
      }
    }
  }

  /** Cut the live stream locally, after Stop or when the sheet is torn down. */
  fun cancelStream() {
    streamConnection.getAndSet(null)?.let { runCatching { it.disconnect() } }
  }

  private fun readStream(connection: HttpURLConnection, listener: AskStreamListener): JSONObject {
    var eventName = "message"
    var eventData = StringBuilder()
    var done: JSONObject? = null
    var receivedAny = false

    fun emit() {
      if (eventData.isEmpty()) { eventName = "message"; return }
      val value = try { JSONTokener(eventData.toString()).nextValue() } catch (_: Exception) { null }
      when (eventName) {
        "meta" -> if (value is JSONObject) {
          listener.onMeta(value.optString("reqId"), value.optString("convId"),
            if (value.has("followupsLeft")) value.optInt("followupsLeft") else null)
        }
        "status" -> if (value is JSONObject) value.optString("label").takeIf { it.isNotBlank() }?.let(listener::onStatus)
        "action" -> listener.onAction()
        "delta" -> {
          val delta = when (value) {
            is String -> value
            is JSONObject -> value.optString("delta")
            else -> ""
          }
          if (delta.isNotEmpty()) listener.onDelta(delta)
        }
        "done" -> if (value is JSONObject) done = value
        "error" -> {
          val message = when (value) {
            is JSONObject -> value.optString("error").ifBlank { value.optString("message") }
            is String -> value
            else -> ""
          }
          throw Exception(askCleanCopy(message).ifBlank { T.s(R.string.ask_err_finish) })
        }
      }
      eventData = StringBuilder()
      eventName = "message"
    }

    try {
      connection.inputStream.bufferedReader(StandardCharsets.UTF_8).use { reader ->
        while (done == null) {
          val line = reader.readLine() ?: break
          receivedAny = true
          when {
            line.isEmpty() -> emit()
            line.startsWith(":") -> Unit
            line.startsWith("event:") -> eventName = line.substring(6).trim()
            line.startsWith("data:") -> {
              if (eventData.isNotEmpty()) eventData.append('\n')
              eventData.append(line.substring(5).trimStart())
            }
          }
        }
        if (done == null) emit()
      }
    } catch (failure: IOException) {
      if (done == null) throw if (receivedAny) AskStreamDropped() else failure
    }
    val result = done ?: throw AskStreamDropped()
    if (result.optString("answer").isBlank()) throw AskCopyException(T.s(R.string.ask_err_empty))
    return result
  }

  // ---- Transport ---------------------------------------------------------

  private class Response(val code: Int, val body: ByteArray, val contentType: String)

  private fun getJson(path: String, allowReauth: Boolean = true): JSONObject {
    val run = { parseJson(withRetry { request("GET", path, null, null, "application/json") }) }
    return if (allowReauth) authedJson(run) else run()
  }

  private fun postJson(path: String, body: JSONObject): JSONObject = authedJson {
    parseJson(request("POST", path, body.toString().toByteArray(StandardCharsets.UTF_8), "application/json", "application/json"))
  }

  /** A 401 mid-session signs in again once, then repeats the call. */
  private fun authedJson(block: () -> JSONObject): JSONObject = try {
    block()
  } catch (_: NativeAskAuthRequired) {
    reauthenticate()
    block()
  }

  private fun authed(block: () -> Response): Response {
    val first = block()
    if (first.code != HttpURLConnection.HTTP_UNAUTHORIZED) return first
    reauthenticate()
    return block()
  }

  /** Reads retry twice with backoff on drops and gateway errors. */
  private fun withRetry(block: () -> Response): Response {
    var delay = 600L
    var attempt = 0
    while (true) {
      try {
        val response = block()
        if (attempt < 2 && response.code in setOf(408, 502, 503, 504)) {
          attempt++
          Thread.sleep(delay)
          delay *= 3
          continue
        }
        return response
      } catch (failure: Exception) {
        if (failure is NativeAskAuthRequired || attempt >= 2 || !askTransient(failure)) throw failure
        attempt++
        Thread.sleep(delay)
        delay *= 3
      }
    }
  }

  private fun parseJson(response: Response): JSONObject {
    val text = String(response.body, StandardCharsets.UTF_8)
    if (response.code == HttpURLConnection.HTTP_UNAUTHORIZED) throw NativeAskAuthRequired()
    if (response.code !in 200..299) throw httpFailure(response.code, text)
    return try { JSONObject(text) } catch (_: Exception) { throw AskCopyException(T.s(R.string.ask_err_unreadable_reply)) }
  }

  private fun httpFailure(code: Int, text: String): AskHttpException {
    val json = try { JSONObject(text) } catch (_: Exception) { null }
    val message = json?.optString("error").orEmpty().takeIf { it != "null" }.orEmpty()
    return AskHttpException(code, message, AskUsage.from(json))
  }

  private fun request(
    method: String,
    path: String,
    body: ByteArray?,
    contentType: String?,
    accept: String,
    headers: Map<String, String> = emptyMap(),
    readTimeout: Int = 30_000
  ): Response {
    val connection = open(URL("$NATIVE_ASK_ORIGIN$path"), method, accept, readTimeout)
    try {
      headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
      if (body != null) {
        connection.doOutput = true
        contentType?.let { connection.setRequestProperty("Content-Type", it) }
        connection.setFixedLengthStreamingMode(body.size)
        connection.outputStream.use { it.write(body) }
      }
      val code = connection.responseCode
      val bytes = readBytes(connection)
      return Response(code, bytes, connection.contentType.orEmpty())
    } finally {
      captureCookies(connection.url.host, connection)
      connection.disconnect()
    }
  }

  private fun login(preferGameHandoff: Boolean) {
    if (preferGameHandoff && runCatching { tryLogin(URL(NATIVE_AHD_LOGIN)) }.getOrDefault(false)) return
    if (runCatching { tryLogin(URL(NATIVE_ASK_LOGIN)) }.getOrDefault(false)) return
    throw NativeAskAuthRequired()
  }

  private fun tryLogin(start: URL): Boolean {
    var current = start
    repeat(NATIVE_ASK_MAX_REDIRECTS) {
      requireAllowed(current)
      val connection = open(current, "GET", "text/html")
      try {
        val code = connection.responseCode
        captureCookies(current.host, connection)
        if (code in 300..399) {
          val location = connection.getHeaderField("Location") ?: throw NativeAskAuthRequired()
          current = URL(current, location)
          return@repeat
        }
        if (code in 200..299) return hasAskCookie()
        return false
      } finally {
        connection.disconnect()
      }
    }
    return false
  }

  private fun open(url: URL, method: String, accept: String, readTimeout: Int = 30_000): HttpURLConnection {
    requireAllowed(url)
    val connection = url.openConnection() as HttpURLConnection
    connection.requestMethod = method
    connection.instanceFollowRedirects = false
    connection.connectTimeout = 15_000
    connection.readTimeout = readTimeout
    connection.useCaches = false
    connection.setRequestProperty("Accept", accept)
    connection.setRequestProperty("Origin", NATIVE_ASK_ORIGIN)
    connection.setRequestProperty("Referer", "$NATIVE_ASK_ORIGIN/")
    synchronized(cookieLock) { cookies[url.host] }?.takeIf { it.isNotBlank() }?.let { connection.setRequestProperty("Cookie", it) }
    return connection
  }

  private fun requireAllowed(url: URL) {
    check(url.protocol == "https" && url.port.let { it == -1 || it == 443 } && nativeAskAllowedHosts.contains(url.host.lowercase(Locale.US))) {
      throw NativeAskAuthRequired()
    }
  }

  private fun captureCookies(host: String, connection: HttpURLConnection) {
    val headerValues = try {
      connection.headerFields.entries
        .filter { it.key?.equals("Set-Cookie", ignoreCase = true) == true }
        .flatMap { it.value ?: emptyList() }
    } catch (_: Exception) { emptyList() }
    if (headerValues.isEmpty()) return
    synchronized(cookieLock) {
      val current = cookies[host].orEmpty().split(';').map { it.trim() }
        .filter { it.contains('=') }.associateBy { it.substringBefore('=') }.toMutableMap()
      // Every cookie a trusted host sets during the sign-in hand-off is kept for
      // that host: the issuer's redirects need their own flow cookies, not only
      // the final sessions. Stored as name=value. Storing the bare value lost
      // every session the hand-off created, so Ask asked to link again forever
      // after a successful link (ticket 1467).
      for (header in headerValues) {
        val pair = header.substringBefore(';').trim()
        val name = pair.substringBefore('=').trim()
        if (name.isBlank() || !pair.contains('=')) continue
        if (pair.substringAfter('=').isBlank() || header.contains("Max-Age=0", ignoreCase = true) || header.contains("Expires=Thu, 01 Jan 1970", ignoreCase = true)) current.remove(name)
        else current[name] = pair
      }
      cookies[host] = current.values.joinToString("; ")
    }
  }

  private fun clearAskCookie() {
    synchronized(cookieLock) {
      cookies["ask.lakesidegames.net"] = cookies["ask.lakesidegames.net"].orEmpty().split(';')
        .map { it.trim() }.filter {
          val name = it.substringBefore('=')
          name != "ask_session" && name != "__Host-ask_session" && name != "__Host-ask_login" &&
            name != "__Host-lakeside_login" && name != "__Host-lakeside_session"
        }
        .filter { it.isNotBlank() }.joinToString("; ")
    }
  }

  private fun hasAskCookie(): Boolean = synchronized(cookieLock) { cookies["ask.lakesidegames.net"].orEmpty() }.split(';')
    .map { it.trim().substringBefore('=') }.any {
      it == "ask_session" || it == "__Host-ask_session" || it == "__Host-lakeside_session"
    }

  private fun readBody(connection: HttpURLConnection): String = String(readBytes(connection), StandardCharsets.UTF_8)

  private fun readBytes(connection: HttpURLConnection): ByteArray {
    val stream: InputStream = try { connection.inputStream } catch (_: Exception) { connection.errorStream ?: return ByteArray(0) }
    return stream.use { input ->
      val out = ByteArrayOutputStream()
      val buffer = ByteArray(16 * 1024)
      var total = 0
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        total += read
        // Nothing Ask sends to this app is larger than an uploaded photo.
        if (total > 12 * 1024 * 1024) throw IOException("reply too large")
        out.write(buffer, 0, read)
      }
      out.toByteArray()
    }
  }
}
