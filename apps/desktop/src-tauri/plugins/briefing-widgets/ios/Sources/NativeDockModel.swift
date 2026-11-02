import Combine
import SwiftUI
import UIKit

// What the dock shows and how a tap is understood. The tab row comes from the
// game (DockLayout) when there is one and from the app's own four tabs when
// there is not; either way the views see the same DockTab values.

/// Somewhere the app itself can take the player.
enum DockApp: String {
  case game, briefing, inbox, ask, launcher
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
  /// Used when the tab has no pixel icon (the app's own tabs).
  let symbol: String
  let kind: Kind
  let activePrefixes: [String]
}

/// What the grown panel shows: the full status, or one tab's sheet.
enum DockPanel: Equatable {
  case status
  case sheet(String)

  var key: String {
    switch self {
    case .status: return "status"
    case .sheet(let name): return "sheet:" + name
    }
  }
}

enum DockTabs {
  /// Signed out, an older game, or no answer yet: the player is never stuck.
  static let fallback: [DockTab] = [
    DockTab(id: "game", label: "Game", icon: nil, symbol: "building.columns", kind: .app(.game), activePrefixes: []),
    DockTab(id: "briefing", label: "Briefing", icon: nil, symbol: "newspaper", kind: .app(.briefing), activePrefixes: []),
    DockTab(id: "ask", label: "Ask", icon: nil, symbol: "bubble.left.and.bubble.right", kind: .app(.ask), activePrefixes: []),
    DockTab(id: "more", label: "More", icon: nil, symbol: "ellipsis.circle", kind: .sheet("more"), activePrefixes: []),
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

  static func path(_ url: URL) -> String {
    url.path.count > 1 && url.path.hasSuffix("/") ? String(url.path.dropLast()) : (url.path.isEmpty ? "/" : url.path)
  }

  /// Which tab a page belongs to: the longest matching prefix wins, and a
  /// prefix matches whole path segments only ("/state/NY" is not "/state/NYC").
  /// The home page "/" matches only itself. Nil when no tab claims the page.
  static func tab(forPath path: String, in tabs: [DockTab]) -> String? {
    var best: (id: String, length: Int)?
    for tab in tabs {
      for prefix in tab.activePrefixes {
        let clean = prefix.split(separator: "?").first.map(String.init) ?? prefix
        let trimmed = clean.count > 1 && clean.hasSuffix("/") ? String(clean.dropLast()) : clean
        let matches = trimmed == "/" ? path == "/" : (path == trimmed || path.hasPrefix(trimmed + "/"))
        if matches, trimmed.count > (best?.length ?? -1) { best = (tab.id, trimmed.count) }
      }
    }
    return best?.id
  }

  /// The selected tab for a webview address, or nil to leave it alone.
  static func selection(for url: URL?, tabs: [DockTab], usingGameTabs: Bool) -> String? {
    guard let url, let host = url.host else { return nil }
    if url.scheme == "tauri" && host == "localhost" {
      // The launcher marks its Briefing screen with #briefing (App.tsx).
      let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
      let briefing = url.fragment == "briefing" || query.contains { $0.name == "screen" && $0.value == "briefing" }
      if briefing, tabs.contains(where: { $0.id == "briefing" }) { return "briefing" }
      return "more"
    }
    guard url.scheme == "https", NativeNavController.gameHosts.contains(host) else { return nil }
    return usingGameTabs ? tab(forPath: path(url), in: tabs) : "game"
  }
}

// MARK: - Model

final class DockModel: ObservableObject {
  @Published private(set) var layout: DockLayout?
  @Published private(set) var tabs: [DockTab] = DockTabs.fallback
  /// The tab the current page belongs to.
  @Published var selectedID: String?
  /// Unread inbox count; zero hides it. Shown on More.
  @Published var badge = 0
  @Published var status: DockStatus? { didSet { stripMayHaveChanged() } }
  /// The page is a game page that carried the web status footer.
  @Published var onStripPage = false { didSet { stripMayHaveChanged() } }
  @Published private(set) var progress: CGFloat = 0
  @Published private(set) var expanded = false
  /// The panel on show, kept while it closes so its content does not vanish.
  @Published private(set) var panel: DockPanel = .status
  @Published var reduceMotion = UIAccessibility.isReduceMotionEnabled
  /// Height the webview must leave free at the bottom of the screen.
  @Published private(set) var slotHeight: CGFloat = 96
  /// Natural height of each panel's content, and the most the panel may grow.
  @Published private(set) var natural: [String: CGFloat] = [:]
  private(set) var capHeight: CGFloat = 400

  var baseHeight: CGFloat = 0 { didSet { updateSlot() } }
  var bottomPad: CGFloat = 8 { didSet { updateSlot() } }
  var onTab: (DockTab) -> Void = { _ in }
  var onOpenPath: (String) -> Void = { _ in }
  var onApp: (DockApp) -> Void = { _ in }
  let spring = DockSpring()

  init() {
    spring.onChange = { [weak self] value in self?.progress = value }
  }

  var showsStrip: Bool { onStripPage && status?.showable == true }
  var usingGameTabs: Bool { layout != nil }

  /// The tab to light up: the one whose sheet is open, else the page's.
  var displayedID: String? {
    if expanded, case .sheet(let key) = panel, let tab = tabs.first(where: { $0.kind == .sheet(key) }) { return tab.id }
    return selectedID
  }

  func setLayout(_ value: DockLayout?) {
    guard value != layout else { return }
    layout = value
    tabs = DockTabs.tabs(for: value)
    // A sheet that no longer exists must not stay open.
    if expanded, case .sheet(let key) = panel, !tabs.contains(where: { $0.kind == .sheet(key) }) { close(animated: false) }
  }

  func sheet(_ key: String) -> DockSheet? { layout?.sheets[key] }

  // MARK: Slot and measuring

  private func updateSlot() {
    guard baseHeight > 0 else { return }
    let height = baseHeight + bottomPad + DockStyle.pageGap
    if abs(height - slotHeight) > 0.5 { slotHeight = height }
  }

  func measured(_ heights: [String: CGFloat]) {
    if heights != natural { natural = heights }
  }

  func setCap(_ value: CGFloat) { capHeight = value }

  func extent(for panel: DockPanel) -> CGFloat { min(natural[panel.key] ?? 0, capHeight) }
  var currentExtent: CGFloat { extent(for: panel) }
  func scrolls(_ panel: DockPanel) -> Bool { (natural[panel.key] ?? 0) > capHeight + 0.5 }

  // MARK: Open and close

  private func stripMayHaveChanged() {
    if !showsStrip && panel == .status && (expanded || progress > 0) { close(animated: false) }
  }

  /// The strip's tap: open the status, or close whatever is open.
  func toggleStatus() {
    if expanded && panel == .status { close() } else { open(.status) }
  }

  func toggleSheet(_ key: String) {
    if expanded && panel == .sheet(key) { close() } else { open(.sheet(key)) }
  }

  func open(_ target: DockPanel, velocity: CGFloat = 0, animated: Bool = true) {
    if target == .status && !showsStrip { return }
    if case .sheet(let key) = target, !tabs.contains(where: { $0.kind == .sheet(key) }) { return }
    if panel != target {
      // Swapping the content of a panel that is already open grows or
      // shrinks it to the new size instead of jumping.
      if animated && !reduceMotion && expanded {
        withAnimation(.spring(response: 0.38, dampingFraction: 0.82)) { panel = target }
      } else {
        panel = target
      }
    }
    expanded = true
    if animated && !reduceMotion {
      spring.run(to: 1, velocity: velocity)
    } else {
      spring.hold(at: 1)
    }
  }

  func close(velocity: CGFloat = 0, animated: Bool = true) {
    // Closing what is already closed (every tab tap does) starts no motion.
    if !expanded && progress < 0.001 && spring.value < 0.001 { return }
    expanded = false
    if animated && !reduceMotion {
      spring.run(to: 0, velocity: velocity)
    } else {
      spring.hold(at: 0)
    }
  }

  /// A drag released: settle open or closed with the finger's speed.
  func settle(open shouldOpen: Bool, velocity: CGFloat) {
    if shouldOpen { open(panel, velocity: velocity) } else { close(velocity: velocity) }
  }

  /// A drag began on a closed dock: it can only be pulling the status up.
  func beginDrag() -> Bool {
    if expanded || progress > 0.001 { return true }
    guard showsStrip else { return false }
    panel = .status
    return true
  }

  func openPath(_ path: String) {
    close()
    onOpenPath(path)
  }

  func openApp(_ app: DockApp) {
    close()
    onApp(app)
  }
}
