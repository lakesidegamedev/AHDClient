package net.lakesidegames.ahdclient

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.appcompat.app.AlertDialog
import java.net.HttpURLConnection
import java.net.URL

/**
 * Direct-download players hear about a newer build: a daily check of a tiny manifest, a row in
 * More and a one-time notice that opens the download page in the browser. Nothing is downloaded
 * or installed by the app, and Play installs never see any of it.
 */
object AppUpdate {
  private const val PREFS = "ahd-update"
  private const val LAST_CHECK = "lastCheck"
  private const val CODE = "code"
  private const val NAME = "name"
  private const val PAGE = "page"
  private const val ANNOUNCED = "announced"
  private const val MAX_BYTES = 4096

  @Volatile private var running = false

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun installedCode(context: Context): Long = try {
    val info = context.packageManager.getPackageInfo(context.packageName, 0)
    if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
  } catch (_: Exception) { Long.MAX_VALUE }

  @Suppress("DEPRECATION")
  private fun installer(context: Context): String? = try {
    if (Build.VERSION.SDK_INT >= 30) context.packageManager.getInstallSourceInfo(context.packageName).installingPackageName
    else context.packageManager.getInstallerPackageName(context.packageName)
  } catch (_: Exception) { null }

  private fun stored(context: Context): UpdateRules.Release? {
    val p = prefs(context)
    val code = p.getLong(CODE, 0L)
    val name = p.getString(NAME, null)
    val page = UpdateRules.safePage(p.getString(PAGE, null))
    return if (code > 0 && !name.isNullOrEmpty() && page != null) UpdateRules.Release(code, name, page) else null
  }

  /** The newer build the player can get, or null (up to date, Play install, or nothing known yet). */
  fun available(context: Context): UpdateRules.Release? {
    if (!UpdateRules.directInstall(installer(context))) return null
    return stored(context)?.takeIf { UpdateRules.isNewer(installedCode(context), it) }
  }

  /** On resume. Fetches at most once a day, off the UI thread, then offers the one-time notice. */
  fun checkIfDue(activity: MainActivity) {
    val context = activity.applicationContext
    if (!UpdateRules.directInstall(installer(context))) return
    if (running) { announce(activity); return }
    val now = System.currentTimeMillis()
    if (!UpdateRules.due(now, prefs(context).getLong(LAST_CHECK, 0L))) { announce(activity); return }
    running = true
    Thread {
      try {
        val release = CompanionSafety.get("update check", null as UpdateRules.Release?) { fetch() }
        // A failed fetch still counts as a check, so an unreachable host is tried once a day, not every resume.
        val edit = prefs(context).edit().putLong(LAST_CHECK, now)
        if (release != null) edit.putLong(CODE, release.versionCode).putString(NAME, release.versionName).putString(PAGE, release.pageUrl)
        edit.apply()
      } finally {
        running = false
      }
      activity.runOnUiThread { CompanionSafety.run("update notice") { announce(activity) } }
    }.start()
  }

  private fun fetch(): UpdateRules.Release? {
    val connection = URL(UpdateRules.MANIFEST_URL).openConnection() as HttpURLConnection
    return try {
      connection.connectTimeout = 8000
      connection.readTimeout = 8000
      connection.instanceFollowRedirects = false
      if (connection.responseCode != 200) return null
      val bytes = connection.inputStream.use { it.readNBytesCapped(MAX_BYTES) } ?: return null
      UpdateRules.parse(String(bytes, Charsets.UTF_8))
    } finally {
      connection.disconnect()
    }
  }

  private fun java.io.InputStream.readNBytesCapped(limit: Int): ByteArray? {
    val out = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(1024)
    while (true) {
      val read = read(buffer)
      if (read < 0) break
      out.write(buffer, 0, read)
      if (out.size() > limit) return null
    }
    return out.toByteArray()
  }

  /** Shows the notice once per new version. Main thread only. */
  private fun announce(activity: MainActivity) {
    if (activity.isFinishing || activity.isDestroyed) return
    val release = available(activity)
    val p = prefs(activity)
    if (!UpdateRules.shouldBanner(release != null, p.getLong(ANNOUNCED, 0L), release)) return
    release ?: return
    p.edit().putLong(ANNOUNCED, release.versionCode).apply()
    AlertDialog.Builder(activity)
      .setTitle(Texts.s(R.string.update_title, release.versionName))
      .setMessage(Texts.s(R.string.update_body))
      .setPositiveButton(Texts.s(R.string.update_download)) { _, _ -> openPage(activity, release) }
      .setNegativeButton(Texts.s(R.string.update_later), null)
      .show()
  }

  /** The browser, on the fixed download page. The address is checked again at the last step. */
  fun openPage(activity: Activity, release: UpdateRules.Release) {
    val page = UpdateRules.safePage(release.pageUrl) ?: return
    try {
      activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(page)).addCategory(Intent.CATEGORY_BROWSABLE))
    } catch (_: ActivityNotFoundException) {
      // No browser on the phone: nothing to open.
    }
  }
}
