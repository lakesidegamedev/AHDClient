package net.lakesidegames.ahdclient

import android.view.KeyEvent

/**
 * Hardware keyboard shortcuts for tablets, Chromebooks and foldables. Pure, so the
 * mapping is unit tested on the JVM. Nothing unmodified is bound: Back and the arrow
 * keys belong to the system and to TV remotes.
 */
object DockShortcuts {
  sealed class Action {
    /** Ctrl+1 to Ctrl+5: the dock tab at this zero based position. */
    data class Tab(val index: Int) : Action()
    object Ask : Action()
    object Reload : Action()
    object Back : Action()
  }

  const val TAB_COUNT = 5

  fun resolve(keyCode: Int, ctrl: Boolean, alt: Boolean, shift: Boolean = false): Action? {
    if (shift) return null
    if (ctrl && !alt) {
      val tab = keyCode - KeyEvent.KEYCODE_1
      if (tab in 0 until TAB_COUNT) return Action.Tab(tab)
      return when (keyCode) {
        KeyEvent.KEYCODE_K -> Action.Ask
        KeyEvent.KEYCODE_R -> Action.Reload
        else -> null
      }
    }
    if (alt && !ctrl && keyCode == KeyEvent.KEYCODE_DPAD_LEFT) return Action.Back
    return null
  }

  /** Whether a window this short (in dp) is too cramped for the status strip. */
  fun isCompactHeight(heightDp: Int): Boolean = heightDp in 1 until COMPACT_HEIGHT_DP
  const val COMPACT_HEIGHT_DP = 480

  /** Whether a window this wide (in dp) lets the dock follow the page's full width. */
  fun isWide(widthDp: Int): Boolean = widthDp >= WIDE_WIDTH_DP
  const val WIDE_WIDTH_DP = 840
}
