package net.lakesidegames.ahdclient

import org.json.JSONObject

/**
 * The rules for telling direct-download players about a newer build, with no Android types so
 * they run on the JVM. The app only ever points the player at the download page; it never
 * downloads or installs anything itself.
 */
object UpdateRules {
  /** The one place the manifest is fetched from. Never taken from anywhere else. */
  const val MANIFEST_URL = "https://ops.lakesidegames.net/downloads/AHDClient-android-latest.json"
  private const val PAGE_HOST = "ops.lakesidegames.net"
  const val CHECK_INTERVAL_MS = 24L * 60 * 60 * 1000
  private const val MAX_NAME = 32
  private const val MAX_PAGE = 200
  private const val PLAY_STORE = "com.android.vending"

  class Release(val versionCode: Long, val versionName: String, val pageUrl: String)

  /** A manifest body as a release, or null when anything about it is off. */
  fun parse(body: String?): Release? {
    if (body.isNullOrBlank() || body.length > 4096) return null
    return try {
      val json = JSONObject(body)
      val code = json.optLong("versionCode", -1L)
      val name = json.optString("versionName", "").trim()
      val page = safePage(json.optString("pageUrl", ""))
      if (code <= 0 || name.isEmpty() || name.length > MAX_NAME || name.any { it.isISOControl() } || page == null) null
      else Release(code, name, page)
    } catch (_: Exception) {
      null
    }
  }

  /** https on the download host only, no credentials or odd port, so a bad manifest cannot send the player elsewhere. */
  fun safePage(value: String?): String? {
    if (value.isNullOrEmpty() || value.length > MAX_PAGE || value.any { it.code > 126 || it.code < 33 }) return null
    val uri = try { java.net.URI(value) } catch (_: Exception) { return null }
    val ok = uri.scheme == "https" && uri.host == PAGE_HOST && uri.port == -1 && uri.userInfo == null
    return value.takeIf { ok }
  }

  fun isNewer(installedCode: Long, release: Release?): Boolean = release != null && release.versionCode > installedCode

  /**
   * Only builds that did not come from Google Play hear about updates: Play looks after its own.
   * An unknown installer (a browser, a file manager, adb) counts as direct.
   */
  fun directInstall(installer: String?): Boolean = installer != PLAY_STORE

  fun due(now: Long, lastCheck: Long): Boolean = lastCheck <= 0 || now < lastCheck || now - lastCheck >= CHECK_INTERVAL_MS

  /** The one-time banner: a newer build exists and the player has not been told about this particular one. */
  fun shouldBanner(newer: Boolean, announcedCode: Long, release: Release?): Boolean =
    newer && release != null && announcedCode < release.versionCode
}
