package net.lakesidegames.ahdclient

import android.content.Context
import android.webkit.CookieManager
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * The last good dock models for the signed-in account, on disk, and the
 * request that refreshes one. Same session cookie, timeouts and size cap as the
 * status request (BriefingWidgets); the file carries the fingerprint of the
 * session that fetched it, so one account's models are never shown to another,
 * and holds one entry per (language, country) the player has looked at.
 * The game picks the language from the `ahd-locale` cookie only, so that
 * cookie (not a secret) travels with the session cookie.
 */
object DockModelStore {
  private const val MAX_BYTES = 262_144
  private const val MAX_ENTRIES = 6
  private val lock = Any()

  enum class Outcome {
    /** A new model was stored. */
    UPDATED,

    /** The game answered with the same model. */
    UNCHANGED,

    /** Signed out, or the game refused the session. The cache was cleared. */
    SIGNED_OUT,

    /** The game does not serve a usable model (older game). The cache was cleared. */
    UNAVAILABLE,

    /** Offline or a server error. The cache is kept. */
    FAILED,
  }

  /** What a refresh produced: the outcome and, when the game answered, the parsed model (no second disk read). */
  class Fetched(val outcome: Outcome, val model: DockModel? = null)

  private fun file(context: Context) = File(context.noBackupFilesDir, "mobile-dock.json")

  fun clear(context: Context) {
    synchronized(lock) { file(context).delete() }
  }

  /** The language the game page is in, from the WebView's cookies; null when the player never chose one. */
  fun locale(): String? = CompanionSafety.get("dock locale", null as String?) {
    DockRouting.localeFrom(CookieManager.getInstance().getCookie(BriefingWidgets.ORIGIN))
  }

  /** Every cached model for this session, by [DockKey.sub]. Reads and parses the file: call off the UI thread. */
  fun cachedAll(context: Context, identity: String): Map<String, DockModel> =
    CompanionSafety.get("dock model cache read", emptyMap()) {
      val stored = readStored(context)?.takeIf { it.optString("identity") == identity } ?: return@get emptyMap()
      val entries = stored.optJSONObject("entries") ?: return@get emptyMap()
      val models = LinkedHashMap<String, DockModel>()
      for (key in entries.keys()) {
        DockModel.parse(entries.optJSONObject(key)?.optJSONObject("model"))?.let { models[key] = it }
      }
      models
    }

  private fun readStored(context: Context): JSONObject? = synchronized(lock) {
    val target = file(context)
    if (!target.exists()) null else JSONObject(target.readText())
  }

  fun refresh(context: Context, key: DockKey): Fetched =
    CompanionSafety.get("dock model refresh", Fetched(Outcome.FAILED)) { refreshUnsafe(context, key) }

  private fun refreshUnsafe(context: Context, key: DockKey): Fetched {
    val session = BriefingWidgets.sessionCookie()
    if (session.isEmpty()) { clear(context); return Fetched(Outcome.SIGNED_OUT) }
    // Another account signed in since this request was queued: it is not this request's to answer.
    if (BriefingWidgets.identity() != key.identity) return Fetched(Outcome.FAILED)
    val cookie = if (key.locale != null) "$session; ${DockRouting.LOCALE_COOKIE}=${key.locale}" else session
    var connection: HttpURLConnection? = null
    try {
      val query = key.country?.let { "?country=$it" } ?: ""
      val active = URL("${BriefingWidgets.ORIGIN}/api/mobile-dock$query").openConnection() as? HttpURLConnection
        ?: return Fetched(Outcome.FAILED)
      connection = active
      active.connectTimeout = 6000
      active.readTimeout = 6000
      active.instanceFollowRedirects = false
      active.useCaches = false
      active.setRequestProperty("Cookie", cookie)
      active.setRequestProperty("Accept", "application/json")
      active.setRequestProperty("X-AHD-Client-Version", BuildConfig.VERSION_NAME)
      active.setRequestProperty("Cache-Control", "no-cache")
      val status = active.responseCode
      // The player signed out or switched while the request was out: say nothing about the new session.
      if (BriefingWidgets.identity() != key.identity) return Fetched(Outcome.FAILED)
      if (status == 401 || status == 403) { clear(context); return Fetched(Outcome.SIGNED_OUT) }
      // A country the game does not know is not "an older game": only the home request decides that.
      if (status == 404 || status == 410 || status == 501) {
        if (key.country != null) return Fetched(Outcome.FAILED)
        clear(context)
        return Fetched(Outcome.UNAVAILABLE)
      }
      if (status != 200) return Fetched(Outcome.FAILED)
      val body = active.inputStream.use { input ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (true) {
          val size = input.read(buffer)
          if (size < 0) break
          output.write(buffer, 0, size)
          if (output.size() > MAX_BYTES) return Fetched(Outcome.FAILED)
        }
        output.toString("UTF-8")
      }
      if (BriefingWidgets.identity() != key.identity) return Fetched(Outcome.FAILED)
      val raw = JSONObject(body)
      val model = DockModel.parse(raw)
      if (model == null) {
        if (key.country != null) return Fetched(Outcome.FAILED)
        clear(context)
        return Fetched(Outcome.UNAVAILABLE)
      }
      return Fetched(store(context, key, raw), model)
    } finally {
      connection?.let { c -> CompanionSafety.run("dock model connection cleanup") { c.disconnect() } }
    }
  }

  /** Writes one entry into the account's file and says whether it differs from what was there. */
  private fun store(context: Context, key: DockKey, raw: JSONObject): Outcome = synchronized(lock) {
    val stored = CompanionSafety.get("dock model previous", null as JSONObject?) { readStored(context) }
      ?.takeIf { it.optString("identity") == key.identity }
    val entries = stored?.optJSONObject("entries") ?: JSONObject()
    val previous = entries.optJSONObject(key.sub)?.optJSONObject("model")
    entries.put(key.sub, JSONObject().put("fetchedAt", System.currentTimeMillis()).put("model", raw))
    // Keep the newest few; a player browsing many countries does not grow the file without bound.
    while (entries.length() > MAX_ENTRIES) {
      val oldest = entries.keys().asSequence().filter { it != key.sub }.minByOrNull { entries.optJSONObject(it)?.optLong("fetchedAt", 0L) ?: 0L } ?: break
      entries.remove(oldest)
    }
    val target = file(context)
    val temporary = File(target.path + ".tmp")
    temporary.writeText(JSONObject().put("identity", key.identity).put("entries", entries).toString())
    if (!temporary.renameTo(target)) temporary.delete()
    if (previous != null && previous.toString() == raw.toString()) Outcome.UNCHANGED else Outcome.UPDATED
  }
}
