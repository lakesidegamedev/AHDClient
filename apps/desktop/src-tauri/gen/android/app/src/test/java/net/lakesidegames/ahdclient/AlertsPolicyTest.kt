package net.lakesidegames.ahdclient

import net.lakesidegames.ahdclient.AlertsPolicy.Mode
import net.lakesidegames.ahdclient.AlertsPolicy.Permission
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AlertsPolicyTest {
  init { TestTexts.install() }

  @Test fun permissionFollowsTheTwoDenialRule() {
    assertEquals(Permission.GRANTED, AlertsPolicy.permission(34, true, 0))
    assertEquals(Permission.ASKABLE, AlertsPolicy.permission(34, false, 0))
    assertEquals(Permission.ASKABLE, AlertsPolicy.permission(34, false, 1))
    assertEquals(Permission.BLOCKED, AlertsPolicy.permission(34, false, 2))
    // Before Android 13 there is no prompt: blocked means settings.
    assertEquals(Permission.BLOCKED, AlertsPolicy.permission(32, false, 0))
    assertEquals(Permission.GRANTED, AlertsPolicy.permission(32, true, 0))
  }

  @Test fun aRefusalWithNoPromptLeftBlocksAtOnce() {
    assertEquals(1, AlertsPolicy.denialsAfterRefusal(0, canStillAsk = true))
    assertEquals(2, AlertsPolicy.denialsAfterRefusal(1, canStillAsk = true))
    assertEquals(2, AlertsPolicy.denialsAfterRefusal(0, canStillAsk = false))
    assertEquals(2, AlertsPolicy.denialsAfterRefusal(2, canStillAsk = true))
  }

  @Test fun asksOnlyOnceAfterASignedInStatusLoadOnAGamePage() {
    fun ask(asked: Boolean = false, signedIn: Boolean = true, loaded: Boolean = true, game: Boolean = true,
      enabled: Boolean = false, permission: Permission = Permission.ASKABLE) =
      AlertsPolicy.shouldAsk(asked, signedIn, loaded, game, enabled, permission)
    assertTrue(ask())
    assertTrue(ask(permission = Permission.GRANTED))
    assertFalse(ask(asked = true))
    assertFalse(ask(signedIn = false))
    assertFalse(ask(loaded = false))
    assertFalse(ask(game = false))
    assertFalse(ask(enabled = true, permission = Permission.GRANTED))
    assertFalse(ask(permission = Permission.BLOCKED))
  }

  @Test fun modeShowsWhatTheRowShould() {
    assertEquals(Mode.ON, AlertsPolicy.mode(true, Permission.GRANTED))
    assertEquals(Mode.OFF, AlertsPolicy.mode(false, Permission.GRANTED))
    assertEquals(Mode.OFF, AlertsPolicy.mode(true, Permission.ASKABLE))
    assertEquals(Mode.BLOCKED, AlertsPolicy.mode(true, Permission.BLOCKED))
  }

  @Test fun askCopyMatchesTheIphone() {
    val ask = AlertsPolicy.copy(Mode.ASK)
    assertEquals("Get alerts for votes, offers and attacks?", Texts.s(ask.title))
    assertEquals("We will tell you the moment something needs you, even when the app is closed. You can change this any time under More, Alerts.", Texts.s(ask.body))
    assertEquals("Turn on alerts", Texts.s(ask.primary))
    assertEquals("Not now", Texts.s(ask.secondary))
    for (mode in Mode.values()) {
      val copy = AlertsPolicy.copy(mode)
      assertFalse(listOf(copy.title, copy.body, copy.primary, copy.secondary).map { Texts.s(it) }.any { it.contains('\u2014') || it.contains('\u2013') })
    }
  }

  @Test fun noAlertForThePageBeingRead() {
    assertTrue(AlertsPolicy.isViewing("/country/fr", "/country/fr"))
    assertTrue(AlertsPolicy.isViewing("/election/9?x=1", "/election/9"))
    assertTrue(AlertsPolicy.isViewing("/country/fr/", "/country/fr?tab=a"))
    assertTrue("the inbox lists them all", AlertsPolicy.isViewing("/election/9", "/notifications"))
    assertFalse(AlertsPolicy.isViewing("/country/fr", "/country/de"))
    assertFalse(AlertsPolicy.isViewing("/country/fr", null))
    assertFalse(AlertsPolicy.isViewing(null, "/country/fr"))
    assertFalse(AlertsPolicy.isViewing("https://evil.example/country/fr", "/country/fr"))
  }

  @Test fun theReminderNeedsEverythingInPlace() {
    fun at(next: Long? = 100_000L, on: Boolean = true, permission: Permission = Permission.GRANTED,
      signedIn: Boolean = true, active: Boolean = true) = AlertsPolicy.reminderAt(next, 0L, on, permission, signedIn, active)
    assertEquals(100_000L, at())
    assertEquals(null, at(on = false))
    assertEquals(null, at(permission = Permission.ASKABLE))
    assertEquals(null, at(permission = Permission.BLOCKED))
    assertEquals(null, at(signedIn = false))
    assertEquals(null, at(active = false))
    assertEquals(null, at(next = null))
    assertEquals(null, at(next = -5_000L))
    assertEquals(null, at(next = 4_000L))
  }

  @Test fun theReminderAnnouncesTheTurnAfterTheRunningOne() {
    assertEquals(215, AlertsPolicy.reminderTurn(214))
    assertEquals(null, AlertsPolicy.reminderTurn(null))
    assertEquals(null, AlertsPolicy.reminderTurn(-1))
    assertEquals("Turn 215 is in", Texts.s(AlertsPolicy.reminderTitle(215), 215))
    assertEquals("A new turn is in", Texts.s(AlertsPolicy.reminderTitle(null), 0))
  }
}

