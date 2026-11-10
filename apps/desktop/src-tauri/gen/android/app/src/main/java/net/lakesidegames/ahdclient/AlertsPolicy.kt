package net.lakesidegames.ahdclient

/**
 * The rules for alerts, with no Android types so they run on the JVM.
 * The one-time question, what the Alerts row shows, the two-denial rule and
 * which alerts are not worth raising or keeping.
 */
object AlertsPolicy {
  enum class Permission { GRANTED, ASKABLE, BLOCKED }
  enum class Mode { ASK, OFF, ON, BLOCKED }

  /** Android shows its own permission prompt at most twice; after that only system settings can help. */
  const val MAX_DENIALS = 2
  private const val FIRST_ASKABLE_SDK = 33
  private const val INBOX = "/notifications"

  class Copy(val title: String, val body: String, val primary: String, val secondary: String)

  /**
   * [allowed] is the system's current answer (notifications enabled for the app); [denials] is how
   * many times the prompt was refused. Before Android 13 there is no prompt, so a blocked app can
   * only be fixed in settings.
   */
  fun permission(sdk: Int, allowed: Boolean, denials: Int): Permission = when {
    allowed -> Permission.GRANTED
    sdk < FIRST_ASKABLE_SDK -> Permission.BLOCKED
    denials >= MAX_DENIALS -> Permission.BLOCKED
    else -> Permission.ASKABLE
  }

  /** The count after the prompt was refused. No rationale left means the system will not show it again. */
  fun denialsAfterRefusal(denials: Int, canStillAsk: Boolean): Int =
    if (canStillAsk) minOf(denials + 1, MAX_DENIALS) else MAX_DENIALS

  /** The one-time question: signed in, status loaded, on a game page, never asked, not already on, not blocked. */
  fun shouldAsk(asked: Boolean, signedIn: Boolean, statusLoaded: Boolean, onGamePage: Boolean,
    enabled: Boolean, permission: Permission): Boolean =
    !asked && signedIn && statusLoaded && onGamePage && !enabled && permission != Permission.BLOCKED

  fun mode(enabled: Boolean, permission: Permission): Mode = when {
    permission == Permission.BLOCKED -> Mode.BLOCKED
    enabled && permission == Permission.GRANTED -> Mode.ON
    else -> Mode.OFF
  }

  fun copy(mode: Mode): Copy = when (mode) {
    Mode.ASK -> Copy("Get alerts for votes, offers and attacks?",
      "We will tell you the moment something needs you, even when the app is closed. You can change this any time under More, Alerts.",
      "Turn on alerts", "Not now")
    Mode.OFF -> Copy("Alerts are off", "Turn them on to hear about votes, offers and attacks.", "Turn on alerts", "Close")
    Mode.ON -> Copy("Alerts are on", "You will hear about votes, offers and attacks, even when the app is closed.", "Turn off alerts", "Done")
    Mode.BLOCKED -> Copy("Alerts are blocked in Android",
      "Allow notifications for this app in Android Settings to get alerts.", "Open Android Settings", "Close")
  }

  /** True when the player is on the page the alert is about, or on the inbox, which lists them all. [href] is a game path, query allowed. */
  fun isViewing(href: String?, viewing: String?): Boolean {
    if (viewing == null) return false
    val page = viewing.substringBefore('?').trimEnd('/')
    if (page == INBOX) return true
    if (href == null || !href.startsWith("/")) return false
    return href.substringBefore('?').trimEnd('/') == page
  }
}
