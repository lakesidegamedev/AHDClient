package net.lakesidegames.briefing

import android.graphics.Bitmap
import org.json.JSONArray
import org.json.JSONObject
import java.io.FileNotFoundException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.Locale
import javax.net.ssl.SSLException

/** Daily allowance from /api/me, a conversation list, an answer or a 429. */
internal data class AskUsage(
  val used: Double,
  val limit: Double,
  val remaining: Double,
  val liveRemaining: Double,
  val liveLimit: Double,
  val vizRemaining: Double,
  val vizLimit: Double,
  val resetAt: Long,
  val tier: String?
) {
  val outOfQuestions: Boolean get() = limit > 0 && remaining < 0.5

  companion object {
    fun from(value: JSONObject?): AskUsage? {
      val usage = value?.optJSONObject("usage") ?: return null
      if (!usage.has("used") || !usage.has("limit") || !usage.has("remaining")) return null
      return AskUsage(
        used = usage.optDouble("used", 0.0),
        limit = usage.optDouble("limit", 0.0),
        remaining = usage.optDouble("remaining", 0.0),
        liveRemaining = usage.optDouble("mcpRemaining", 0.0),
        liveLimit = usage.optDouble("mcpLimit", 0.0),
        vizRemaining = usage.optDouble("vizRemaining", 0.0),
        vizLimit = usage.optDouble("vizLimit", 0.0),
        resetAt = usage.optLong("resetAt", 0L),
        tier = usage.optString("tier").takeIf { it.isNotBlank() && it != "null" }
      )
    }
  }
}

/** "7" or "6.5": half questions exist for follow-ups. */
internal fun askCount(value: Double): String =
  if (value == Math.floor(value)) value.toLong().toString() else String.format(Locale.US, "%.1f", value)

/** "3h 20m" or "45m" until the allowance resets. */
internal fun askResetIn(resetAt: Long, now: Long = System.currentTimeMillis()): String {
  val minutes = Math.max(0L, Math.round((resetAt - now) / 60000.0))
  return if (minutes >= 60) T.s(R.string.ask_reset_hm, (minutes / 60).toInt(), (minutes % 60).toInt()) else T.s(R.string.ask_reset_m, minutes.toInt())
}

internal data class AskCitation(val label: String, val url: String?)

internal data class AskConversationSummary(
  val id: String,
  val title: String,
  val updated: Long,
  val pinned: Boolean
) {
  companion object {
    fun list(value: JSONObject?): List<AskConversationSummary> {
      val list = value?.optJSONArray("conversations") ?: return emptyList()
      val out = mutableListOf<AskConversationSummary>()
      for (index in 0 until list.length()) {
        val item = list.optJSONObject(index) ?: continue
        val id = item.optString("id")
        if (id.isBlank()) continue
        out += AskConversationSummary(
          id = id,
          title = item.optString("title").takeIf { it.isNotBlank() && it != "null" } ?: T.s(R.string.ask_untitled),
          updated = item.optLong("updated", item.optLong("created", 0L)),
          pinned = item.optInt("pinned", 0) == 1 || item.optBoolean("pinned", false)
        )
      }
      return out
    }
  }
}

/** A photo on its way to, or already on, the Ask service. */
internal class AskAttachment(val localId: Long, val name: String) {
  @Volatile var url: String? = null
  @Volatile var thumbnail: Bitmap? = null
  @Volatile var uploading = true
  @Volatile var error: String? = null
}

internal enum class AskMessageState { PENDING, STREAMING, DONE, FAILED, STOPPED, DROPPED }

/** One question and its answer, as the thread shows it. */
internal class AskMessage(val localId: Long, val question: String, val attachmentUrls: List<String>) {
  var answer = ""
  var state = AskMessageState.PENDING
  var status: String? = null
  var checks = 0
  var error: String? = null
  var answerId: Long = 0
  var model = ""
  var citations: List<AskCitation> = emptyList()
  var liveSources: List<String> = emptyList()
  var followups: List<String> = emptyList()
  var feedback: String? = null
  var vizBlocked = false
  var cached = false
  var reportUrl: String? = null
  /** Bumped on every change so the thread can skip redundant redraws. */
  var revision = 0
  /** Last revision whose markdown was rendered. */
  var renderedRevision = -1

  val busy: Boolean get() = state == AskMessageState.PENDING || state == AskMessageState.STREAMING

  fun applyDone(value: JSONObject) {
    answer = value.optString("answer", answer)
    answerId = value.optLong("answerId", answerId)
    model = askModelLabel(value, model)
    citations = askCitations(value.optJSONArray("citations"))
    liveSources = askLiveSources(value.optJSONArray("liveSources"))
    followups = askStrings(value.optJSONArray("followups")).take(4)
    vizBlocked = value.optBoolean("vizBlocked", false)
    cached = value.optBoolean("cached", false)
    reportUrl = value.optString("reportUrl").takeIf { it.isNotBlank() && it != "null" }
    status = null
    error = null
    state = AskMessageState.DONE
    revision++
  }

  companion object {
    /** A saved turn from /api/conversation. */
    fun fromTurn(localId: Long, turn: JSONObject): AskMessage? {
      val question = turn.optString("question")
      if (question.isBlank()) return null
      val urls = mutableListOf<String>()
      turn.optJSONArray("attachments")?.let { list ->
        for (index in 0 until list.length()) {
          val item = list.optJSONObject(index) ?: continue
          val url = item.optString("url")
          val mime = item.optString("mimeType")
          if (url.startsWith("/api/uploads/") && mime.startsWith("image/")) urls += url
        }
      }
      return AskMessage(localId, question, urls).apply {
        answer = turn.optString("answer")
        answerId = turn.optLong("id", 0L)
        model = askModelLabel(turn, "")
        citations = askCitations(turn.optJSONArray("citations"))
        feedback = turn.optString("feedback_rating").takeIf { it == "up" || it == "down" }
        cached = turn.optInt("cached", 0) == 1
        state = if (answer.isBlank()) AskMessageState.FAILED else AskMessageState.DONE
        if (answer.isBlank()) error = T.s(R.string.ask_err_not_saved)
      }
    }
  }
}

/** "Model · Service" so every answer names who wrote it. */
internal fun askModelLabel(value: JSONObject, fallback: String): String {
  val model = value.optString("modelName").ifBlank { value.optString("model") }.ifBlank { fallback }
    .takeIf { it != "null" }.orEmpty()
  val provider = value.optString("providerName").takeIf { it != "null" }.orEmpty()
  return if (provider.isNotBlank() && provider != model && model.isNotBlank()) "$model · $provider" else model
}

internal fun askStrings(list: JSONArray?): List<String> {
  if (list == null) return emptyList()
  val out = mutableListOf<String>()
  for (index in 0 until list.length()) {
    val text = list.optString(index).trim()
    if (text.isNotEmpty() && text != "null") out += text
  }
  return out
}

internal fun askCitations(list: JSONArray?): List<AskCitation> {
  if (list == null) return emptyList()
  val out = mutableListOf<AskCitation>()
  for (index in 0 until list.length()) {
    val item = list.optJSONObject(index) ?: continue
    val label = item.optString("label").ifBlank { item.optString("path") }.trim()
    val url = item.optString("url").takeIf { it.startsWith("https://") }
    if (label.isNotEmpty()) out += AskCitation(label, url)
  }
  return out.distinctBy { it.label }
}

/** The server sends `{ label }` objects; older builds sent strings. */
internal fun askLiveSources(list: JSONArray?): List<String> {
  if (list == null) return emptyList()
  val out = mutableListOf<String>()
  for (index in 0 until list.length()) {
    val label = list.optJSONObject(index)?.optString("label") ?: list.optString(index)
    if (!label.isNullOrBlank() && !label.startsWith("{")) out += label.trim()
  }
  return out.distinct()
}

/** A non-2xx reply, carrying the allowance a 429 includes. */
internal class AskHttpException(val status: Int, message: String, val usage: AskUsage?) : Exception(message)

/** The answer stream ended before its final event. The partial text is kept. */
internal class AskStreamDropped : Exception(T.s(R.string.ask_err_dropped))

/**
 * Server copy is written for the web page; keep it but drop dashes the app's
 * own copy never uses, so a quota message reads like the rest of the sheet.
 */
internal fun askCleanCopy(text: String): String {
  var out = text.trim()
  val dash = Regex("\\s*[\\u2014\\u2013]\\s*(\\S)")
  out = dash.replace(out) { match -> ". " + match.groupValues[1].uppercase(Locale.US) }
  return out
}

/** Plain words for a failure. Never an HTTP code or an exception name. */
internal fun askPlayerMessage(error: Throwable?): String {
  return when (error) {
    null -> T.s(R.string.ask_err_generic)
    is AskHttpException -> when {
      error.status == 429 -> askCleanCopy(error.message.orEmpty()).ifBlank { T.s(R.string.ask_err_quota) }
      error.status >= 500 -> T.s(R.string.ask_err_server)
      error.status == 404 -> T.s(R.string.ask_err_chat_gone)
      else -> askCleanCopy(error.message.orEmpty()).ifBlank { T.s(R.string.ask_err_generic) }
    }
    is AskStreamDropped -> error.message.orEmpty()
    is UnknownHostException, is ConnectException -> T.s(R.string.ask_err_offline)
    is SocketTimeoutException -> T.s(R.string.ask_err_slow)
    is SSLException -> T.s(R.string.ask_err_ssl)
    is InterruptedIOException -> T.s(R.string.ask_err_slow)
    is FileNotFoundException -> T.s(R.string.ask_err_chat_gone)
    is java.io.IOException -> T.s(R.string.ask_err_interrupted)
    // Our own exceptions carry player copy in the player's language; anything else gets the generic line.
    is AskCopyException -> askCleanCopy(error.message.orEmpty())
    else -> T.s(R.string.ask_err_generic)
  }
}

/** True for failures worth retrying for a read: drops, timeouts and gateway errors. */
internal fun askTransient(error: Throwable): Boolean = when (error) {
  is AskHttpException -> error.status == 502 || error.status == 503 || error.status == 504 || error.status == 408
  is UnknownHostException -> false
  is java.io.IOException -> true
  else -> false
}
