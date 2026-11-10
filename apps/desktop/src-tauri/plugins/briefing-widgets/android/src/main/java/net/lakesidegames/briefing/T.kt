package net.lakesidegames.briefing

import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
import android.webkit.CookieManager
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * The plugin's own words, in the game's language. The language comes from the game's `ahd-locale`
 * cookie, the same as the app's dock; with no cookie the phone's (or per-app) language decides, and
 * a language the app has no words for is English.
 */
internal object T {
  private val SUPPORTED = setOf("en", "de")
  private const val COOKIE = "ahd-locale"

  fun pick(cookieHeader: String?): String? {
    val raw = cookieHeader?.split(';')?.map { it.trim() }
      ?.firstOrNull { it.substringBefore('=') == COOKIE }?.substringAfter('=', "")?.trim()
    val tag = raw?.lowercase()?.substringBefore('-')?.takeIf { it.isNotEmpty() && it.length <= 3 } ?: return null
    return if (tag in SUPPORTED) tag else "en"
  }

  @Volatile private var app: Context? = null
  @Volatile private var language: String? = null
  private val byLanguage = ConcurrentHashMap<String, Resources>()

  fun init(context: Context) { if (app == null) app = context.applicationContext }

  /** Re-reads the language cookie. The cookie store is in memory, so this is cheap. */
  fun sync() {
    language = NativeSafety.get("language cookie", null as String?) { pick(CookieManager.getInstance().getCookie(NATIVE_GAME_ORIGIN)) }
  }

  private fun resources(): Resources? {
    val context = app ?: return null
    val tag = language ?: return context.resources
    return byLanguage.getOrPut(tag) {
      val configuration = Configuration(context.resources.configuration)
      configuration.setLocale(Locale.forLanguageTag(tag))
      context.createConfigurationContext(configuration).resources
    }
  }

  fun s(id: Int, vararg args: Any): String {
    val resources = resources() ?: return ""
    return if (args.isEmpty()) resources.getString(id) else resources.getString(id, *args)
  }

  fun n(id: Int, count: Int, vararg args: Any): String = resources()?.getQuantityString(id, count, *args) ?: ""
}
