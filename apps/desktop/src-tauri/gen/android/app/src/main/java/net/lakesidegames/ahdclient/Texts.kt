package net.lakesidegames.ahdclient

import android.content.Context
import android.content.res.Resources
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * Every player-facing word in the app comes through here. The language follows the game's own
 * `ahd-locale` cookie (as the dock already does), not the phone: a player who chose German in the
 * game gets a German app. With no cookie the phone's language (or the per-app language chosen in
 * Android settings) decides, and anything the app has no translation for stays English.
 */
object Texts {
  /** What resolves a string. Production reads resources; JVM tests install a lookup over the XML. */
  interface Lookup {
    fun string(id: Int, args: Array<out Any>): String
    fun plural(id: Int, count: Int, args: Array<out Any>): String
  }

  /** The languages the app and the game both ship. */
  val SUPPORTED = setOf("en", "de")

  /** The app language for a game cookie value: a supported one, English for an unsupported one, null (follow the phone) for none. */
  fun pick(cookie: String?): String? {
    val tag = cookie?.trim()?.lowercase()?.substringBefore('-')?.takeIf { it.isNotEmpty() } ?: return null
    return if (tag in SUPPORTED) tag else "en"
  }

  @Volatile var lookup: Lookup? = null
  @Volatile private var app: Context? = null
  @Volatile private var language: String? = null
  private val byLanguage = ConcurrentHashMap<String, Resources>()

  fun init(context: Context) { if (app == null) app = context.applicationContext }

  /** Re-reads the game's language cookie. Cheap: the cookie store is in memory. */
  fun syncFromCookie() { language = pick(DockModelStore.locale()) }

  fun use(cookieLocale: String?) { language = pick(cookieLocale) }

  private fun resources(): Resources? {
    val context = app ?: return null
    val tag = language ?: return context.resources
    return byLanguage.getOrPut(tag) {
      val configuration = android.content.res.Configuration(context.resources.configuration)
      configuration.setLocale(Locale.forLanguageTag(tag))
      context.createConfigurationContext(configuration).resources
    }
  }

  fun s(id: Int, vararg args: Any): String {
    lookup?.let { return it.string(id, args) }
    val resources = resources() ?: return ""
    return if (args.isEmpty()) resources.getString(id) else resources.getString(id, *args)
  }

  fun n(id: Int, count: Int, vararg args: Any): String {
    lookup?.let { return it.plural(id, count, args) }
    val resources = resources() ?: return ""
    return resources.getQuantityString(id, count, *args)
  }

  /** The locale for number formatting, so figures read "1,3" in German. */
  fun locale(): Locale = language?.let { Locale.forLanguageTag(it) } ?: Locale.getDefault()
}
