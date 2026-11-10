package net.lakesidegames.ahdclient

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The dock against real /api/mobile-dock output (src/test/resources), not hand-made documents. */
class DockContractTest {
  init { TestTexts.install() }

  private fun load(name: String): JSONObject =
    JSONObject(checkNotNull(javaClass.classLoader!!.getResource(name)) { "missing fixture $name" }.readText())

  private val staff by lazy { DockModel.parse(load("mobile-dock-staff-us.json"))!! }
  private val player by lazy { DockModel.parse(load("mobile-dock-player-nocompany-uk.json"))!! }

  private fun links(model: DockModel, sheet: String) = model.sheets.getValue(sheet).sections.flatMap { it.links }

  @Test fun staffPayloadGivesFiveTabsAndEverySheet() {
    assertEquals(listOf("company", "state", "nation", "actions", "more"), staff.tabs.map { it.id })
    for (sheet in listOf("state", "nation", "more")) {
      assertTrue("$sheet has rows", links(staff, sheet).isNotEmpty())
    }
    assertTrue(staff.tabs.all { it.icon.width == 11 && it.icon.height == 11 })
    // Colon section ids are real ("state:overview") and every section survives.
    assertEquals(5, staff.sheets.getValue("state").sections.size)
    assertEquals(6, staff.sheets.getValue("nation").sections.size)
    assertTrue(staff.sheets.getValue("nation").sections.any { it.id == "switch-country" && it.links.any { l -> l.id == "country:US" } })
  }

  @Test fun staffMoreKeepsAllThirteenSectionsIncludingStaff() {
    val sections = staff.sheets.getValue("more").sections
    assertEquals(13, sections.size)
    assertEquals(listOf("staff:overview", "staff:staff"), sections.map { it.id }.filter { it.startsWith("staff:") })
    assertTrue(links(staff, "more").any { it.id == "menus.staff.adminPanel" && it.href == "/admin" })
    // With the app section in front nothing is lost and the Inbox is not listed twice.
    val withApp = staff.withApp(true).sheets.getValue("more").sections
    assertEquals("app", withApp.first().id)
    assertEquals(13, withApp.size - 1)
    assertEquals(1, withApp.flatMap { it.links }.count { it.app == AppAction.INBOX })
    assertTrue(withApp.flatMap { it.links }.none { it.href == "/notifications" })
    assertTrue(withApp.flatMap { it.links }.none { it.id == "notifications" })
  }

  @Test fun theRealPathsLightTheRightTabs() {
    assertEquals("state", staff.activeTab("/country/us/region/NY/legislature")?.id)
    assertEquals("nation", staff.activeTab("/country/us/budget")?.id)
    assertEquals("company", staff.activeTab("/corporation/7/finance")?.id)
    assertEquals("actions", staff.activeTab("/actions")?.id)
    // The longer state prefix beats the nation prefix it sits under.
    assertEquals("state", staff.activeTab("/country/us/region/NY")?.id)
    assertEquals("nation", staff.activeTab("/country/us/region/CA")?.id)
    // Another company is not this player's Company tab; pages nobody claims light nothing.
    assertNull(staff.activeTab("/corporation/8"))
    assertNull(staff.activeTab("/notifications"))
    assertNull(staff.activeTab("/country/uk/budget"))
  }

  @Test fun aPlayerWithoutACompanyGetsTheMarketTab() {
    assertEquals(listOf("market", "state", "nation", "actions", "more"), player.tabs.map { it.id })
    assertEquals("Market", player.tabs[0].label)
    assertEquals("/market", player.tabs[0].href)
    assertEquals("market", player.activeTab("/market/stocks")?.id)
    assertEquals("nation", player.activeTab("/country/uk/budget")?.id)
    // No staff tools for a player.
    assertTrue(player.sheets.getValue("more").sections.none { it.id.startsWith("staff:") })
    assertEquals(10, player.sheets.getValue("more").sections.size)
  }

  @Test fun theNationTabUsesTheShortLabelAndKeepsTheFullName() {
    val nation = staff.tabs.first { it.id == "nation" }
    assertEquals("Nation", nation.label)
    assertEquals("United States", nation.fullLabel)
    assertEquals("United States", staff.sheets.getValue("nation").title)
    assertEquals("Company", staff.tabs[0].label)
    assertEquals("Company", staff.tabs[0].fullLabel)
  }

  @Test fun externalLinksAreParsedAndFlagged() {
    val external = links(staff, "more").filter { it.external }
    assertEquals(
      setOf(
        "https://wiki.ahousedividedgame.com", "https://discord.gg/DmF8zJJuqN",
        "https://lakesidegames.net/supporters", "mailto:admin@ahousedividedgame.com", "https://docs.lakesidegames.net",
      ),
      external.map { it.href }.filter { it != null && !it.contains("patreon") }.toSet(),
    )
    assertTrue(external.any { it.href?.startsWith("https://www.patreon.com/") == true })
    assertEquals(7, external.size)
    // Nothing external is a game page, and no game page is flagged.
    assertTrue(links(staff, "more").filter { !it.external }.all { it.href!!.startsWith("/") })
  }

  @Test fun everyRealLabelAndIdSurvivesIntact() {
    val all = listOf(staff, player).flatMap { model -> model.sheets.keys.flatMap { links(model, it) } }
    assertTrue(all.any { it.label.length > 28 })
    assertTrue(all.none { it.label.isBlank() })
    // The long state party row keeps its whole text for the view to ellipsize.
    assertTrue(links(staff, "state").any { it.label.length == 38 && it.label.startsWith("New York") })
  }

  @Test fun theAppSectionLeadsMoreAndSitsBesideTheGameRows() {
    val sheet = player.withApp(true).sheets.getValue("more")
    assertEquals("Everything", sheet.title)
    assertEquals(listOf("Briefing", "Inbox", "Alerts", "Ask", "Back to launcher"), sheet.sections.first().links.map { it.label })
    assertTrue(sheet.sections.first().links.all { it.icon != null && it.icon!!.width == 11 && it.icon!!.height == 11 })
  }

  @Test fun theCannedPreviewFixtureHasTheRealShape() {
    val fixture = DockModel.fixture()
    assertEquals(listOf("company", "state", "nation", "actions", "more"), fixture.tabs.map { it.id })
    assertTrue(fixture.sheets.getValue("state").sections.any { it.id.contains(':') })
    assertTrue(fixture.sheets.getValue("more").sections.flatMap { it.links }.any { it.external })
    assertTrue(fixture.sheets.getValue("more").sections.flatMap { it.links }.none { it.id == "notifications" })
    // Some rows have icons and some do not, as in the game; the view reserves the column for both.
    val state = fixture.sheets.getValue("state").sections.flatMap { it.links }
    assertTrue(state.any { it.icon != null } && state.any { it.icon == null })
    assertNotNull(fixture.sheets["nation"])
    assertTrue(fixture.fromGame)
  }
}
