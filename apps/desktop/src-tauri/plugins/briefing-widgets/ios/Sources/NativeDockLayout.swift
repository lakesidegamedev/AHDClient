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
  /// A game path, or for an external link the allow-listed absolute URL.
  var href: String
  var icon: DockIcon?
  /// Opens outside the game webview (Safari sheet or the mail app).
  var external = false
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
  /// The game's short label when it sends one (the Nation tab), else its label.
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
  var external: Bool?
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
  var shortLabel: String?
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
  /// Caps are counted after filtering; the raw lists are bounded separately so
  /// a huge answer cannot make the filter itself expensive.
  static let maxSections = 16
  static let maxLinks = 48
  static let maxGrid = 16
  static let maxLabel = 80
  static let maxID = 64

  /// nil when the data is not a layout this app understands (wrong version,
  /// too few tabs, nothing usable): the caller falls back to app tabs.
  static func decode(_ bytes: Data) -> DockLayout? {
    guard bytes.count <= maxBytes, let wire = try? JSONDecoder().decode(WireLayout.self, from: bytes),
      wire.version == version, let rawTabs = wire.tabs else { return nil }

    // Only the sheets some tab points at are worth decoding.
    let wanted = Set(rawTabs.prefix(maxTabs).compactMap { $0.sheet })
    var sheets = [String: DockSheet]()
    for key in wanted {
      guard key.utf8.count <= 40, let value = wire.sheets?[key] else { continue }
      var sectionIDs = Set<String>()
      var sections = [DockSection]()
      for (index, section) in (value.sections ?? []).prefix(maxSections * 4).enumerated() {
        var linkIDs = Set<String>()
        var links = [DockLink]()
        for link in (section.links ?? []).prefix(maxLinks * 2) {
          guard let built = self.link(link) else { continue }
          var made = built
          made.id = unique(built.id, in: &linkIDs)
          links.append(made)
          if links.count == maxLinks { break }
        }
        guard !links.isEmpty else { continue }
        sections.append(DockSection(id: unique(cleanID(section.id) ?? "section-\(index)", in: &sectionIDs),
          title: clean(section.title, limit: maxLabel), links: links))
        if sections.count == maxSections { break }
      }
      sheets[key] = DockSheet(title: clean(value.title, limit: maxLabel) ?? "", sections: sections)
    }

    var seen = Set<String>()
    let tabs: [DockTabSpec] = rawTabs.prefix(maxTabs).compactMap { tab in
      guard let id = cleanID(tab.id), !seen.contains(id),
        let label = clean(tab.shortLabel, limit: maxLabel) ?? clean(tab.label, limit: maxLabel) else { return nil }
      let href = tab.href.flatMap(safePath)
      // A sheet tab needs something to show; More always has the app's rows.
      var sheet: String?
      if let key = tab.sheet, let candidate = sheets[key], !candidate.sections.isEmpty || key == "more" { sheet = key }
      // A tab must go somewhere: a page, or a sheet that has something in it.
      guard href != nil || sheet != nil else { return nil }
      seen.insert(id)
      let prefixes = (tab.activePrefixes ?? []).prefix(32).compactMap(safePath)
      return DockTabSpec(id: id, label: label, icon: icon(tab.icon), href: sheet == nil ? href : nil, sheet: sheet, activePrefixes: prefixes)
    }
    guard tabs.count >= minTabs else { return nil }
    return DockLayout(tabs: tabs, sheets: sheets)
  }

  private static func link(_ wire: WireLink) -> DockLink? {
    guard let label = clean(wire.label, limit: maxLabel), let raw = wire.href else { return nil }
    let external = wire.external == true
    let href: String
    if external {
      // Absolute links are only for rows the game marks external, and only
      // the allow-listed destinations.
      guard let url = DockExternal.url(raw) else { return nil }
      href = url.absoluteString
    } else {
      guard let path = safePath(raw) else { return nil }
      href = path
    }
    return DockLink(id: cleanID(wire.id) ?? href, label: label, href: href, icon: icon(wire.icon), external: external)
  }

  /// Ids are only view keys: any non-empty string up to 64 characters with no
  /// control characters. The game's section ids contain colons ("state:overview").
  private static func cleanID(_ value: String?) -> String? {
    guard let value, !value.isEmpty, value.count <= maxID, value.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
    return value
  }

  /// The game repeats an id now and then (two "guides" links); a list needs unique keys.
  private static func unique(_ id: String, in seen: inout Set<String>) -> String {
    var candidate = id
    var counter = 2
    while seen.contains(candidate) {
      candidate = id + "#" + String(counter)
      counter += 1
    }
    seen.insert(candidate)
    return candidate
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

/// The last good layout per (account, language, country), so the dock is right
/// the moment the app opens and still right offline. Labels and paths only; no
/// tokens. The account is the session fingerprint, so a rename or a second
/// world cannot hand one player another's tabs. It lives in Application
/// Support, excluded from backups, trimmed to the few most recent entries, and
/// goes when the session does.
enum DockLayoutCache {
  static let keep = 8
  private static let legacyDefaultsKey = "net.lakesidegames.ahdclient.dock-layouts"
  private static let maxFileBytes = 4_000_000
  private struct Entry: Codable { var bytes: Data; var savedAt: Date }

  static var defaultDirectory: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    return base.appendingPathComponent("net.lakesidegames.ahdclient", isDirectory: true)
  }

  static func key(account: String, locale: String?, country: String?) -> String {
    account + "|" + (locale ?? "-") + "|" + (country ?? "-")
  }

  static func load(key: String?, directory: URL = defaultDirectory) -> DockLayout? {
    guard let key, let entry = entries(directory)[key] else { return nil }
    return DockLayoutCodec.decode(entry.bytes)
  }

  static func save(_ bytes: Data, key: String, directory: URL = defaultDirectory) {
    guard bytes.count <= DockLayoutCodec.maxBytes, DockLayoutCodec.decode(bytes) != nil else { return }
    var all = entries(directory)
    all[key] = Entry(bytes: bytes, savedAt: Date())
    if all.count > keep {
      for stale in all.sorted(by: { $0.value.savedAt < $1.value.savedAt }).prefix(all.count - keep) { all[stale.key] = nil }
    }
    write(all, directory)
  }

  /// Forget every entry of one account (sign-out, 401, a vanished session).
  static func clear(account: String, directory: URL = defaultDirectory) {
    var all = entries(directory)
    let before = all.count
    for key in all.keys where key.hasPrefix(account + "|") { all[key] = nil }
    if all.count != before { write(all, directory) }
  }

  /// Older builds kept the layouts in UserDefaults, which backups include.
  static func removeLegacy(defaults: UserDefaults = .standard) {
    defaults.removeObject(forKey: legacyDefaultsKey)
  }

  private static func file(_ directory: URL) -> URL { directory.appendingPathComponent("dock-layouts.json") }

  private static func entries(_ directory: URL) -> [String: Entry] {
    let url = file(directory)
    guard let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, size <= maxFileBytes,
      let data = try? Data(contentsOf: url), let value = try? JSONDecoder().decode([String: Entry].self, from: data) else { return [:] }
    return value
  }

  private static func write(_ all: [String: Entry], _ directory: URL) {
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var url = file(directory)
    guard let data = try? JSONEncoder().encode(all) else { return }
    do { try data.write(to: url, options: .atomic) } catch { return }
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? url.setResourceValues(values)
  }
}

/// The last live game page the player read and the session that read it, so a
/// signed-in launch can open straight back there (the Rust side reads this
/// file; see launch.rs). Path and query only, never a host. Same directory and
/// backup exclusion as the layout cache, and gone with the session.
enum LastGameStore {
  private struct Saved: Codable { var path: String; var account: String }
  private static func file(_ directory: URL) -> URL { directory.appendingPathComponent("last-game.json") }

  static func save(path: String, account: String, directory: URL = DockLayoutCache.defaultDirectory) {
    guard path.utf8.count <= 300, path.hasPrefix("/"), !path.hasPrefix("//") else { return }
    let current = load(directory: directory)
    if current?.path == path && current?.account == account { return }
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var url = file(directory)
    guard let data = try? JSONEncoder().encode(Saved(path: path, account: account)) else { return }
    do { try data.write(to: url, options: .atomic) } catch { return }
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? url.setResourceValues(values)
  }

  static func load(directory: URL = DockLayoutCache.defaultDirectory) -> (path: String, account: String)? {
    guard let data = try? Data(contentsOf: file(directory)), data.count <= 4096,
      let saved = try? JSONDecoder().decode(Saved.self, from: data) else { return nil }
    return (saved.path, saved.account)
  }

  static func clear(directory: URL = DockLayoutCache.defaultDirectory) {
    try? FileManager.default.removeItem(at: file(directory))
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

  /// The request for one (language, country). The game picks its language from
  /// the `ahd-locale` cookie only, so that cookie rides along with the session.
  static func request(cookie: String, locale: String?, country: String?) -> URLRequest {
    var url = endpoint
    if let country, country.count <= 4, country.allSatisfy({ $0.isASCII && $0.isLetter }),
      var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) {
      components.queryItems = [URLQueryItem(name: "country", value: country.uppercased())]
      url = components.url ?? endpoint
    }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
    var header = cookie
    if let locale = DockLocale.valid(locale) { header += "; ahd-locale=" + locale }
    request.setValue(header, forHTTPHeaderField: "Cookie")
    request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    return request
  }

  /// Never blocks the UI; the completion arrives on the main queue.
  static func fetch(cookie: String, locale: String?, country: String?, completion: @escaping (Outcome) -> Void) {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 10
    config.timeoutIntervalForResource = 12
    config.httpCookieStorage = nil
    config.urlCache = nil
    let client = URLSession(configuration: config, delegate: NoDockRedirect(), delegateQueue: nil)
    client.dataTask(with: request(cookie: cookie, locale: locale, country: country)) { bytes, response, _ in
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
        { "id": "company", "label": "Company", "icon": { "name": "briefcase", "grid": ["00011111000","00010001000","01111111110","01000000010","01000000010","01111111110","01000100010","01000100010","01000000010","01111111110","00000000000"] },
          "href": "/corporation/7", "activePrefixes": ["/corporation/7", "/corporations"] },
        { "id": "state", "label": "New York", "icon": { "name": "capitol", "grid": ["00000100000","00011111000","01111111110","00000000000","01010101010","01010101010","01010101010","01010101010","00000000000","01111111110","11111111111"] },
          "sheet": "state", "activePrefixes": ["/country/us/region/NY"] },
        { "id": "nation", "label": "United States", "shortLabel": "Nation", "icon": { "name": "globe", "grid": ["00011111000","00100000100","01001010010","10001010001","10001010001","11111111111","10001010001","10001010001","01001010010","00100000100","00011111000"] },
          "sheet": "nation", "activePrefixes": ["/country/us"] },
        { "id": "actions", "label": "Actions", "icon": { "name": "bolt", "grid": ["00000111000","00001110000","00011100000","00111000000","01111111100","00000111000","00001110000","00011100000","00111000000","01110000000","00000000000"] },
          "href": "/actions", "activePrefixes": ["/actions"] },
        { "id": "more", "label": "More", "icon": { "name": "gear", "grid": ["00011011000","00111111100","01100000110","11001110011","11001010011","01101110110","01100000110","11000000011","01111111110","00110101100","00000000000"] },
          "sheet": "more", "activePrefixes": [] }
      ],
      "sheets": {
        "state": { "title": "New York", "sections": [
          { "id": "state:government", "title": "Government", "links": [
            { "id": "legislature", "label": "Legislature", "href": "/legislature", "icon": { "name": "vote", "grid": ["00000000000","00011111000","00010001000","00010101000","00011001000","00010001000","00111111100","01100000110","01000000010","01111111110","00000000000"] } },
            { "id": "governor", "label": "Governor", "href": "/state/NY/governor" },
            { "id": "courts", "label": "Courts", "href": "/state/NY/courts" } ] },
          { "id": "state:economy", "title": "Economy", "links": [
            { "id": "budget", "label": "State budget", "href": "/state/NY/budget" },
            { "id": "markets", "label": "Markets", "href": "/markets" } ] } ] },
        "nation": { "title": "United States", "sections": [
          { "id": "nation:Politics", "title": "Politics", "links": [
            { "id": "elections", "label": "Elections", "href": "/elections" },
            { "id": "parties", "label": "Parties", "href": "/parties" },
            { "id": "congress", "label": "Congress", "href": "/congress" } ] },
          { "id": "nation:Government", "title": "World", "links": [
            { "id": "countries", "label": "Countries", "href": "/countries" },
            { "id": "wars", "label": "Wars", "href": "/wars" } ] } ] },
        "more": { "title": "More", "sections": [
          { "id": "you:you", "title": "You", "links": [
            { "id": "notifications", "label": "Notifications (3)", "href": "/notifications" },
            { "id": "profile", "label": "Profile", "href": "/profile" },
            { "id": "portfolio", "label": "Portfolio", "href": "/portfolio" },
            { "id": "settings", "label": "Settings", "href": "/settings" } ] },
          { "id": "help:community", "title": "Community", "links": [
            { "id": "guides", "label": "Wiki and guides", "href": "https://wiki.ahousedividedgame.com", "external": true },
            { "id": "discord", "label": "Discord", "href": "https://discord.gg/DmF8zJJuqN", "external": true },
            { "id": "support", "label": "Email support", "href": "mailto:admin@ahousedividedgame.com", "external": true } ] } ] }
      }
    }
    """

  static var layout: DockLayout { DockLayoutCodec.decode(Data(json.utf8)) ?? DockLayout(tabs: [], sheets: [:]) }
}
