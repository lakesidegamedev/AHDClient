package net.lakesidegames.ahdclient

/**
 * Which https links on the game's own site the app takes over (Android App Links).
 * Kept free of Android classes so the rule is unit tested on the JVM. The manifest
 * lists the same sections as `pathPrefix` entries; this is the second check, so a
 * link that reaches the activity by any route is still held to the same list.
 *
 * Sign-in, registration, sign-out, password and e-mail confirmation pages, the API
 * and the admin area are never here: those stay in the browser.
 */
object AppLinks {
  /** First path segments of the game pages a shared link may open in the app. */
  val SECTIONS = listOf(
    "elections", "corporation", "corporations", "state", "country", "profile",
    "notifications", "congress", "parties", "stockmarket", "news", "politician", "character",
  )

  /** The live game's own hosts. The sandbox keeps its own sign-in and is not claimed. */
  private val HOSTS = setOf("ahousedividedgame.com", "www.ahousedividedgame.com")

  /**
   * The path (with query) to load for a link, or null when the app should leave it alone.
   * [path] and [query] are the encoded parts of the address.
   */
  fun pathFor(scheme: String?, host: String?, path: String?, query: String?): String? {
    if (scheme != "https" || host?.lowercase() !in HOSTS) return null
    val clean = path ?: return null
    val section = clean.trimStart('/').substringBefore('/')
    if (section !in SECTIONS) return null
    val full = clean + (query?.let { "?$it" } ?: "")
    // Same bounds as BriefingWidgets.gamePath, repeated so this stays free of Android classes.
    return full.takeIf { it.length <= 300 && !it.startsWith("//") && it.none { c -> c == '\\' || c.isWhitespace() || c.isISOControl() } }
  }
}
