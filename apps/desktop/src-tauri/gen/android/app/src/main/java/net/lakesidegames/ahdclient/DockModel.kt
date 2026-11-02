package net.lakesidegames.ahdclient

import org.json.JSONArray
import org.json.JSONObject

/**
 * What the dock's tab row and menu sheets show. The game describes them at
 * `GET /api/mobile-dock` (version 1); the app only draws them. Pure Kotlin plus
 * org.json so the parsing, the safety checks and the fallback are unit tested
 * on the JVM.
 *
 * Everything from the network is checked here: sizes are capped, links must
 * be paths on the game site, icons must be small grids of 0 and 1. Anything
 * that fails drops that tab, section or link rather than the whole dock, and a
 * model with too little left is rejected so the app falls back.
 */

/** Pixel art in the game's PixelNavIcon shape: rows of "0" and "1". */
data class PixelIcon(val rows: List<String>) {
  val height: Int get() = rows.size
  val width: Int get() = rows.maxOfOrNull { it.length } ?: 0
  fun filled(x: Int, y: Int): Boolean = rows.getOrNull(y)?.getOrNull(x) == '1'

  companion object {
    private const val MAX_SIZE = 32

    fun parse(raw: JSONObject?): PixelIcon? {
      val grid = raw?.optJSONArray("grid") ?: return null
      if (grid.length() == 0 || grid.length() > MAX_SIZE) return null
      val rows = ArrayList<String>(grid.length())
      for (index in 0 until grid.length()) {
        val row = grid.optString(index, "")
        if (row.isEmpty() || row.length > MAX_SIZE || row.any { it != '0' && it != '1' }) return null
        rows.add(row)
      }
      return PixelIcon(rows).takeIf { it.rows.any { row -> '1' in row } }
    }
  }
}

/** Things only the app can do, so only app-built menu rows carry one. */
enum class AppAction { BRIEFING, INBOX, ASK, LAUNCHER }

data class DockLink(
  val id: String,
  val label: String,
  /** A path on the game site, or null for an app action. */
  val href: String?,
  val icon: PixelIcon? = null,
  val app: AppAction? = null,
)

data class DockSection(val id: String, val title: String, val links: List<DockLink>)

data class DockSheet(val title: String, val sections: List<DockSection>)

data class DockTab(
  val id: String,
  val label: String,
  val icon: PixelIcon,
  /** Tapping opens this game path... */
  val href: String? = null,
  /** ...or opens the menu sheet with this key. */
  val sheet: String? = null,
  /** ...or runs this app action (only the fallback tabs). */
  val app: AppAction? = null,
  val activePrefixes: List<String> = emptyList(),
)

class DockModel(val tabs: List<DockTab>, val sheets: Map<String, DockSheet>, val fromGame: Boolean) {
  fun tab(id: String?): DockTab? = tabs.firstOrNull { it.id == id }

  /**
   * The tab a game path belongs to: the one with the longest matching prefix
   * ("/state/NY" beats "/state"). A prefix matches a whole path segment, so
   * "/state" does not claim "/statements". Null when nothing claims the path.
   */
  fun activeTab(path: String?): DockTab? {
    val clean = path?.substringBefore('?')?.substringBefore('#')?.takeIf { it.startsWith("/") } ?: return null
    var best: DockTab? = null
    var bestLength = -1
    for (tab in tabs) {
      for (prefix in tab.activePrefixes) {
        val trimmed = prefix.trimEnd('/')
        val hit = trimmed.isEmpty() || clean == trimmed || clean.startsWith("$trimmed/")
        if (hit && trimmed.length > bestLength) { best = tab; bestLength = trimmed.length }
      }
    }
    return best
  }

  /**
   * The model with the app's own section first in the More sheet: Briefing,
   * Inbox (only when signed in), Ask and Back to launcher. The More tab is
   * the one whose sheet key is "more".
   */
  fun withApp(signedIn: Boolean): DockModel {
    val existing = sheets["more"]
    val sections = listOf(appSection(signedIn)) + (existing?.sections ?: emptyList())
    val merged = sheets + ("more" to DockSheet(existing?.title ?: MORE_LABEL, sections))
    return DockModel(tabs, merged, fromGame)
  }

  companion object {
    const val MORE_LABEL = "More"
    const val APP_SECTION_ID = "app"
    private const val APP_SECTION_TITLE = "App"
    private const val MAX_TABS = 6
    private const val MAX_SECTIONS = 12
    private const val MAX_LINKS = 40
    private const val MAX_LABEL = 28
    private const val MAX_PREFIXES = 24

    /** The game's own paths only: bounded, absolute, no scheme, no host, no whitespace. */
    fun safePath(value: String?): String? = value?.takeIf { path ->
      path.length <= 300 && path.startsWith("/") && !path.startsWith("//") &&
        path.none { it == '\\' || it.isWhitespace() || it.isISOControl() }
    }

    private fun label(value: String?): String? =
      value?.trim()?.takeIf { it.isNotEmpty() && it != "null" }?.take(MAX_LABEL)

    private fun id(value: String?): String? =
      value?.takeIf { it.isNotEmpty() && it.length <= 64 && it.all { c -> c.isLetterOrDigit() || c == '-' || c == '_' || c == '.' } }

    /** Null when the document is not a version 1 dock with at least two usable tabs. */
    fun parse(raw: JSONObject?): DockModel? {
      if (raw == null || raw.optInt("version", -1) != 1) return null
      val sheetsRaw = raw.optJSONObject("sheets")
      val sheets = LinkedHashMap<String, DockSheet>()
      if (sheetsRaw != null) {
        for (key in sheetsRaw.keys()) {
          if (id(key) == null) continue
          parseSheet(sheetsRaw.optJSONObject(key))?.let { sheets[key] = it }
        }
      }
      val tabsRaw = raw.optJSONArray("tabs") ?: return null
      val tabs = ArrayList<DockTab>()
      for (index in 0 until tabsRaw.length()) {
        if (tabs.size >= MAX_TABS) break
        val tab = parseTab(tabsRaw.optJSONObject(index), sheets) ?: continue
        if (tabs.none { it.id == tab.id }) tabs.add(tab)
      }
      if (tabs.size < 2) return null
      val used = tabs.mapNotNull { it.sheet }.toSet()
      return DockModel(tabs, sheets.filterKeys { it in used }, fromGame = true)
    }

    private fun parseTab(raw: JSONObject?, sheets: Map<String, DockSheet>): DockTab? {
      raw ?: return null
      val id = id(raw.optString("id")) ?: return null
      val label = label(raw.optString("label")) ?: return null
      val icon = PixelIcon.parse(raw.optJSONObject("icon")) ?: return null
      val href = safePath(raw.optString("href").takeIf { raw.has("href") && !raw.isNull("href") })
      val sheet = raw.optString("sheet").takeIf { raw.has("sheet") && !raw.isNull("sheet") && it.isNotEmpty() }
      // A tab opens a page or a sheet. A sheet tab whose sheet did not survive has nothing to show.
      if (sheet != null && sheet !in sheets) return null
      if (sheet == null && href == null) return null
      val prefixes = ArrayList<String>()
      val rawPrefixes = raw.optJSONArray("activePrefixes")
      if (rawPrefixes != null) {
        for (i in 0 until minOf(rawPrefixes.length(), MAX_PREFIXES)) {
          safePath(rawPrefixes.optString(i, ""))?.let { prefixes.add(it) }
        }
      }
      if (href != null && prefixes.isEmpty()) prefixes.add(href)
      return DockTab(id, label, icon, href = if (sheet == null) href else null, sheet = sheet, activePrefixes = prefixes)
    }

    private fun parseSheet(raw: JSONObject?): DockSheet? {
      raw ?: return null
      val title = label(raw.optString("title")) ?: ""
      val sectionsRaw = raw.optJSONArray("sections") ?: return null
      val sections = ArrayList<DockSection>()
      for (index in 0 until minOf(sectionsRaw.length(), MAX_SECTIONS)) {
        val section = sectionsRaw.optJSONObject(index) ?: continue
        val sectionId = id(section.optString("id")) ?: continue
        val links = ArrayList<DockLink>()
        val linksRaw = section.optJSONArray("links") ?: JSONArray()
        for (i in 0 until minOf(linksRaw.length(), MAX_LINKS)) {
          val link = linksRaw.optJSONObject(i) ?: continue
          val linkId = id(link.optString("id")) ?: continue
          val linkLabel = label(link.optString("label")) ?: continue
          val href = safePath(link.optString("href")) ?: continue
          links.add(DockLink(linkId, linkLabel, href, PixelIcon.parse(link.optJSONObject("icon"))))
        }
        if (links.isNotEmpty()) sections.add(DockSection(sectionId, label(section.optString("title")) ?: "", links))
      }
      return DockSheet(title, sections)
    }

    // ---- the app's own pieces -------------------------------------------------

    val GAME_ICON = grid(
      "00000100000", "00001110000", "00011111000", "00111111100", "01111111110", "11111111111",
      "01110001110", "01110001110", "01110001110", "01110001110", "00000000000",
    )
    val BRIEFING_ICON = grid(
      "01111111100", "01000000100", "01011110100", "01000000100", "01011110100", "01000000100",
      "01011110100", "01000000100", "01111111100", "00000000000", "00000000000",
    )
    val INBOX_ICON = grid(
      "00000000000", "11111111111", "11000000011", "10100000101", "10010001001", "10001010001",
      "10000100001", "10000000001", "11111111111", "00000000000", "00000000000",
    )
    val ASK_ICON = grid(
      "01111111110", "10000000001", "10000000001", "10010101001", "10000000001", "10000000001",
      "01111111110", "00011000000", "00010000000", "00100000000", "00000000000",
    )
    val MORE_ICON = grid(
      "00000000000", "00000000000", "00000000000", "11101110111", "11101110111", "11101110111",
      "00000000000", "00000000000", "00000000000", "00000000000", "00000000000",
    )
    val LAUNCHER_ICON = grid(
      "00000100000", "00001100000", "00011100000", "00111111111", "01111111111", "00111111111",
      "00011100000", "00001100000", "00000100000", "00000000000", "00000000000",
    )

    private fun grid(vararg rows: String) = PixelIcon(rows.toList())

    fun appSection(signedIn: Boolean): DockSection {
      val links = ArrayList<DockLink>()
      links.add(DockLink("app-briefing", "Briefing", null, BRIEFING_ICON, AppAction.BRIEFING))
      if (signedIn) links.add(DockLink("app-inbox", "Inbox", null, INBOX_ICON, AppAction.INBOX))
      links.add(DockLink("app-ask", "Ask", null, ASK_ICON, AppAction.ASK))
      links.add(DockLink("app-launcher", "Back to launcher", null, LAUNCHER_ICON, AppAction.LAUNCHER))
      return DockSection(APP_SECTION_ID, APP_SECTION_TITLE, links)
    }

    /**
     * Signed out, offline, or a game that predates the endpoint: Game, Briefing,
     * Ask and More, so the player is never stuck. More holds the app section only.
     */
    fun fallback(signedIn: Boolean): DockModel {
      val tabs = listOf(
        DockTab("app-game", "Game", GAME_ICON, href = "/", activePrefixes = listOf("/")),
        DockTab("app-briefing", "Briefing", BRIEFING_ICON, app = AppAction.BRIEFING),
        DockTab("app-ask", "Ask", ASK_ICON, app = AppAction.ASK),
        DockTab("app-more", "More", MORE_ICON, sheet = "more"),
      )
      return DockModel(tabs, emptyMap(), fromGame = false).withApp(signedIn)
    }

    /** Canned model for the screenshot preview link, in the shape the game serves. */
    fun fixture(): DockModel = parse(JSONObject(FIXTURE_JSON))!!.withApp(true)

    private const val FACTORY = """["00000000000","00100000000","00100000000","00100010001","01100110011","01101111111","01111111111","01111111111","01111111111","01111111111","00000000000"]"""
    private const val CAPITOL = """["00000100000","00001110000","00011111000","00111111100","11111111111","01010101010","01010101010","01010101010","01010101010","11111111111","00000000000"]"""
    private const val FLAG = """["01000000000","01111111000","01111111100","01111111000","01111111100","01111111000","01000000000","01000000000","01000000000","01000000000","01000000000"]"""
    private const val BOLT = """["00000111100","00001111000","00011110000","00111100000","01111111100","00001111000","00011110000","00011100000","00111000000","00110000000","00100000000"]"""
    private const val DOTS = """["00000000000","00000000000","00000000000","11101110111","11101110111","11101110111","00000000000","00000000000","00000000000","00000000000","00000000000"]"""
    private const val CHART = """["00000000000","00000000011","00000000011","00000110011","00000110011","00110110011","00110110011","00110110011","11111111111","00000000000","00000000000"]"""
    private const val PEOPLE = """["00000000000","00110001100","01111011110","01111011110","00110001100","01111111110","11111111111","11111111111","00000000000","00000000000","00000000000"]"""

    private val FIXTURE_JSON = """
      {"version":1,
       "tabs":[
         {"id":"company","label":"Acme Corp","icon":{"name":"factory","grid":$FACTORY},"href":"/corporation/7","activePrefixes":["/corporation/7","/corporation"]},
         {"id":"state","label":"New York","icon":{"name":"capitol","grid":$CAPITOL},"sheet":"state","activePrefixes":["/state/NY","/state"]},
         {"id":"nation","label":"United States","icon":{"name":"flag","grid":$FLAG},"sheet":"nation","activePrefixes":["/country","/nation"]},
         {"id":"actions","label":"Actions","icon":{"name":"bolt","grid":$BOLT},"href":"/actions","activePrefixes":["/actions"]},
         {"id":"more","label":"More","icon":{"name":"more","grid":$DOTS},"sheet":"more","activePrefixes":["/profile","/settings"]}],
       "sheets":{
         "state":{"title":"New York","sections":[
           {"id":"politics","title":"Politics","links":[
             {"id":"state-home","label":"State overview","href":"/state/NY","icon":{"grid":$CAPITOL}},
             {"id":"elections","label":"Elections","href":"/state/NY/elections"},
             {"id":"legislature","label":"Legislature","href":"/state/NY/legislature"},
             {"id":"parties","label":"Parties","href":"/state/NY/parties","icon":{"grid":$PEOPLE}}]},
           {"id":"economy","title":"Economy","links":[
             {"id":"state-market","label":"State market","href":"/state/NY/market","icon":{"grid":$CHART}},
             {"id":"state-budget","label":"State budget","href":"/state/NY/budget"}]}]},
         "nation":{"title":"United States","sections":[
           {"id":"government","title":"Government","links":[
             {"id":"nation-home","label":"National overview","href":"/country/US","icon":{"grid":$FLAG}},
             {"id":"congress","label":"Congress","href":"/country/US/congress"},
             {"id":"presidency","label":"Presidency","href":"/country/US/presidency"}]},
           {"id":"world","title":"World","links":[
             {"id":"diplomacy","label":"Diplomacy","href":"/country/US/diplomacy"},
             {"id":"wars","label":"Conflicts","href":"/wars"}]}]},
         "more":{"title":"More","sections":[
           {"id":"you","title":"You","links":[
             {"id":"profile","label":"Profile","href":"/profile","icon":{"grid":$PEOPLE}},
             {"id":"wealth","label":"Wealth","href":"/profile/wealth","icon":{"grid":$CHART}},
             {"id":"settings","label":"Settings","href":"/settings"}]},
           {"id":"community","title":"Community","links":[
             {"id":"leaderboard","label":"Leaderboard","href":"/leaderboard"},
             {"id":"support","label":"Support","href":"/support"}]}]}}}
    """.trimIndent()
  }
}
