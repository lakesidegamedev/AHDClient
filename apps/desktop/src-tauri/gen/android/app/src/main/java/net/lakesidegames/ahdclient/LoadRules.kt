package net.lakesidegames.ahdclient

import android.webkit.WebViewClient

/** The pure decisions behind the loading bar and the cannot-reach-the-game screen, kept apart so they can be tested. */
object LoadRules {
  /** Words on the screen. The same as the iPhone app. */
  const val TITLE = "Cannot reach the game"
  const val DETAIL = "Check your connection and try again."
  const val RETRY = "Retry"
  const val BACK = "Back to launcher"

  /** The loading bar never shows less than this, so the first moment of a load is visible. */
  private const val MIN_FILL = 8

  /**
   * Whether a failed request should put up the screen. Only the page itself (not an image or a
   * script), only for trouble a player can act on (no connection, slow or dropped connection),
   * and not the case the underlying client handles on its own: a refused connection to a URL it
   * did not serve is its sign-in redirect trick, which restarts the load.
   */
  fun showsError(isMainFrame: Boolean, errorCode: Int, requestUrl: String?, lastServedUrl: String?): Boolean {
    if (!isMainFrame || requestUrl.isNullOrBlank()) return false
    if (errorCode == WebViewClient.ERROR_CONNECT && requestUrl != lastServedUrl) return false
    return errorCode == WebViewClient.ERROR_HOST_LOOKUP || errorCode == WebViewClient.ERROR_CONNECT ||
      errorCode == WebViewClient.ERROR_TIMEOUT || errorCode == WebViewClient.ERROR_IO
  }

  /** Show the bar while a game page is loading. */
  fun barVisible(progress: Int, onGamePage: Boolean, errorShown: Boolean): Boolean =
    onGamePage && !errorShown && progress in 0..99

  /** How many pixels of [totalPx] the bar fills at [progress] percent. */
  fun barFill(progress: Int, totalPx: Int): Int {
    val shown = progress.coerceIn(MIN_FILL, 100)
    return totalPx * shown / 100
  }
}
