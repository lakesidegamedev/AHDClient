package net.lakesidegames.ahdclient

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DockModelTest {
  init { TestTexts.install() }

  private val icon = """{"name":"x","grid":["010","111","010"]}"""

  private fun tab(id: String, extra: String) = """{"id":"$id","label":"Tab $id","icon":$icon$extra}"""

  private fun doc(tabs: List<String>, sheets: String = """{"s":{"title":"S","sections":[{"id":"a","title":"A","links":[{"id":"l","label":"L","href":"/l"}]}]}}""") =
    JSONObject("""{"version":1,"tabs":[${tabs.joinToString(",")}],"sheets":$sheets}""")

  @Test fun parsesTheFixtureTheGameShape() {
    assertNull("no tabs is not a dock", DockModel.parse(JSONObject("""{"version":1,"tabs":[],"sheets":{}}""")))
    val fixture = DockModel.fixture()
    assertEquals(listOf("company", "state", "nation", "actions", "more"), fixture.tabs.map { it.id })
    assertEquals("Company", fixture.tabs[0].label)
    // The game sends a short label for Nation; the tab shows it and keeps the full name for TalkBack.
    assertEquals("Nation", fixture.tabs[2].label)
    assertEquals("United States", fixture.tabs[2].fullLabel)
    assertEquals("/corporation/7", fixture.tabs[0].href)
    assertEquals("state", fixture.tabs[1].sheet)
    assertNotNull(fixture.sheets["state"])
    assertTrue(fixture.tabs.all { it.icon.height == 11 && it.icon.width == 11 })
  }

  @Test fun moreSheetStartsWithTheAppSection() {
    val sections = DockModel.fixture().sheets.getValue("more").sections
    assertEquals("app", sections[0].id)
    assertEquals(listOf("Briefing", "Inbox", "Alerts", "Ask", "Back to launcher"), sections[0].links.map { it.label })
    assertEquals(listOf(AppAction.BRIEFING, AppAction.INBOX, AppAction.ALERTS, AppAction.ASK, AppAction.LAUNCHER), sections[0].links.map { it.app })
    assertEquals("you:you", sections[1].id)
  }

  @Test fun rejectsOtherVersionsAndTooFewTabs() {
    val ok = tab("a", ""","href":"/a"""") + "," + tab("b", ""","href":"/b"""")
    assertNotNull(DockModel.parse(JSONObject("""{"version":1,"tabs":[$ok],"sheets":{}}""")))
    assertNull(DockModel.parse(JSONObject("""{"version":2,"tabs":[$ok],"sheets":{}}""")))
    assertNull(DockModel.parse(JSONObject("""{"tabs":[$ok]}""")))
    assertNull(DockModel.parse(doc(listOf(tab("a", ""","href":"/a"""")))))
    assertNull(DockModel.parse(null))
  }

  @Test fun dropsTabsThatCannotWorkAndKeepsTheRest() {
    val model = DockModel.parse(
      doc(
        listOf(
          tab("good", ""","href":"/good""""),
          tab("offsite", ""","href":"https://evil.example/x""""),
          tab("protocol", ""","href":"//evil.example""""),
          tab("script", ""","href":"javascript:alert(1)""""),
          tab("nothing", ""),
          tab("missing", ""","sheet":"nope""""),
          tab("menu", ""","sheet":"s""""),
        ),
      ),
    )!!
    assertEquals(listOf("good", "menu"), model.tabs.map { it.id })
  }

  @Test fun rejectsBadIconsAndDuplicateIds() {
    val bad = """{"id":"x","label":"X","icon":{"grid":["01a"]},"href":"/x"}"""
    val empty = """{"id":"y","label":"Y","icon":{"grid":["000"]},"href":"/y"}"""
    val model = DockModel.parse(
      doc(listOf(bad, empty, tab("a", ""","href":"/a""""), tab("a", ""","href":"/other""""), tab("b", ""","href":"/b""""))),
    )!!
    assertEquals(listOf("a", "b"), model.tabs.map { it.id })
    assertEquals("/a", model.tabs[0].href)
  }

  @Test fun dropsUnsafeLinksButKeepsTheSheet() {
    val sheets = """{"s":{"title":"S","sections":[{"id":"a","title":"A","links":[
      {"id":"ok","label":"Fine","href":"/fine"},
      {"id":"abs","label":"Absolute","href":"https://x.example/"},
      {"id":"space","label":"Space","href":"/a b"},
      {"id":"none","label":"None"}]},
      {"id":"empty","title":"Empty","links":[]}]}}"""
    val model = DockModel.parse(doc(listOf(tab("a", ""","href":"/a""""), tab("m", ""","sheet":"s"""")), sheets))!!
    val sections = model.sheets.getValue("s").sections
    assertEquals(1, sections.size)
    assertEquals(listOf("ok"), sections[0].links.map { it.id })
  }

  @Test fun capsTabsAndLabels() {
    val tabs = (1..9).map { tab("t$it", ""","href":"/t$it"""") }
    val model = DockModel.parse(doc(tabs))!!
    assertEquals(6, model.tabs.size)
    val long = """{"id":"l","label":"${"W".repeat(120)}","icon":$icon,"href":"/l"}"""
    assertEquals(80, DockModel.parse(doc(listOf(long, tab("b", ""","href":"/b""""))))!!.tabs[0].label.length)
  }

  @Test fun hrefTabsDefaultToTheirOwnPrefix() {
    val model = DockModel.parse(doc(listOf(tab("a", ""","href":"/actions""""), tab("b", ""","href":"/b""""))))!!
    assertEquals(listOf("/actions"), model.tabs[0].activePrefixes)
  }

  @Test fun theLongestPrefixWinsAndWholeSegmentsOnly() {
    val model = DockModel.fixture()
    assertEquals("state", model.activeTab("/country/us/region/NY/elections")?.id)
    assertEquals("nation", model.activeTab("/country/us/budget")?.id)
    assertEquals("company", model.activeTab("/corporation/7/finance")?.id)
    assertEquals("actions", model.activeTab("/actions")?.id)
    assertEquals("actions", model.activeTab("/actions/")?.id)
    assertEquals("actions", model.activeTab("/actions?tab=1#top")?.id)
    assertNull("a prefix is whole segments", model.activeTab("/country/usa"))
    assertNull("an unclaimed page lights no tab", model.activeTab("/unknown"))
    assertNull(model.activeTab("/profile"))
    assertNull(model.activeTab(null))
    // The game can claim a deeper path for another tab: the longer prefix wins.
    val deeper = DockModel.parse(
      doc(listOf(tab("a", ""","href":"/x","activePrefixes":["/x"]"""), tab("b", ""","href":"/y","activePrefixes":["/x/special"]"""))),
    )!!
    assertEquals("b", deeper.activeTab("/x/special/1")?.id)
    assertEquals("a", deeper.activeTab("/x/other")?.id)
  }

  @Test fun fallbackIsGameBriefingAskMore() {
    val signedOut = DockModel.fallback(signedIn = false)
    assertEquals(listOf("Game", "Briefing", "Ask", "More"), signedOut.tabs.map { it.label })
    assertFalse(signedOut.fromGame)
    val links = signedOut.sheets.getValue("more").sections.single().links
    assertEquals(listOf("Briefing", "Ask", "Back to launcher"), links.map { it.label })
    val signedIn = DockModel.fallback(signedIn = true).sheets.getValue("more").sections.single().links
    assertEquals(listOf("Briefing", "Inbox", "Alerts", "Ask", "Back to launcher"), signedIn.map { it.label })
    // Any game page belongs to the Game tab in the fallback.
    assertEquals("app-game", signedOut.activeTab("/anything/at/all")?.id)
  }

  @Test fun appRowsNeverComeFromTheNetwork() {
    val sheets = """{"more":{"title":"More","sections":[{"id":"x","title":"X","links":[
      {"id":"l","label":"Launcher","href":"app:launcher"}]}]}}"""
    val model = DockModel.parse(doc(listOf(tab("a", ""","href":"/a""""), tab("m", ""","sheet":"more"""")), sheets))!!
    assertTrue(model.sheets.getValue("more").sections.isEmpty())
    assertTrue(model.withApp(true).sheets.getValue("more").sections.flatMap { it.links }.all { it.app != null })
  }

  @Test fun safePathAllowsOnlyBoundedGamePaths() {
    assertEquals("/state/NY?x=1", DockModel.safePath("/state/NY?x=1"))
    assertNull(DockModel.safePath("state/NY"))
    assertNull(DockModel.safePath("//evil"))
    assertNull(DockModel.safePath("/a\\b"))
    assertNull(DockModel.safePath("/" + "a".repeat(400)))
    assertNull(DockModel.safePath(null))
  }
}
