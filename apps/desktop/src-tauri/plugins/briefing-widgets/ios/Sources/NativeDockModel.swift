import Combine
import SwiftUI
import UIKit

// What the dock shows and how a tap is understood. The tab row comes from the
// game (DockLayout) when there is one and from the app's own four tabs when
// there is not; either way the views see the same DockTab values.

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

extension DockTabs {
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
  /// The soft keyboard is up: the dock steps aside, like Android, and the page
  /// gets the room.
  @Published private(set) var keyboardUp = false
  /// Space under the dock surface: the window's home indicator inset only.
  /// It never follows the keyboard.
  @Published private(set) var bottomPad: CGFloat = 8
  /// Natural height of each panel's content, and the most the panel may grow.
  @Published private(set) var natural: [String: CGFloat] = [:]
  private(set) var capHeight: CGFloat = 400

  var baseHeight: CGFloat = 0 { didSet { updateSlot() } }
  var onTab: (DockTab) -> Void = { _ in }
  var onOpenPath: (String) -> Void = { _ in }
  var onOpenExternal: (URL) -> Void = { _ in }
  var onApp: (DockApp) -> Void = { _ in }
  let spring = DockSpring()

  init() {
    spring.onChange = { [weak self] value in self?.progress = value }
  }

  /// Only on a game page, never on the launcher or the Briefing, and only for
  /// a signed-in player with a character.
  var showsStrip: Bool { onStripPage && selectedID != "briefing" && status?.showable == true }
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
    let height = keyboardUp ? 0 : baseHeight + bottomPad + DockStyle.pageGap
    if abs(height - slotHeight) > 0.5 { slotHeight = height }
  }

  /// The window's bottom safe area (home indicator), the only thing the pad follows.
  func setHomeInset(_ inset: CGFloat) {
    let pad = max(inset - 8, 8)
    guard abs(pad - bottomPad) > 0.5 else { return }
    bottomPad = pad
    updateSlot()
  }

  func setKeyboardUp(_ up: Bool) {
    guard up != keyboardUp else { return }
    if up { close(animated: false) }
    keyboardUp = up
    updateSlot()
  }

  /// What VoiceOver announces when a panel opens.
  func title(of panel: DockPanel) -> String {
    switch panel {
    case .status: return "Status"
    case .sheet(let key):
      if let name = sheet(key)?.title, !name.isEmpty { return name }
      return tabs.first { $0.kind == .sheet(key) }?.label ?? "Menu"
    }
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
    if keyboardUp || (target == .status && !showsStrip) { return }
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

  func openLink(_ link: DockLink) {
    if link.external {
      close()
      if let url = DockExternal.url(link.href) { onOpenExternal(url) }
    } else {
      openPath(link.href)
    }
  }

  func openApp(_ app: DockApp) {
    close()
    onApp(app)
  }
}
