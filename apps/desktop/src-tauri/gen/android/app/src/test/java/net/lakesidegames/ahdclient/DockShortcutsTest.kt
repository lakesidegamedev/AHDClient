package net.lakesidegames.ahdclient

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DockShortcutsTest {
  @Test fun ctrlDigitsPickTabs() {
    assertEquals(DockShortcuts.Action.Tab(0), DockShortcuts.resolve(KeyEvent.KEYCODE_1, ctrl = true, alt = false))
    assertEquals(DockShortcuts.Action.Tab(4), DockShortcuts.resolve(KeyEvent.KEYCODE_5, ctrl = true, alt = false))
    assertNull(DockShortcuts.resolve(KeyEvent.KEYCODE_6, ctrl = true, alt = false))
  }

  @Test fun namedShortcuts() {
    assertEquals(DockShortcuts.Action.Ask, DockShortcuts.resolve(KeyEvent.KEYCODE_K, ctrl = true, alt = false))
    assertEquals(DockShortcuts.Action.Reload, DockShortcuts.resolve(KeyEvent.KEYCODE_R, ctrl = true, alt = false))
    assertEquals(DockShortcuts.Action.Back, DockShortcuts.resolve(KeyEvent.KEYCODE_DPAD_LEFT, ctrl = false, alt = true))
  }

  @Test fun unmodifiedKeysAreNeverBound() {
    assertNull(DockShortcuts.resolve(KeyEvent.KEYCODE_1, ctrl = false, alt = false))
    assertNull(DockShortcuts.resolve(KeyEvent.KEYCODE_DPAD_LEFT, ctrl = false, alt = false))
    assertNull(DockShortcuts.resolve(KeyEvent.KEYCODE_K, ctrl = false, alt = false))
    assertNull(DockShortcuts.resolve(KeyEvent.KEYCODE_R, ctrl = true, alt = true))
    assertNull(DockShortcuts.resolve(KeyEvent.KEYCODE_R, ctrl = true, alt = false, shift = true))
  }

  @Test fun windowSizeRules() {
    assertTrue(DockShortcuts.isCompactHeight(360))
    assertFalse(DockShortcuts.isCompactHeight(480))
    assertFalse(DockShortcuts.isCompactHeight(0))
    assertTrue(DockShortcuts.isWide(840))
    assertFalse(DockShortcuts.isWide(839))
  }
}
