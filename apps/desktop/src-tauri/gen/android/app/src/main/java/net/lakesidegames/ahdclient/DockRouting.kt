package net.lakesidegames.ahdclient

/**
 * Small decisions the dock makes about the page on screen and the cookies it
 * holds, kept free of Android classes so they are unit tested on the JVM.
 */

/**
 * What one dock request is for. The game answers per account, per language
 * (the `ahd-locale` cookie) and per country (`?country=XX`, so Nation follows
 * the page), so a cached model is only reused for the same triple.
 */
data class DockKey(val identity: String, val locale: String?, val country: String?) {
  /** Cache entry name inside one account's file. */
  val sub: String get() = sub(locale, country)

  companion object {
    fun sub(locale: String?, country: String?) = "${locale ?: "-"}|${country ?: "-"}"
  }
}

object DockRouting {
  /** How long a top level load may take to show before Back history stops waiting for it. */
  const val TOP_LEVEL_WAIT_MS = 15_000L

  /**
   * True once the page on screen is the top level page a dock tap asked for, so
   * the history before it can go. Compares path and query only (a trailing slash
   * or the fragment does not matter) and never matches a null address.
   */
  fun reachedTopLevel(target: String?, current: String?): Boolean {
    val a = pathAndQuery(target) ?: return false
    return a == pathAndQuery(current)
  }

  private fun pathAndQuery(url: String?): String? {
    if (url.isNullOrBlank()) return null
    val noFragment = url.substringBefore('#')
    val rest = noFragment.substringAfter("://", "")
    if (rest.isEmpty()) return null
    val path = "/" + rest.substringAfter('/', "")
    val p = path.substringBefore('?').trimEnd('/').ifEmpty { "/" }
    val q = if (path.contains('?')) "?" + path.substringAfter('?') else ""
    return p + q
  }

  /** Pages that mean the player is signing in or out. */
  private val AUTH_PATHS = setOf("/login", "/register", "/logout")
  private val COUNTRY = Regex("^/country/([A-Za-z]{2,4})(/|$)")
  private val LOCALE = Regex("^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$")

  /** Sign-in, registration or sign-out: the dock drops to the fallback tabs at once. */
  fun isAuthPath(path: String?): Boolean {
    val clean = path?.substringBefore('?')?.substringBefore('#')?.trimEnd('/')?.lowercase() ?: return false
    return AUTH_PATHS.any { clean == it || clean.startsWith("$it/") }
  }

  /** The country a page is about, upper case ("/country/uk/budget" gives "UK"), or null off country pages. */
  fun countryOf(path: String?): String? =
    path?.let { COUNTRY.find(it) }?.groupValues?.get(1)?.uppercase()

  /** The `ahd-locale` cookie's value from a Cookie header, when it looks like a language tag. */
  fun localeFrom(cookieHeader: String?): String? {
    val raw = cookieHeader?.split(';')?.map { it.trim() }
      ?.firstOrNull { it.substringBefore('=') == LOCALE_COOKIE }?.substringAfter('=', "")?.trim()
    return raw?.takeIf { it.length <= 16 && LOCALE.matches(it) }
  }

  const val LOCALE_COOKIE = "ahd-locale"

  /** The status strip is for signed-in play on the live game: not the launcher, Briefing, sign-in pages or the sandbox. */
  fun stripAllowed(onGamePage: Boolean, signedIn: Boolean, authPage: Boolean, sandbox: Boolean): Boolean =
    onGamePage && signedIn && !authPage && !sandbox
}
