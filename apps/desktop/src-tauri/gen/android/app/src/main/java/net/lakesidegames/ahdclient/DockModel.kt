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
  /** A path on the game site, an allow-listed outside address when [external], or null for an app action. */
  val href: String?,
  val icon: PixelIcon? = null,
  val app: AppAction? = null,
  /** Opens outside the game WebView (browser or mail app), never inside it. */
  val external: Boolean = false,
)

data class DockSection(val id: String, val title: String, val links: List<DockLink>)

data class DockSheet(val title: String, val sections: List<DockSection>)

data class DockTab(
  val id: String,
  /** What the tab shows: the game's short label when it sends one, else its label. */
  val label: String,
  val icon: PixelIcon,
  /** Tapping opens this game path... */
  val href: String? = null,
  /** ...or opens the menu sheet with this key. */
  val sheet: String? = null,
  /** ...or runs this app action (only the fallback tabs). */
  val app: AppAction? = null,
  val activePrefixes: List<String> = emptyList(),
  /** The full label, for screen readers and sheet titles. */
  val fullLabel: String = label,
)

class DockModel(val tabs: List<DockTab>, val sheets: Map<String, DockSheet>, val fromGame: Boolean) {
  fun tab(id: String?): DockTab? = tabs.firstOrNull { it.id == id }

  /**
   * The tab a game path belongs to: the one with the longest matching prefix
   * ("/country/us/region/NY" beats "/country/us"). A prefix matches whole path
   * segments, so "/country/us" does not claim "/country/usa"; query and hash
   * are ignored. Null when nothing claims the path (no tab lights).
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
   * the one whose sheet key is "more". The game's own Notifications link is
   * dropped there: the app's Inbox row opens the same page.
   */
  fun withApp(signedIn: Boolean): DockModel {
    val existing = sheets["more"]
    val game = existing?.sections.orEmpty().mapNotNull { section ->
      val links = section.links.filter { it.id != DUPLICATE_INBOX_ID }
      if (links.isEmpty()) null else if (links.size == section.links.size) section else DockSection(section.id, section.title, links)
    }
    val sections = listOf(appSection(signedIn)) + game
    val merged = sheets + ("more" to DockSheet(existing?.title ?: MORE_LABEL, sections))
    return DockModel(tabs, merged, fromGame)
  }

  companion object {
    const val MORE_LABEL = "More"
    const val APP_SECTION_ID = "app"
    private const val APP_SECTION_TITLE = "App"
    private const val DUPLICATE_INBOX_ID = "notifications"
    private const val MAX_TABS = 6
    private const val MAX_SECTIONS = 16
    private const val MAX_SECTIONS_SCANNED = 64
    private const val MAX_LINKS = 40
    private const val MAX_LABEL = 80
    private const val MAX_ID = 64
    private const val MAX_PREFIXES = 24
    private const val MAX_HREF = 300

    /** The only outside places a menu row may open: https on these hosts, and the support address. */
    private val EXTERNAL_HOSTS = setOf(
      "wiki.ahousedividedgame.com", "discord.gg", "www.patreon.com", "lakesidegames.net", "docs.lakesidegames.net",
    )
    const val SUPPORT_MAILTO = "mailto:admin@ahousedividedgame.com"

    /** The game's own paths only: bounded, absolute, no scheme, no host, no whitespace. */
    fun safePath(value: String?): String? = value?.takeIf { path ->
      path.length <= MAX_HREF && path.startsWith("/") && !path.startsWith("//") &&
        path.none { it == '\\' || it.isWhitespace() || it.isISOControl() }
    }

    private fun label(value: String?): String? =
      value?.trim()?.takeIf { it.isNotEmpty() && it != "null" }?.take(MAX_LABEL)

    /** Ids are only view keys: any non-empty string up to 64 characters without control characters ("state:overview" is real). */
    fun id(value: String?): String? =
      value?.takeIf { it.isNotEmpty() && it.length <= MAX_ID && it.none { c -> c.isISOControl() } }

    /**
     * An address a menu row may open outside the game: https on the allow-listed
     * hosts (no credentials, default port, plain ASCII) or the support mail
     * link. Anything else, javascript: data: file: or another host, is null.
     */
    fun safeExternal(value: String?): String? {
      val text = value ?: return null
      if (text.length > MAX_HREF || text.any { it == '\\' || it.isWhitespace() || it.isISOControl() || it.code > 126 }) return null
      if (text.equals(SUPPORT_MAILTO, ignoreCase = true)) return SUPPORT_MAILTO
      val uri = try { java.net.URI(text) } catch (_: java.net.URISyntaxException) { return null }
      if (!uri.scheme.equals("https", ignoreCase = true) || uri.rawUserInfo != null) return null
      if (uri.port != -1 && uri.port != 443) return null
      val host = uri.host?.lowercase() ?: return null
      return text.takeIf { host in EXTERNAL_HOSTS }
    }

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
      val full = label(raw.optString("label")) ?: return null
      // The game may send a short label for the tab ("Nation"); the full one stays for titles and screen readers.
      val label = label(raw.optString("shortLabel")) ?: full
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
      return DockTab(id, label, icon, href = if (sheet == null) href else null, sheet = sheet, activePrefixes = prefixes, fullLabel = full)
    }

    private fun parseSheet(raw: JSONObject?): DockSheet? {
      raw ?: return null
      val title = label(raw.optString("title")) ?: ""
      val sectionsRaw = raw.optJSONArray("sections") ?: return null
      val sections = ArrayList<DockSection>()
      // The cap counts sections that survive: one dropped section never costs another its place.
      for (index in 0 until minOf(sectionsRaw.length(), MAX_SECTIONS_SCANNED)) {
        if (sections.size >= MAX_SECTIONS) break
        val section = sectionsRaw.optJSONObject(index) ?: continue
        val sectionId = id(section.optString("id")) ?: continue
        val links = ArrayList<DockLink>()
        val linksRaw = section.optJSONArray("links") ?: JSONArray()
        for (i in 0 until minOf(linksRaw.length(), MAX_LINKS)) {
          val link = linksRaw.optJSONObject(i) ?: continue
          parseLink(link)?.let { links.add(it) }
        }
        if (links.isNotEmpty()) sections.add(DockSection(sectionId, label(section.optString("title")) ?: "", links))
      }
      return DockSheet(title, sections)
    }

    private fun parseLink(link: JSONObject): DockLink? {
      val linkId = id(link.optString("id")) ?: return null
      val linkLabel = label(link.optString("label")) ?: return null
      val rawHref = link.optString("href").takeIf { link.has("href") && !link.isNull("href") }
      val external = link.optBoolean("external", false)
      // Game pages are paths; an outside address needs the flag and the allow list. Nothing else gets through.
      val href = (if (external) safeExternal(rawHref) else safePath(rawHref)) ?: return null
      return DockLink(linkId, linkLabel, href, PixelIcon.parse(link.optJSONObject("icon")), external = external)
    }

    // ---- the app's own pieces -------------------------------------------------

    // 11x11 grids in the game's PixelNavIcon style, drawn as crisp squares like every other icon.
    // The same grids are used by the iOS dock so both platforms look alike (misc archive: app-row-icons.json).
    val GAME_ICON = grid("00000100000", "00011111000", "01111111110", "00000000000", "01010101010", "01010101010", "01010101010", "01010101010", "00000000000", "01111111110", "11111111111")
    val BRIEFING_ICON = grid("00000000000", "01111111110", "01000000010", "01011111010", "01000000010", "01011111010", "01000000010", "01011111010", "01000000010", "01111111110", "00000000000")
    val INBOX_ICON = grid("00000000000", "00000000000", "01111111110", "01100000110", "01010001010", "01001010010", "01000100010", "01000000010", "01111111110", "00000000000", "00000000000")
    val ASK_ICON = grid("00000000000", "01111111110", "01000000010", "01001110010", "01000010010", "01000100010", "01000000010", "01000100010", "01111111110", "00011000000", "00100000000")
    val MORE_ICON = grid("00000000000", "01111011110", "01111011110", "01111011110", "01111011110", "00000000000", "01111011110", "01111011110", "01111011110", "01111011110", "00000000000")
    val LAUNCHER_ICON = grid("00000100000", "00001010000", "00010001000", "00100000100", "01111111110", "00100000100", "00100000100", "00100100100", "00100100100", "00111111100", "00000000000")
    val CLOCK_ICON = grid("00011111000", "00100000100", "01000000010", "10000100001", "10000100001", "10000111001", "10000000001", "01000000010", "00100000100", "00011111000", "00000000000")
    val FUNDS_ICON = grid("00000000000", "00000000000", "11111111111", "10000000001", "10001110001", "10001010001", "10001110001", "10000000001", "11111111111", "00000000000", "00000000000")
    val ACTIONS_ICON = grid("00000111000", "00001110000", "00011100000", "00111000000", "01111111100", "00000111000", "00001110000", "00011100000", "00111000000", "01110000000", "00000000000")
    val CHEVRON_ICON = grid("00000000000", "00000000000", "00000000000", "00000100000", "00001010000", "00010001000", "00100000100", "01000000010", "00000000000", "00000000000", "00000000000")

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

    /**
     * Canned model for the screenshot preview link, in the shape the game serves:
     * a "Company" tab, a short "Nation" label, section ids with colons, rows with
     * and without icons, outside links and the game's own Notifications row.
     */
    fun fixture(): DockModel = parse(JSONObject(FIXTURE_JSON))!!.withApp(true)

    private const val G_BRIEFCASE = """["00011111000","00010001000","01111111110","01000000010","01000000010","01111111110","01000100010","01000100010","01000000010","01111111110","00000000000"]"""
    private const val G_MAP = """["00000000000","01100111110","01011100010","01001010010","01001010010","01001010010","01001010010","01001010010","01111011110","00000000000","00000000000"]"""
    private const val G_FLAG = """["01111111100","01000000100","01000000100","01111111100","01000000000","01000000000","01000000000","01000000000","01000000000","01000000000","00000000000"]"""
    private const val G_BOLT = """["00000111000","00001110000","00011100000","00111000000","01111111100","00000111000","00001110000","00011100000","00111000000","01110000000","00000000000"]"""
    private const val G_APPS = """["00000000000","01111011110","01111011110","01111011110","01111011110","00000000000","01111011110","01111011110","01111011110","01111011110","00000000000"]"""
    private const val G_CAPITOL = """["00000100000","00011111000","01111111110","00000000000","01010101010","01010101010","01010101010","01010101010","00000000000","01111111110","11111111111"]"""
    private const val G_CHART = """["00000000000","00000000110","00000000110","00001100110","00001100110","11001100110","11001100110","11001100110","11001100110","00000000000","11111111111"]"""
    private const val G_PEOPLE = """["00110001100","01111011110","01111011110","00110001100","00000000000","01111011110","11111111111","10001110001","10001110001","00000000000","00000000000"]"""
    private const val G_BANK = """["00000100000","00011111000","01111111110","11111111111","00000000000","01100100110","01100100110","01100100110","01100100110","00000000000","11111111111"]"""
    private const val G_GEAR = """["00011011000","00111111100","01100000110","11001110011","11001010011","01101110110","01100000110","11000000011","01111111110","00110101100","00000000000"]"""
    private const val G_BOOK = """["00000000000","01111011110","01000100010","01000100010","01000100010","01000100010","01000100010","01000100010","01111111110","00000100000","00000000000"]"""
    private const val G_BELL = """["00000100000","00011111000","00100000100","00100000100","00100000100","00100000100","01000000010","01111111110","00000000000","00001110000","00000000000"]"""

    private val FIXTURE_JSON = """
      {"version":1,
       "tabs":[
         {"id":"company","label":"Company","icon":{"name":"briefcase","grid":$G_BRIEFCASE},"href":"/corporation/7","activePrefixes":["/corporation/7"]},
         {"id":"state","label":"New York","icon":{"name":"map","grid":$G_MAP},"sheet":"state","activePrefixes":["/country/us/region/NY"]},
         {"id":"nation","label":"United States","shortLabel":"Nation","icon":{"name":"flag","grid":$G_FLAG},"sheet":"nation","activePrefixes":["/country/us"]},
         {"id":"actions","label":"Actions","icon":{"name":"bolt","grid":$G_BOLT},"href":"/actions","activePrefixes":["/actions"]},
         {"id":"more","label":"More","icon":{"name":"apps","grid":$G_APPS},"sheet":"more","activePrefixes":[]}],
       "sheets":{
         "state":{"title":"New York","sections":[
           {"id":"state:overview","title":"New York","links":[
             {"id":"overview","label":"Overview","href":"/country/us/region/NY","icon":{"grid":$G_CAPITOL}}]},
           {"id":"state:politics","title":"Politics","links":[
             {"id":"stateParty","label":"New York · Democratic-Republican Party","href":"/country/us/region/NY/party/1","icon":{"grid":$G_FLAG}},
             {"id":"elections","label":"Elections","href":"/country/us/region/NY?tab=politics&sub=elections","icon":{"grid":$G_PEOPLE}},
             {"id":"legislature","label":"Legislature","href":"/country/us/region/NY/legislature"},
             {"id":"governor","label":"Governor","href":"/country/us/region/NY/governor"},
             {"id":"courts","label":"Courts","href":"/country/us/region/NY/courts"}]},
           {"id":"state:economy","title":"Economy","links":[
             {"id":"economy","label":"State economy","href":"/country/us/region/NY?tab=economy","icon":{"grid":$G_CHART}},
             {"id":"budget","label":"State budget","href":"/country/us/region/NY/budget"}]}]},
         "nation":{"title":"United States","sections":[
           {"id":"switch-country","title":"View another country","links":[
             {"id":"country:US","label":"United States","href":"/country/us","icon":{"grid":$G_FLAG}},
             {"id":"country:UK","label":"United Kingdom","href":"/country/uk","icon":{"grid":$G_FLAG}}]},
           {"id":"nation:Government","title":"Government","links":[
             {"id":"legislature","label":"Legislature","href":"/country/us/legislature","icon":{"grid":$G_CAPITOL}},
             {"id":"executive","label":"Executive","href":"/country/us/executive","icon":{"grid":$G_CAPITOL}},
             {"id":"policy","label":"Policy","href":"/country/us/policy"}]},
           {"id":"nation:Economy","title":"Economy","links":[
             {"id":"centralBank","label":"Central bank","href":"/banking","icon":{"grid":$G_BANK}},
             {"id":"economy","label":"Economy","href":"/country/us/economy","icon":{"grid":$G_CHART}},
             {"id":"budget","label":"National budget","href":"/country/us/budget"}]}]},
         "more":{"title":"Everything","sections":[
           {"id":"you:you","title":"Profile","links":[
             {"id":"notifications","label":"Notifications (3)","href":"/notifications","icon":{"grid":$G_BELL}},
             {"id":"portfolio","label":"Portfolio","href":"/portfolio","icon":{"grid":$G_BANK}},
             {"id":"settings","label":"Settings","href":"/settings","icon":{"grid":$G_GEAR}}]},
           {"id":"help:community","title":"Community","links":[
             {"id":"discord","label":"Discord","href":"https://discord.gg/DmF8zJJuqN","external":true,"icon":{"grid":$G_BOOK}},
             {"id":"patreon","label":"Patreon","href":"https://www.patreon.com/cw/AHouseDivided","external":true,"icon":{"grid":$G_BOOK}}]},
           {"id":"help:support","title":"Support","links":[
             {"id":"support","label":"Email support","href":"mailto:admin@ahousedividedgame.com","external":true,"icon":{"grid":$G_BOOK}},
             {"id":"privacy","label":"Privacy","href":"/privacy"}]}]}}}
    """.trimIndent()
  }
}
