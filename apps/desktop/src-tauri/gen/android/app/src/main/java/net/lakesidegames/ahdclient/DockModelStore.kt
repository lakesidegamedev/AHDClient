package net.lakesidegames.ahdclient

import android.content.Context
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * The last good dock model for the signed-in account, on disk, and the request
 * that refreshes it. Same session cookie, timeouts and size cap as the status
 * request (BriefingWidgets); a model cached for one account is never shown to
 * another because it carries the fingerprint of the session that fetched it.
 */
object DockModelStore {
  private const val MAX_BYTES = 262_144
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

  private fun file(context: Context) = File(context.noBackupFilesDir, "mobile-dock.json")

  fun clear(context: Context) {
    synchronized(lock) { file(context).delete() }
  }

  /** The cached model for this session, or null. */
  fun cached(context: Context): DockModel? = CompanionSafety.get("dock model cache read", null as DockModel?) {
    val identity = BriefingWidgets.identity() ?: return@get null
    val stored = synchronized(lock) { JSONObject(file(context).readText()) }
    if (stored.optString("identity") != identity) return@get null
    DockModel.parse(stored.optJSONObject("model"))
  }

  fun refresh(context: Context): Outcome = CompanionSafety.get("dock model refresh", Outcome.FAILED) { refreshUnsafe(context) }

  private fun refreshUnsafe(context: Context): Outcome {
    val cookie = BriefingWidgets.sessionCookie()
    val identity = BriefingWidgets.identity()
    if (cookie.isEmpty() || identity == null) { clear(context); return Outcome.SIGNED_OUT }
    var connection: HttpURLConnection? = null
    try {
      val active = URL("${BriefingWidgets.ORIGIN}/api/mobile-dock").openConnection() as? HttpURLConnection
        ?: return Outcome.FAILED
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
      if (cookie != BriefingWidgets.sessionCookie()) return Outcome.FAILED
      if (status == 401 || status == 403) { clear(context); return Outcome.SIGNED_OUT }
      if (status == 404 || status == 410 || status == 501) { clear(context); return Outcome.UNAVAILABLE }
      if (status != 200) return Outcome.FAILED
      val body = active.inputStream.use { input ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (true) {
          val size = input.read(buffer)
          if (size < 0) break
          output.write(buffer, 0, size)
          if (output.size() > MAX_BYTES) return Outcome.FAILED
        }
        output.toString("UTF-8")
      }
      if (cookie != BriefingWidgets.sessionCookie()) return Outcome.FAILED
      val raw = JSONObject(body)
      val model = DockModel.parse(raw)
      if (model == null) { clear(context); return Outcome.UNAVAILABLE }
      val previous = synchronized(lock) {
        CompanionSafety.get("dock model previous", null as JSONObject?) {
          JSONObject(file(context).readText()).takeIf { it.optString("identity") == identity }?.optJSONObject("model")
        }
      }
      synchronized(lock) {
        val target = file(context)
        val temporary = File(target.path + ".tmp")
        temporary.writeText(JSONObject().put("identity", identity).put("fetchedAt", System.currentTimeMillis()).put("model", raw).toString())
        if (!temporary.renameTo(target)) temporary.delete()
      }
      return if (previous != null && previous.toString() == raw.toString()) Outcome.UNCHANGED else Outcome.UPDATED
    } finally {
      connection?.let { c -> CompanionSafety.run("dock model connection cleanup") { c.disconnect() } }
    }
  }
}
