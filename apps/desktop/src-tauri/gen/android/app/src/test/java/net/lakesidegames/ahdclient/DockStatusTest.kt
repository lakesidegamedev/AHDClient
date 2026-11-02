package net.lakesidegames.ahdclient

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.Locale

class DockStatusTest {
  @Before fun locale() = Locale.setDefault(Locale.US)

  private fun snapshot(extra: String = "") = JSONObject(
    """{"status":"ready","name":"A","funds":1284000,"actions":6,"actionCap":10,"homeCurrency":"USD",
    "politicalInfluence":42,"nationalInfluence":17,
    "perTurn":{"funds":41500,"politicalInfluence":1.5,"liquidCapital":-120000},
    "turn":{"current":214,"date":"March 1976","nextAt":"2026-10-09T22:00:00.000Z","active":true},
    "corpNav":{"sequentialId":9,"liquidCapital":8420000,"liquidCurrencyCode":"EUR"},
    "inbox":{"unread":3,"mail":2},"updatedAt":1700000000000$extra}""",
  )

  @Test fun numbersAreCompact() {
    assertEquals("1.3M USD", DockFormat.number(1_284_000.0, " USD"))
    assertEquals("41.5K", DockFormat.number(41_500.0))
    assertEquals("6", DockFormat.number(6.0))
    assertEquals("2.4B", DockFormat.number(2.35e9))
    assertEquals("+41.5K", DockFormat.signed(41_500.0))
    assertEquals("-120K", DockFormat.signed(-120_000.0))
  }

  @Test fun spokenNumbersUseWords() {
    assertEquals("1.3 million", DockFormat.spoken(1_284_000.0))
    assertEquals("41.5 thousand", DockFormat.spoken(41_500.0))
    assertEquals("6", DockFormat.spoken(6.0))
  }

  @Test fun countdownTicksDown() {
    assertEquals("2h 14m", DockFormat.countdown((2 * 3600 + 14 * 60 + 5) * 1000L))
    assertEquals("14m 05s", DockFormat.countdown((14 * 60 + 5) * 1000L))
    assertEquals("45s", DockFormat.countdown(45_000L))
    assertEquals("1d 4h", DockFormat.countdown((28 * 3600) * 1000L))
    assertEquals("0s", DockFormat.countdown(-5_000L))
  }

  @Test fun stripClockIsOneCompactToken() {
    assertEquals("2:14:05", DockFormat.clock((2 * 3600 + 14 * 60 + 5) * 1000L, true))
    assertEquals("14:05", DockFormat.clock((14 * 60 + 5) * 1000L, true))
    assertEquals("0:45", DockFormat.clock(45_000L, true))
    assertEquals("23:59:59", DockFormat.clock((23 * 3600 + 59 * 60 + 59) * 1000L, true))
    assertEquals("1d 4h", DockFormat.clock(28 * 3600 * 1000L, true))
    assertEquals("Due now", DockFormat.clock(0L, true))
    assertEquals("Due now", DockFormat.clock(-5_000L, true))
    assertEquals("Paused", DockFormat.clock(3_600_000L, false))
    assertEquals("", DockFormat.clock(null, true))
  }

  @Test fun spokenCountdownIsCoarse() {
    assertEquals("2 hours 14 minutes", DockFormat.spokenCountdown((2 * 3600 + 14 * 60 + 5) * 1000L))
    assertEquals("1 hour 1 minute", DockFormat.spokenCountdown((3600 + 60) * 1000L))
    assertEquals("less than a minute", DockFormat.spokenCountdown(30_000L))
  }

  @Test fun buildsEveryFigureFromTheSnapshot() {
    val status = DockStatus.from(snapshot())
    assertNotNull(status)
    status!!
    assertEquals("1.3M USD", status.funds?.value)
    assertEquals("+41.5K", status.funds?.change)
    assertTrue(status.funds!!.positive)
    assertEquals("/profile", status.funds?.path)
    assertEquals("6 / 10", status.actions?.value)
    assertEquals("6 of 10 actions", status.actions?.spoken)
    assertEquals("8.4M EUR", status.corpCash?.value)
    assertEquals("-120K", status.corpCash?.change)
    assertFalse(status.corpCash!!.positive)
    assertEquals("/corporation/9", status.corpCash?.path)
    assertEquals("42%", status.stateInfluence?.value)
    assertEquals("+1.5 pp", status.stateInfluence?.change)
    assertEquals("17", status.nationalInfluence?.value)
    assertNull(status.nationalInfluence?.change)
    assertEquals("Turn 214 · March 1976", status.turnTitle)
    assertEquals(3, status.notifications)
    assertEquals(2, status.mail)
    assertNotNull(status.nextTurnAt)
    assertTrue(status.hasStrip)
  }

  @Test fun spokenFundsSayWhichWayTheyMoved() {
    val status = DockStatus.from(snapshot())!!
    assertEquals("Campaign funds 1.3 million USD, up 41.5 thousand USD", status.funds?.spoken)
    assertEquals("Corporate cash 8.4 million EUR, down 120 thousand EUR", status.corpCash?.spoken)
  }

  @Test fun signedOutAndNoCharacterShowNothing() {
    assertNull(DockStatus.from(null))
    assertNull(DockStatus.from(JSONObject("""{"status":"no-character"}""")))
  }

  @Test fun imperialPlayersGetNoCampaignFigures() {
    val status = DockStatus.from(snapshot(""","isImperial":true"""))!!
    assertNull(status.funds)
    assertNull(status.stateInfluence)
    assertNull(status.nationalInfluence)
    assertNotNull(status.actions)
  }

  @Test fun missingPiecesLeaveNoPlaceholders() {
    val status = DockStatus.from(JSONObject("""{"status":"ready","name":"A","actions":3}"""))!!
    assertNull(status.funds)
    assertNull(status.corpCash)
    assertNull(status.nextTurnAt)
    assertEquals("3", status.actions?.value)
    assertEquals(0, status.notifications)
  }

  @Test fun pausedTurnsStillEarnAStrip() {
    val status = DockStatus.from(JSONObject("""{"status":"ready","name":"A","turn":{"current":3,"active":false}}"""))!!
    assertFalse(status.turnActive)
    assertTrue(status.hasStrip)
  }

  @Test fun smallChangesAreHidden() {
    val status = DockStatus.from(snapshot().also { it.getJSONObject("perTurn").put("funds", 0.001) })!!
    assertNull(status.funds?.change)
  }
}
