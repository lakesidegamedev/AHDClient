import Foundation

// The dock's pure logic: tabs, which tab a page belongs to, what may leave the
// game webview, and the app's own pixel icons. Foundation only, so CI compiles
// it on a Mac and runs the fixture tests in .github/dock-core-test (no UIKit
// here, on purpose).

/// Somewhere the app itself can take the player.
enum DockApp: String {
  case game, briefing, inbox, ask, alerts, launcher
}

struct DockTab: Identifiable, Equatable {
  enum Kind: Equatable {
    case page(String)
    case sheet(String)
    case app(DockApp)
  }

  let id: String
  let label: String
  let icon: DockIcon?
  /// Used when the tab has no pixel icon (a malformed game icon).
  let symbol: String
  let kind: Kind
  let activePrefixes: [String]
}

/// The app's own rows and tabs draw 11x11 pixel grids in the game's style,
/// so the whole dock is one visual language. The Android dock defines the same
/// grids; keep them equal.
enum DockAppIcons {
  static let game = DockIcon(name: "home", grid: [
    "00000100000", "00001110000", "00011011000", "00110001100", "01100000110", "01000000010",
    "01001110010", "01001010010", "01001010010", "01111111110", "00000000000",
  ])
  static let briefing = DockIcon(name: "briefing", grid: [
    "00000000000", "01111111110", "01000000010", "01011111010", "01000000010", "01011011010",
    "01000000010", "01011111010", "01000000010", "01111111110", "00000000000",
  ])
  static let alerts = DockIcon(name: "bell", grid: [
    "00001110000", "00011111000", "00111111100", "00111111100", "00111111100", "01111111110",
    "01111111110", "00000000000", "11111111111", "00001110000", "00000000000",
  ])
  static let inbox = DockIcon(name: "mail", grid: [
    "00000000000", "00000000000", "11111111111", "11000000011", "10100000101", "10010001001",
    "10001010001", "10000100001", "10000000001", "11111111111", "00000000000",
  ])
  static let ask = DockIcon(name: "chat", grid: [
    "00111111100", "01000000010", "10000000001", "10010101001", "10000000001", "01000000010",
    "00111111100", "00010000000", "00100000000", "00000000000", "00000000000",
  ])
  static let launcher = DockIcon(name: "back", grid: [
    "00000000000", "00000000000", "00001000000", "00011000000", "00111000000", "01111111110",
    "00111000000", "00011000000", "00001000000", "00000000000", "00000000000",
  ])
  /// The game's own `apps` icon, so the fallback More looks like the real one.
  static let more = DockIcon(name: "apps", grid: [
    "00000000000", "01111011110", "01111011110", "01111011110", "01111011110", "00000000000",
    "01111011110", "01111011110", "01111011110", "01111011110", "00000000000",
  ])
}

/// Where the dock may send the player outside the game webview. A link only
/// gets here when the game marks it `external`, and only these destinations
/// survive: https on a short host list, and mail to the support address.
enum DockExternal {
  static let hosts: Set<String> = [
    "wiki.ahousedividedgame.com", "discord.gg", "www.patreon.com", "lakesidegames.net", "docs.lakesidegames.net",
  ]
  static let mailbox = "admin@ahousedividedgame.com"

  static func url(_ value: String) -> URL? {
    guard value.utf8.count <= 300, value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
      value.rangeOfCharacter(from: .controlCharacters) == nil, !value.contains("\\"),
      let components = URLComponents(string: value), let scheme = components.scheme?.lowercased() else { return nil }
    if scheme == "mailto" {
      guard components.path.lowercased() == mailbox, components.query == nil, components.fragment == nil else { return nil }
      return components.url
    }
    guard scheme == "https", components.user == nil, components.password == nil,
      components.port == nil || components.port == 443,
      let host = components.host?.lowercased(), hosts.contains(host) else { return nil }
    return components.url
  }
}

/// The `ahd-locale` cookie value the game keys its language on.
enum DockLocale {
  static func valid(_ value: String?) -> String? {
    guard let value, (2...16).contains(value.count),
      value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
    return value
  }
}

enum DockTabs {
  /// Signed out, an older game, or no answer yet: the player is never stuck.
  static let fallback: [DockTab] = [
    DockTab(id: "game", label: "Game", icon: DockAppIcons.game, symbol: "building.columns", kind: .app(.game), activePrefixes: []),
    DockTab(id: "briefing", label: "Briefing", icon: DockAppIcons.briefing, symbol: "newspaper", kind: .app(.briefing), activePrefixes: []),
    DockTab(id: "ask", label: "Ask", icon: DockAppIcons.ask, symbol: "bubble.left.and.bubble.right", kind: .app(.ask), activePrefixes: []),
    DockTab(id: "more", label: "More", icon: DockAppIcons.more, symbol: "ellipsis.circle", kind: .sheet("more"), activePrefixes: []),
  ]

  static func tabs(for layout: DockLayout?) -> [DockTab] {
    guard let layout else { return fallback }
    return layout.tabs.map { spec in
      let kind: DockTab.Kind = spec.sheet.map { .sheet($0) } ?? .page(spec.href ?? "/")
      return DockTab(id: spec.id, label: spec.label, icon: spec.icon, symbol: symbol(for: spec), kind: kind, activePrefixes: spec.activePrefixes)
    }
  }

  /// Only drawn when a game icon is missing or malformed.
  private static func symbol(for spec: DockTabSpec) -> String {
    switch spec.id {
    case "company": return "briefcase"
    case "state": return "building.columns"
    case "nation": return "globe"
    case "actions": return "bolt"
    case "more": return "ellipsis.circle"
    default: return "circle.grid.2x2"
    }
  }

  /// The path of a page address, without a trailing slash (except the root).
  static func normalized(_ path: String) -> String {
    let bare = path.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "?" || $0 == "#" }).first.map(String.init) ?? ""
    guard !bare.isEmpty else { return "/" }
    return bare.count > 1 && bare.hasSuffix("/") ? String(bare.dropLast()) : bare
  }

  static func path(_ url: URL) -> String { normalized(url.path) }

  /// Which tab a page belongs to: the longest matching prefix wins, a prefix
  /// matches whole path segments only ("/country/us/region/NY" is not
  /// "/country/us/region/NYC"), and query and hash are ignored. The home page
  /// "/" matches only itself. Nil when no tab claims the page.
  static func tab(forPath raw: String, in tabs: [DockTab]) -> String? {
    let path = normalized(raw)
    var best: (id: String, length: Int)?
    for tab in tabs {
      for prefix in tab.activePrefixes {
        let trimmed = normalized(prefix)
        let matches = trimmed == "/" ? path == "/" : (path == trimmed || path.hasPrefix(trimmed + "/"))
        if matches, trimmed.count > (best?.length ?? -1) { best = (tab.id, trimmed.count) }
      }
    }
    return best?.id
  }

  /// The country a page is about, uppercase, when it lives under
  /// /country/<id>; the Nation tab follows the page the way the web dock does.
  static func country(inPath raw: String) -> String? {
    let parts = normalized(raw).split(separator: "/", omittingEmptySubsequences: true)
    guard parts.count >= 2, parts[0] == "country" else { return nil }
    let id = String(parts[1])
    guard (2...4).contains(id.count), id.allSatisfy({ $0.isASCII && $0.isLetter }) else { return nil }
    return id.uppercased()
  }

  /// Paths that mean "signed out (or about to be)": the dock drops to the
  /// app tabs at once and forgets the account's cached tabs.
  static let signedOutPaths: Set<String> = ["/login", "/register", "/logout"]
}

extension DockSheet {
  /// The game's sections without one link, and without any section that
  /// empties out. The app's own Inbox row replaces the game's `notifications`.
  func sections(without linkID: String) -> [DockSection] {
    sections.compactMap { section in
      let links = section.links.filter { $0.id != linkID }
      return links.isEmpty ? nil : DockSection(id: section.id, title: section.title, links: links)
    }
  }
}
