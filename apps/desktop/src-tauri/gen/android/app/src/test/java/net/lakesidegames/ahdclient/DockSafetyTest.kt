package net.lakesidegames.ahdclient

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DockSafetyTest {
  private val icon = """{"grid":["010","111","010"]}"""
  private fun tab(id: String, extra: String) = """{"id":"$id","label":"T$id","icon":$icon$extra}"""

  private fun doc(sections: String, extraTabs: String = "") = JSONObject(
    """{"version":1,"tabs":[${tab("a", ""","href":"/a"""")},${tab("m", ""","sheet":"m"""")}$extraTabs],
       "sheets":{"m":{"title":"M","sections":[$sections]}}}""",
  )

  private fun section(id: String, vararg links: String) = """{"id":"$id","title":"S $id","links":[${links.joinToString(",")}]}"""
  private fun link(id: String, href: String, extra: String = "") = """{"id":"$id","label":"L $id","href":"$href"$extra}"""

  @Test fun idsAreAnyShortStringWithoutControlCharacters() {
    assertEquals("state:overview", DockModel.id("state:overview"))
    assertEquals("menus.staff.adminPanel", DockModel.id("menus.staff.adminPanel"))
    assertEquals("switch-country", DockModel.id("switch-country"))
    assertNull(DockModel.id(""))
    assertNull(DockModel.id(null))
    assertNull(DockModel.id("a".repeat(65)))
    assertEquals("a".repeat(64), DockModel.id("a".repeat(64)))
    assertNull(DockModel.id("bad\u0007id"))
    assertNull(DockModel.id("line\nbreak"))
  }

  @Test fun colonSectionAndLinkIdsParse() {
    val model = DockModel.parse(doc(section("nation:Politics", link("country:US", "/country/us"))))!!
    val sections = model.sheets.getValue("m").sections
    assertEquals(listOf("nation:Politics"), sections.map { it.id })
    assertEquals("country:US", sections[0].links[0].id)
  }

  @Test fun sectionCapCountsOnlySectionsThatSurvive() {
    // 8 dropped sections (no usable links) must not use up places; 20 good ones are cut at 16.
    val dropped = (1..8).map { section("bad$it", link("x", "https://evil.example/")) }
    val good = (1..20).map { section("good$it", link("l", "/p$it")) }
    val model = DockModel.parse(doc((dropped + good).joinToString(",")))!!
    val ids = model.sheets.getValue("m").sections.map { it.id }
    assertEquals(16, ids.size)
    assertEquals("good1", ids.first())
    assertEquals("good16", ids.last())
  }

  @Test fun labelsKeepEightyCharactersForTheViewToEllipsize() {
    val text = "Home nation · United Kingdom · with a very long suffix to test the limit of eighty characters wide"
    val model = DockModel.parse(doc(section("s", """{"id":"l","label":"$text","href":"/x"}""")))!!
    val label = model.sheets.getValue("m").sections[0].links[0].label
    assertEquals(80, label.length)
    assertTrue(text.startsWith(label))
    val cut = DockModel.parse(doc(section("s", """{"id":"l","label":"Home nation · United Kingdom","href":"/x"}""")))!!
    assertEquals("Home nation · United Kingdom", cut.sheets.getValue("m").sections[0].links[0].label)
  }

  @Test fun tabsUseTheShortLabelWhenThereIsOne() {
    val nation = DockModel.parse(
      JSONObject("""{"version":1,"tabs":[{"id":"n","label":"United Kingdom","shortLabel":"UK","icon":$icon,"href":"/n"},${tab("b", ""","href":"/b"""")}],"sheets":{}}"""),
    )!!.tabs[0]
    assertEquals("UK", nation.label)
    assertEquals("United Kingdom", nation.fullLabel)
    val plain = DockModel.parse(
      JSONObject("""{"version":1,"tabs":[{"id":"n","label":"United Kingdom","icon":$icon,"href":"/n"},${tab("b", ""","href":"/b"""")}],"sheets":{}}"""),
    )!!.tabs[0]
    assertEquals("United Kingdom", plain.label)
  }

  @Test fun externalLinksNeedTheFlagAndAnAllowedAddress() {
    val ok = listOf(
      "https://wiki.ahousedividedgame.com", "https://wiki.ahousedividedgame.com/guides/start", "https://discord.gg/DmF8zJJuqN",
      "https://www.patreon.com/cw/AHouseDivided", "https://lakesidegames.net/supporters", "https://docs.lakesidegames.net",
      "mailto:admin@ahousedividedgame.com",
    )
    for (href in ok) assertEquals(href, DockModel.safeExternal(href))
    val bad = listOf(
      "javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "http://wiki.ahousedividedgame.com",
      "https://evil.example/", "https://discord.gg.evil.example/", "https://wiki.ahousedividedgame.com@evil.example/",
      "https://user:pass@discord.gg/x", "https://discord.gg:8443/x", "https://patreon.com/x", "https://ahousedividedgame.com/x",
      "mailto:someone@else.example", "mailto:admin@ahousedividedgame.com?cc=a@b.c", "//discord.gg/x", "/discord",
      "https://discord.gg/a b", "https://discord.gg/\\x", "https://disc\u00f6rd.gg/x", "ftp://discord.gg/x", "", "https://",
    )
    for (href in bad) assertNull("rejected: $href", DockModel.safeExternal(href))
    assertNull(DockModel.safeExternal(null))
    assertNull(DockModel.safeExternal("https://discord.gg/" + "a".repeat(400)))
  }

  @Test fun anOutsideAddressOnlyWorksWithTheExternalFlag() {
    val sections = section(
      "s",
      link("flagged", "https://discord.gg/x", ""","external":true"""),
      link("unflagged", "https://discord.gg/x"),
      link("flaggedBad", "https://evil.example/x", ""","external":true"""),
      link("flaggedPath", "/privacy", ""","external":true"""),
      link("script", "javascript:alert(1)", ""","external":true"""),
      link("game", "/privacy"),
    )
    val links = DockModel.parse(doc(sections))!!.sheets.getValue("m").sections.single().links
    assertEquals(listOf("flagged", "game"), links.map { it.id })
    assertTrue(links[0].external)
    assertFalse(links[1].external)
  }

  @Test fun theGamesNotificationsRowGoesWhenTheAppAddsItsInbox() {
    val withMore = DockModel.parse(
      JSONObject("""{"version":1,"tabs":[${tab("a", ""","href":"/a"""")},${tab("m", ""","sheet":"more"""")}],
        "sheets":{"more":{"title":"More","sections":[${section("a", link("notifications", "/notifications"), link("portfolio", "/portfolio"))},${section("only", link("notifications", "/notifications"))}]}}}"""),
    )!!.withApp(true).sheets.getValue("more").sections
    assertEquals(listOf("app", "a"), withMore.map { it.id })
    assertEquals(listOf("portfolio"), withMore[1].links.map { it.id })
  }
}
