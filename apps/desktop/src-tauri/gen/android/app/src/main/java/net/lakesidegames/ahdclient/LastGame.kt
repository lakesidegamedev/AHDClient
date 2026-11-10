package net.lakesidegames.ahdclient

import android.content.Context
import java.io.File
import org.json.JSONObject

/**
 * The last live game page the player read and the session that read it, so a
 * signed-in launch opens back there (the shared Rust side reads the file; see
 * launch.rs). Path and query only, never a host. The decisions are pure so
 * they run on the JVM; the file work is small and runs off the UI thread.
 */
object LastGame {
  private const val FILE = "last-game.json"
  private const val MAX_PATH_BYTES = 300
  private val LIVE_HOSTS = setOf("ahousedividedgame.com", "www.ahousedividedgame.com")
  private val NEVER = setOf("login", "register", "logout", "signin", "signout", "auth", "api", "client")

  /**
   * The path and query worth saving for a page address, or null. Only the live
   * site qualifies (not the sandbox, the launcher or another host), and never a
   * sign-in or sign-out page, an API route or anything the Rust restore would
   * refuse, so what is saved is always restorable.
   */
  fun pathToSave(url: String?): String? {
    if (url.isNullOrEmpty() || !url.startsWith("https://")) return null
    val rest = url.removePrefix("https://").substringBefore('#')
    val host = rest.substringBefore('/').lowercase()
    if (host !in LIVE_HOSTS || !rest.contains('/')) return null
    val path = "/" + rest.substringAfter('/')
    return path.takeIf { safe(it) }
  }

  internal fun safe(path: String): Boolean {
    if (path.toByteArray().size > MAX_PATH_BYTES || !path.startsWith("/") || path.startsWith("//")) return false
    if (path.contains('\\') || path.any { it.isWhitespace() || it.isISOControl() }) return false
    val first = path.substringBefore('?').trimStart('/').substringBefore('/')
    return first !in NEVER
  }

  /** The file body, in the shape launch.rs reads. */
  fun encode(path: String, account: String): String =
    JSONObject().put("path", path).put("account", account).toString()

  private fun file(context: Context) = File(context.dataDir, "${context.packageName}/$FILE")

  /** Saves the page for this session. Unchanged content is not rewritten. Worker thread only. */
  fun save(context: Context, path: String, account: String) {
    val target = file(context)
    val body = encode(path, account)
    if (runCatching { target.readText() }.getOrNull() == body) return
    target.parentFile?.mkdirs()
    val temporary = File(target.path + ".tmp")
    temporary.writeText(body)
    if (!temporary.renameTo(target)) temporary.delete()
  }

  /** Forgets the saved page, as on sign-out. Worker thread only. */
  fun clear(context: Context) {
    file(context).delete()
  }
}
