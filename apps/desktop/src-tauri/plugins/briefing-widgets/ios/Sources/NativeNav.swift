import UIKit
import WebKit
import WidgetKit

/// The tab bar: Game, Briefing, Inbox, Ask and More, in place of the floating
/// AHD button the site pages used to carry. One WKWebView still shows
/// everything; each tab is a page in it (or the native Ask sheet), and the bar
/// follows whatever page the webview is on, however the player got there.
///
/// The webview is moved into a host view that stacks it above the bar, so the
/// page (and the game's fixed bottom status bar) ends where the bar begins.
/// The host is also where hardware keyboard shortcuts live: it sits in the
/// responder chain above the webview, so Cmd+1 to Cmd+5 work while a page
/// field has focus. iPad uses the same bar; with iOS 15 as the deployment
/// target the iPadOS 18 floating tab bar is not available to a standalone bar.
final class NativeNavController: NSObject, UITabBarDelegate {
  static let shared = NativeNavController()

  enum Destination: Int, CaseIterable {
    case game, briefing, inbox, ask, more

    var title: String {
      switch self {
      case .game: return "Game"
      case .briefing: return "Briefing"
      case .inbox: return "Inbox"
      case .ask: return "Ask"
      case .more: return "More"
      }
    }

    var symbol: String {
      switch self {
      case .game: return "building.columns"
      case .briefing: return "newspaper"
      case .inbox: return "tray"
      case .ask: return "bubble.left.and.bubble.right"
      case .more: return "ellipsis.circle"
      }
    }

    var selectedSymbol: String {
      self == .more ? "ellipsis.circle.fill" : symbol + ".fill"
    }
  }

  static let site = "https://ahousedividedgame.com"
  static let sandboxHost = "sandbox.ahousedividedgame.com"
  static let launcher = "tauri://localhost/"
  static let background = UIColor(red: 0x14 / 255, green: 0x14 / 255, blue: 0x1c / 255, alpha: 1)
  static let accent = UIColor(red: 0xdc / 255, green: 0x26 / 255, blue: 0x26 / 255, alpha: 1)

  /// Which tab a webview address belongs to. Ask never is: it is a sheet.
  static func destination(for url: URL?) -> Destination? {
    guard let url, let host = url.host else { return nil }
    if url.scheme == "tauri" && host == "localhost" {
      // The launcher marks its Briefing screen with #briefing (App.tsx).
      let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
      let briefing = url.fragment == "briefing" || query.contains { $0.name == "screen" && $0.value == "briefing" }
      return briefing ? .briefing : .more
    }
    guard url.scheme == "https", ["ahousedividedgame.com", "www.ahousedividedgame.com", sandboxHost].contains(host) else { return nil }
    let path = url.path.hasSuffix("/") ? String(url.path.dropLast()) : url.path
    return path == "/notifications" ? .inbox : .game
  }

  private weak var webView: WKWebView?
  private weak var host: NativeNavHost?
  private let bar = UITabBar()
  private let haptics = UISelectionFeedbackGenerator()
  private var current: Destination?
  private var lastGameURL: URL?
  private var inboxVisitedAt = Date.distantPast
  private var urlObservation: NSKeyValueObservation?
  private var timers = [Timer]()
  private var observers = [NSObjectProtocol]()

  func attach(_ webView: WKWebView) {
    self.webView = webView
    install(attempt: 0)
  }

  /// wry adds the webview to its window's view after plugins load, so wait
  /// for a superview. If the bar never attaches the webview stays full size,
  /// exactly as it was before the bar existed.
  private func install(attempt: Int) {
    guard let webView else { return }
    guard let parent = webView.superview else {
      if attempt < 120 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.install(attempt: attempt + 1) }
      }
      return
    }
    if parent is NativeNavHost { return }

    let host = NativeNavHost(frame: parent.bounds)
    host.controller = self
    host.backgroundColor = Self.background
    host.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    parent.insertSubview(host, aboveSubview: webView)
    webView.removeFromSuperview()
    webView.translatesAutoresizingMaskIntoConstraints = false
    host.addSubview(webView)

    configureBar()
    bar.translatesAutoresizingMaskIntoConstraints = false
    host.addSubview(bar)
    // Pinned to the host's bottom edge, not its safe area: UITabBar grows
    // itself over the home indicator, as in other apps.
    NSLayoutConstraint.activate([
      webView.topAnchor.constraint(equalTo: host.topAnchor),
      webView.leadingAnchor.constraint(equalTo: host.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: host.trailingAnchor),
      webView.bottomAnchor.constraint(equalTo: bar.topAnchor),
      bar.leadingAnchor.constraint(equalTo: host.leadingAnchor),
      bar.trailingAnchor.constraint(equalTo: host.trailingAnchor),
      bar.bottomAnchor.constraint(equalTo: host.bottomAnchor),
    ])
    self.host = host
    // Silences the floating AHD button mobile.rs keeps as a fallback for a
    // bar that never attached. The flag carries no data and no capability.
    let flag = "window.__ahdclientNativeTabs = true;"
    webView.configuration.userContentController.addUserScript(
      WKUserScript(source: flag, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    webView.evaluateJavaScript(flag, completionHandler: nil)

    urlObservation = webView.observe(\.url, options: [.initial, .new]) { [weak self] view, _ in
      DispatchQueue.main.async { self?.follow(view.url) }
    }
    // The launcher's own screen changes are history updates; check now and
    // then as well, and keep the inbox badge current.
    timers.append(Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      guard let self else { return }
      self.follow(self.webView?.url)
    })
    timers.append(Timer.scheduledTimer(withTimeInterval: 180, repeats: true) { [weak self] _ in self?.fetchInbox() })
    observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.fetchInbox()
    })
    fetchInbox()
  }

  private func configureBar() {
    bar.delegate = self
    bar.overrideUserInterfaceStyle = .dark
    bar.tintColor = Self.accent
    let appearance = UITabBarAppearance()
    appearance.configureWithOpaqueBackground()
    appearance.backgroundColor = Self.background
    for layout in [appearance.stackedLayoutAppearance, appearance.inlineLayoutAppearance, appearance.compactInlineLayoutAppearance] {
      layout.selected.iconColor = Self.accent
      layout.selected.titleTextAttributes = [.foregroundColor: Self.accent]
      layout.normal.iconColor = .secondaryLabel
      layout.normal.titleTextAttributes = [.foregroundColor: UIColor.secondaryLabel]
      layout.normal.badgeBackgroundColor = Self.accent
    }
    bar.standardAppearance = appearance
    bar.scrollEdgeAppearance = appearance
    bar.items = Destination.allCases.map { tab in
      let item = UITabBarItem(title: tab.title, image: UIImage(systemName: tab.symbol), selectedImage: UIImage(systemName: tab.selectedSymbol))
      item.tag = tab.rawValue
      item.accessibilityIdentifier = "ahdclient-tab-\(tab.title.lowercased())"
      return item
    }
  }

  func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
    guard let tab = Destination(rawValue: item.tag) else { return }
    open(tab)
  }

  /// Taps, keyboard shortcuts and the More list all land here.
  func open(_ tab: Destination) {
    guard let webView else { return }
    let again = tab == current
    if !again { haptics.selectionChanged() }
    let site = siteOrigin()
    switch tab {
    case .game:
      // Back to the page the player was last reading; Game again goes home.
      let target = again ? URL(string: site + "/") : lastGameURL ?? URL(string: site + "/")
      if let target { webView.load(URLRequest(url: target)) }
    case .briefing:
      if !again, let url = URL(string: Self.launcher + "?screen=briefing") { webView.load(URLRequest(url: url)) }
    case .inbox:
      if let url = URL(string: site + "/notifications") { webView.load(URLRequest(url: url)) }
    case .ask:
      NativeAskController.shared.present()
    case .more:
      if !again, let url = URL(string: Self.launcher) { webView.load(URLRequest(url: url)) }
    }
    // Highlight the tab at once; following the page corrects it if the
    // navigation is refused. Ask is a sheet, so the selection stays put.
    select(tab == .ask ? current : tab)
  }

  func reload() { webView?.reload() }
  func goBack() { if webView?.canGoBack == true { webView?.goBack() } }
  func goForward() { if webView?.canGoForward == true { webView?.goForward() } }

  private func siteOrigin() -> String {
    webView?.url?.host == Self.sandboxHost ? "https://" + Self.sandboxHost : Self.site
  }

  private func follow(_ url: URL?) {
    guard let tab = Self.destination(for: url) else { return }
    if tab == .game { lastGameURL = url }
    guard tab != current else { return }
    // The player just read the inbox; ask the site for the new count.
    if current == .inbox { fetchInbox() }
    if tab == .inbox { inboxVisitedAt = Date() }
    current = tab
    select(tab)
    refreshBadge()
  }

  private func select(_ tab: Destination?) {
    bar.selectedItem = tab.flatMap { tab in bar.items?.first { $0.tag == tab.rawValue } }
  }

  private func fetchInbox() {
    BriefingStore.refresh { _ in
      WidgetCenter.shared.reloadAllTimelines()
      DispatchQueue.main.async { [weak self] in self?.refreshBadge() }
    }
  }

  /// Unread count from the same snapshot the briefing and widgets use. Hidden
  /// on the Inbox itself and until a snapshot newer than the visit arrives.
  private func refreshBadge() {
    guard let item = bar.items?.first(where: { $0.tag == Destination.inbox.rawValue }) else { return }
    let saved = BriefingStore.read()
    let unread = Int(saved?.data.inbox?.unread ?? 0)
    let fresh = (saved?.updatedAt ?? .distantPast) > inboxVisitedAt
    item.badgeValue = unread > 0 && fresh && current != .inbox ? (unread > 99 ? "99+" : String(unread)) : nil
  }

  deinit {
    timers.forEach { $0.invalidate() }
    observers.forEach { NotificationCenter.default.removeObserver($0) }
  }
}

/// Holds the webview and the tab bar, and answers hardware keyboard
/// shortcuts. Holding Cmd on iPad lists them.
final class NativeNavHost: UIView {
  weak var controller: NativeNavController?

  override var canBecomeFirstResponder: Bool { true }

  override var keyCommands: [UIKeyCommand]? {
    var commands = NativeNavController.Destination.allCases.enumerated().map { index, tab in
      command(tab.title, input: String(index + 1), action: #selector(openTab(_:)), tag: tab.rawValue)
    }
    commands.append(command("Ask", input: "k", action: #selector(openAsk)))
    commands.append(command("Reload Page", input: "r", action: #selector(reloadPage)))
    commands.append(command("Back", input: "[", action: #selector(goBack)))
    commands.append(command("Forward", input: "]", action: #selector(goForward)))
    return commands
  }

  private func command(_ title: String, input: String, action: Selector, tag: Int? = nil) -> UIKeyCommand {
    let command = UIKeyCommand(title: title, action: action, input: input, modifierFlags: .command, propertyList: tag)
    command.wantsPriorityOverSystemBehavior = true
    return command
  }

  @objc private func openTab(_ sender: UIKeyCommand) {
    guard let raw = sender.propertyList as? Int, let tab = NativeNavController.Destination(rawValue: raw) else { return }
    controller?.open(tab)
  }

  @objc private func openAsk() { controller?.open(.ask) }
  @objc private func reloadPage() { controller?.reload() }
  @objc private func goBack() { controller?.goBack() }
  @objc private func goForward() { controller?.goForward() }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    // With nothing focused yet, shortcuts still need a responder to start from.
    if window != nil { DispatchQueue.main.async { [weak self] in _ = self?.becomeFirstResponder() } }
  }
}
