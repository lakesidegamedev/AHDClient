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

  /** Resource ids for one sheet's words; resolve them with [Texts.s] when drawing. */
  class Copy(val title: Int, val body: Int, val primary: Int, val secondary: Int)

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
    Mode.ASK -> Copy(R.string.alerts_ask_title, R.string.alerts_ask_body, R.string.alerts_turn_on, R.string.alerts_not_now)
    Mode.OFF -> Copy(R.string.alerts_off_title, R.string.alerts_off_body, R.string.alerts_turn_on, R.string.alerts_close)
    Mode.ON -> Copy(R.string.alerts_on_title, R.string.alerts_on_body, R.string.alerts_turn_off, R.string.alerts_done)
    Mode.BLOCKED -> Copy(R.string.alerts_blocked_title, R.string.alerts_blocked_body, R.string.alerts_open_settings, R.string.alerts_close)
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
