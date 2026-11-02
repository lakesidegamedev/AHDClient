import CryptoKit
import Foundation

// What the game says the dock should contain: GET /api/mobile-dock. The game
// describes the tabs and the sheets behind them; this file only decodes,
// bounds and caches that description. Nothing here draws anything.

/// A pixel icon as the game ships it: rows of "0" and "1".
struct DockIcon: Equatable {
  var name: String
  var grid: [String]

  var columns: Int { grid.map { $0.count }.max() ?? 0 }
  var rows: Int { grid.count }
}

struct DockLink: Equatable, Identifiable {
  var id: String
  var label: String
  var href: String
  var icon: DockIcon?
}

struct DockSection: Equatable, Identifiable {
  var id: String
  var title: String?
  var links: [DockLink]
}

struct DockSheet: Equatable {
  var title: String
  var sections: [DockSection]
}

struct DockTabSpec: Equatable, Identifiable {
  var id: String
  var label: String
  var icon: DockIcon?
  /// A game page the tab opens, or nil for a sheet tab.
  var href: String?
  /// The key into `sheets` for a sheet tab.
  var sheet: String?
  var activePrefixes: [String]
}

struct DockLayout: Equatable {
  var tabs: [DockTabSpec]
  var sheets: [String: DockSheet]
}

// MARK: - Decoding

/// The wire shape. Every field is optional and every list bounded, so a
/// surprising answer degrades to "no dock layout" instead of a crash or a
/// huge allocation. Anything that does not validate is dropped, not repaired.
private struct WireIcon: Decodable {
  var name: String?
  var grid: [String]?
}

private struct WireLink: Decodable {
  var id: String?
  var label: String?
  var href: String?
  var icon: WireIcon?
}

private struct WireSection: Decodable {
  var id: String?
  var title: String?
  var links: [WireLink]?
}

private struct WireSheet: Decodable {
  var title: String?
  var sections: [WireSection]?
}

private struct WireTab: Decodable {
  var id: String?
  var label: String?
  var icon: WireIcon?
  var href: String?
  var sheet: String?
  var activePrefixes: [String]?
}

private struct WireLayout: Decodable {
  var version: Int?
  var tabs: [WireTab]?
  var sheets: [String: WireSheet]?
}

enum DockLayoutCodec {
  static let version = 1
  static let maxBytes = 262_144
  static let maxTabs = 6
  static let minTabs = 2
  static let maxSections = 16
  static let maxLinks = 48
  static let maxGrid = 16

  /// nil when the data is not a layout this app understands (wrong version,
  /// too few tabs, nothing usable): the caller falls back to app tabs.
  static func decode(_ bytes: Data) -> DockLayout? {
    guard bytes.count <= maxBytes, let wire = try? JSONDecoder().decode(WireLayout.self, from: bytes),
      wire.version == version, let rawTabs = wire.tabs else { return nil }

    var sheets = [String: DockSheet]()
    for (key, value) in (wire.sheets ?? [:]).prefix(8) {
      guard key.utf8.count <= 40 else { continue }
      let sections: [DockSection] = (value.sections ?? []).prefix(maxSections).enumerated().compactMap { index, section in
        let links: [DockLink] = (section.links ?? []).prefix(maxLinks).compactMap { link in
          guard let label = clean(link.label, limit: 80), let href = link.href.flatMap(safePath) else { return nil }
          return DockLink(id: clean(link.id, limit: 60) ?? href, label: label, href: href, icon: icon(link.icon))
        }
        guard !links.isEmpty else { return nil }
        return DockSection(id: clean(section.id, limit: 60) ?? "section-\(index)", title: clean(section.title, limit: 60), links: links)
      }
      sheets[key] = DockSheet(title: clean(value.title, limit: 60) ?? "", sections: sections)
    }

    var seen = Set<String>()
    let tabs: [DockTabSpec] = rawTabs.prefix(maxTabs).compactMap { tab in
      guard let id = clean(tab.id, limit: 40), !seen.contains(id), let label = clean(tab.label, limit: 40) else { return nil }
      let href = tab.href.flatMap(safePath)
      let sheet = tab.sheet.flatMap { sheets[$0] != nil ? $0 : nil }
      // A tab must go somewhere: a page, or a sheet that has something in it.
      guard href != nil || sheet != nil else { return nil }
      seen.insert(id)
      let prefixes = (tab.activePrefixes ?? []).prefix(32).compactMap(safePath)
      return DockTabSpec(id: id, label: label, icon: icon(tab.icon), href: sheet == nil ? href : nil, sheet: sheet, activePrefixes: prefixes)
    }
    guard tabs.count >= minTabs else { return nil }
    return DockLayout(tabs: tabs, sheets: sheets)
  }

  private static func clean(_ value: String?, limit: Int) -> String? {
    guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
    let cut = String(value.prefix(limit))
    return cut.rangeOfCharacter(from: .controlCharacters) == nil ? cut : nil
  }

  /// Only a bounded path on the game site: the same rule the status rows use.
  private static func safePath(_ value: String) -> String? { BriefingStore.gamePath(value) }

  private static func icon(_ wire: WireIcon?) -> DockIcon? {
    guard let wire = wire, let grid = wire.grid, !grid.isEmpty, grid.count <= maxGrid else { return nil }
    guard grid.allSatisfy({ $0.count <= maxGrid && $0.allSatisfy { $0 == "0" || $0 == "1" } }) else { return nil }
    guard grid.contains(where: { $0.contains("1") }) else { return nil }
    return DockIcon(name: String((wire.name ?? "icon").prefix(24)), grid: grid)
  }
}

// MARK: - Cache

/// The last good layout per account, so the dock is right the moment the app
/// opens and still right offline. Labels and paths only; no tokens. Kept in
/// the app's own defaults, keyed by a hash of the character name, and trimmed
/// to the few most recent accounts.
enum DockLayoutCache {
  private static let key = "net.lakesidegames.ahdclient.dock-layouts"
  private static let keep = 4
  private struct Entry: Codable { var bytes: Data; var savedAt: Date }

  static func accountKey(_ name: String?) -> String? {
    guard let name = name?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !name.isEmpty else { return nil }
    return SHA256.hash(data: Data(name.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
  }

  static func load(account: String?, defaults: UserDefaults = .standard) -> DockLayout? {
    guard let account, let entry = entries(defaults)[account] else { return nil }
    return DockLayoutCodec.decode(entry.bytes)
  }

  static func save(_ bytes: Data, account: String?, defaults: UserDefaults = .standard) {
    guard let account, bytes.count <= DockLayoutCodec.maxBytes, DockLayoutCodec.decode(bytes) != nil else { return }
    var all = entries(defaults)
    all[account] = Entry(bytes: bytes, savedAt: Date())
    if all.count > keep {
      for stale in all.sorted(by: { $0.value.savedAt < $1.value.savedAt }).prefix(all.count - keep) { all[stale.key] = nil }
    }
    if let data = try? JSONEncoder().encode(all) { defaults.set(data, forKey: key) }
  }

  private static func entries(_ defaults: UserDefaults) -> [String: Entry] {
    guard let data = defaults.data(forKey: key), let value = try? JSONDecoder().decode([String: Entry].self, from: data) else { return [:] }
    return value
  }
}

// MARK: - Fetch

enum DockLayoutClient {
  enum Outcome {
    /// Fresh bytes that decoded to a layout.
    case layout(DockLayout, Data)
    /// 401 or 403: the session is not signed in (as far as the game is concerned).
    case signedOut
    /// 404, an old game, offline, a bad answer: keep whatever is cached.
    case unavailable
  }

  static let endpoint = URL(string: "https://ahousedividedgame.com/api/mobile-dock")!

  /// Never blocks the UI; the completion arrives on the main queue.
  static func fetch(cookie: String, completion: @escaping (Outcome) -> Void) {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 10
    config.timeoutIntervalForResource = 12
    config.httpCookieStorage = nil
    config.urlCache = nil
    let client = URLSession(configuration: config, delegate: NoDockRedirect(), delegateQueue: nil)
    var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
    request.setValue(cookie, forHTTPHeaderField: "Cookie")
    request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    // Labels come back translated for the request locale.
    let languages = Locale.preferredLanguages.prefix(3).joined(separator: ", ")
    if !languages.isEmpty { request.setValue(languages, forHTTPHeaderField: "Accept-Language") }
    client.dataTask(with: request) { bytes, response, _ in
      defer { client.finishTasksAndInvalidate() }
      let outcome: Outcome
      switch (response as? HTTPURLResponse)?.statusCode {
      case 200:
        if let bytes, let layout = DockLayoutCodec.decode(bytes) { outcome = .layout(layout, bytes) } else { outcome = .unavailable }
      case 401, 403:
        outcome = .signedOut
      default:
        outcome = .unavailable
      }
      DispatchQueue.main.async { completion(outcome) }
    }.resume()
  }
}

private final class NoDockRedirect: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}

// MARK: - Fixtures

/// Canned layout for the preview path and tests: the shape the game sends,
/// with a real company and state name. Mirrors the contract in the spec.
enum DockFixture {
  static let json = """
    {
      "version": 1,
      "tabs": [
        { "id": "company", "label": "Hale Industrial", "icon": { "name": "briefcase", "grid": ["00011111000","00010001000","01111111110","01000000010","01000000010","01111111110","01000100010","01000100010","01000000010","01111111110","00000000000"] },
          "href": "/corporation/7", "activePrefixes": ["/corporation/7", "/corporations"] },
        { "id": "state", "label": "New York", "icon": { "name": "capitol", "grid": ["00000100000","00011111000","01111111110","00000000000","01010101010","01010101010","01010101010","01010101010","00000000000","01111111110","11111111111"] },
          "sheet": "state", "activePrefixes": ["/", "/state/NY", "/legislature"] },
        { "id": "nation", "label": "Nation", "icon": { "name": "globe", "grid": ["00011111000","00100000100","01001010010","10001010001","10001010001","11111111111","10001010001","10001010001","01001010010","00100000100","00011111000"] },
          "sheet": "nation", "activePrefixes": ["/country", "/elections", "/wars"] },
        { "id": "actions", "label": "Actions", "icon": { "name": "bolt", "grid": ["00000111000","00001110000","00011100000","00111000000","01111111100","00000111000","00001110000","00011100000","00111000000","01110000000","00000000000"] },
          "href": "/actions", "activePrefixes": ["/actions"] },
        { "id": "more", "label": "More", "icon": { "name": "gear", "grid": ["00011011000","00111111100","01100000110","11001110011","11001010011","01101110110","01100000110","11000000011","01111111110","00110101100","00000000000"] },
          "sheet": "more", "activePrefixes": ["/profile", "/settings", "/notifications", "/portfolio"] }
      ],
      "sheets": {
        "state": { "title": "New York", "sections": [
          { "id": "government", "title": "Government", "links": [
            { "id": "legislature", "label": "Legislature", "href": "/legislature", "icon": { "name": "vote", "grid": ["00000000000","00011111000","00010001000","00010101000","00011001000","00010001000","00111111100","01100000110","01000000010","01111111110","00000000000"] } },
            { "id": "governor", "label": "Governor", "href": "/state/NY/governor" },
            { "id": "courts", "label": "Courts", "href": "/state/NY/courts" } ] },
          { "id": "economy", "title": "Economy", "links": [
            { "id": "budget", "label": "State budget", "href": "/state/NY/budget" },
            { "id": "markets", "label": "Markets", "href": "/markets" } ] } ] },
        "nation": { "title": "Nation", "sections": [
          { "id": "politics", "title": "Politics", "links": [
            { "id": "elections", "label": "Elections", "href": "/elections" },
            { "id": "parties", "label": "Parties", "href": "/parties" },
            { "id": "congress", "label": "Congress", "href": "/congress" } ] },
          { "id": "world", "title": "World", "links": [
            { "id": "countries", "label": "Countries", "href": "/countries" },
            { "id": "wars", "label": "Wars", "href": "/wars" } ] } ] },
        "more": { "title": "More", "sections": [
          { "id": "you", "title": "You", "links": [
            { "id": "profile", "label": "Profile", "href": "/profile" },
            { "id": "portfolio", "label": "Portfolio", "href": "/portfolio" },
            { "id": "settings", "label": "Settings", "href": "/settings" } ] },
          { "id": "community", "title": "Community", "links": [
            { "id": "wiki", "label": "Wiki", "href": "/wiki" },
            { "id": "support", "label": "Support", "href": "/support" } ] } ] }
      }
    }
    """

  static var layout: DockLayout { DockLayoutCodec.decode(Data(json.utf8)) ?? DockLayout(tabs: [], sheets: [:]) }
}
