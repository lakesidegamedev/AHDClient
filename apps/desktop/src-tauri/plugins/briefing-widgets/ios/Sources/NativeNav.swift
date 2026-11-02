import Combine
import SwiftUI
import UIKit
import WebKit

/// The dock: Game, Briefing, Inbox, Ask and More, plus the game's status
/// strip, in place of the floating AHD button the site pages used to carry.
/// One WKWebView still shows everything; each tab is a page in it (or the
/// native Ask sheet), and the dock follows whatever page the webview is on,
/// however the player got there. The dock itself is SwiftUI (NativeDock.swift).
///
/// The webview is moved into a host view and ends where the dock begins, so
/// the page ends above the dock at every inset. The dock layer covers the
/// host but only takes touches on the dock, or everywhere while its sheet is
/// open. The host is also where hardware keyboard shortcuts live: it sits in
/// the responder chain above the webview, so Cmd+1 to Cmd+5 work while a page
/// field has focus. iPad uses the same dock, centered with a maximum width.
final class NativeNavController: NSObject {
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
    guard url.scheme == "https", gameHosts.contains(host) else { return nil }
    let path = url.path.hasSuffix("/") ? String(url.path.dropLast()) : url.path
    return path == "/notifications" ? .inbox : .game
  }

  /// The tell the game keys on to hide its own web status footer. Only an app
  /// that actually attached the dock sends it, so an older app, or a dock that
  /// never attached, keeps the web footer.
  static let statusMarker = "AHDClientNativeStatus/1"
  static let gameHosts = ["ahousedividedgame.com", "www.ahousedividedgame.com", sandboxHost]
  /// Pages the web status footer is not drawn on; the strip follows suit.
  private static let bareGamePaths: Set<String> = ["", "/login", "/register", "/banned"]

  private weak var webView: WKWebView?
  private weak var host: NativeNavHost?
  private let model = DockModel()
  private let haptics = UISelectionFeedbackGenerator()
  private let messages = DockMessageHandler()
  private var slotConstraint: NSLayoutConstraint?
  private var hosting: UIHostingController<DockView>?
  private var cancellables = Set<AnyCancellable>()
  private var current: Destination?
  private var lastGameURL: URL?
  private var lastURL: URL?
  private var inboxVisitedAt = Date.distantPast
  private var urlObservation: NSKeyValueObservation?
  private var turnRefresh: DispatchWorkItem?
  private var lastTurnSignal = Date.distantPast
  private var timers = [Timer]()
  private var observers = [NSObjectProtocol]()
  private let preview = NativeDockPreview.requestedState()

  func attach(_ webView: WKWebView) {
    self.webView = webView
    install(attempt: 0)
  }

  /// wry adds the webview to its window's view after plugins load, so wait
  /// for a superview. If the dock never attaches the webview stays full size,
  /// exactly as it was before the dock existed.
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

    // The slot is the strip of screen the dock owns; the page ends above it.
    // Its height follows what the dock reports, so the strip appearing on a
    // game page or the sheet's base growing with Dynamic Type moves the page.
    let slot = UILayoutGuide()
    host.addLayoutGuide(slot)
    let slotHeight = slot.heightAnchor.constraint(equalToConstant: model.slotHeight)
    slotConstraint = slotHeight

    let container = DockContainerView()
    container.model = model
    container.backgroundColor = .clear
    container.translatesAutoresizingMaskIntoConstraints = false
    host.addSubview(container)

    let hosting = UIHostingController(rootView: DockView(model: model))
    hosting.view.backgroundColor = .clear
    hosting.view.translatesAutoresizingMaskIntoConstraints = false
    hosting.overrideUserInterfaceStyle = .dark
    // A hosting controller outside the view controller tree misses safe area
    // and size updates; adopt it into the one that owns the window.
    let owner = Self.owningController(of: host)
    owner?.addChild(hosting)
    container.addSubview(hosting.view)
    if let owner { hosting.didMove(toParent: owner) }
    self.hosting = hosting

    // The page ends at the top of the slot, which is the top of the dock.
    NSLayoutConstraint.activate([
      slot.leadingAnchor.constraint(equalTo: host.leadingAnchor),
      slot.trailingAnchor.constraint(equalTo: host.trailingAnchor),
      slot.bottomAnchor.constraint(equalTo: host.bottomAnchor),
      slotHeight,
      webView.topAnchor.constraint(equalTo: host.topAnchor),
      webView.leadingAnchor.constraint(equalTo: host.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: host.trailingAnchor),
      webView.bottomAnchor.constraint(equalTo: slot.topAnchor),
      container.topAnchor.constraint(equalTo: host.topAnchor),
      container.bottomAnchor.constraint(equalTo: host.bottomAnchor),
      container.leadingAnchor.constraint(equalTo: host.leadingAnchor),
      container.trailingAnchor.constraint(equalTo: host.trailingAnchor),
      hosting.view.topAnchor.constraint(equalTo: container.topAnchor),
      hosting.view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
      hosting.view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      hosting.view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
    ])
    self.host = host
    host.layoutIfNeeded()

    model.onSelect = { [weak self] tab in self?.open(tab) }
    model.onOpenPath = { [weak self] path in self?.openGamePath(path) }
    model.$slotHeight.removeDuplicates().dropFirst().receive(on: DispatchQueue.main).sink { [weak self] height in
      self?.moveSlot(to: height)
    }.store(in: &cancellables)
    observers.append(NotificationCenter.default.addObserver(forName: UIAccessibility.reduceMotionStatusDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
      self?.model.reduceMotion = UIAccessibility.isReduceMotionEnabled
    })

    // Silences the floating AHD button mobile.rs keeps as a fallback for a
    // dock that never attached. The flag carries no data and no capability.
    let flag = "window.__ahdclientNativeTabs = true;"
    webView.configuration.userContentController.addUserScript(
      WKUserScript(source: flag, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    webView.evaluateJavaScript(flag, completionHandler: nil)

    bridgeTurnComplete(on: webView)
    announceNativeStatus(on: webView)

    if let preview {
      applyPreview(preview)
      return
    }

    urlObservation = webView.observe(\.url, options: [.initial, .new]) { [weak self] view, _ in
      DispatchQueue.main.async { self?.follow(view.url) }
    }
    // The launcher's own screen changes are history updates; check now and
    // then as well.
    timers.append(Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      guard let self else { return }
      self.follow(self.webView?.url)
    })
    // The status poll. BriefingStore also refuses to ask the network more
    // than once a minute, so this and the other triggers cannot pile up.
    timers.append(Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
      guard UIApplication.shared.applicationState == .active else { return }
      self?.refreshStatus()
    })
    observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.refreshStatus()
    })
    // Paint the last known figures at once, then ask for fresh ones.
    apply(BriefingStore.read())
    refreshStatus()
  }

  private static func owningController(of view: UIView) -> UIViewController? {
    var responder: UIResponder? = view
    while let next = responder?.next {
      if let controller = next as? UIViewController { return controller }
      responder = next
    }
    return nil
  }

  private func moveSlot(to height: CGFloat) {
    slotConstraint?.constant = height
    guard let host else { return }
    if model.reduceMotion {
      host.layoutIfNeeded()
      return
    }
    UIView.animate(withDuration: 0.28, delay: 0, options: [.beginFromCurrentState, .curveEaseInOut]) { host.layoutIfNeeded() }
  }

  // MARK: Page bridge

  /// The page announces a finished turn with a window event; this passes it
  /// on so the figures refresh at once instead of at the next poll. The
  /// handler accepts one fixed word, from the game's own pages only.
  private func bridgeTurnComplete(on webView: WKWebView) {
    messages.controller = self
    let controller = webView.configuration.userContentController
    controller.removeScriptMessageHandler(forName: DockMessageHandler.name)
    controller.add(messages, name: DockMessageHandler.name)
    let script = """
      (function () {
        if (window.__ahdDockTurn) return;
        window.__ahdDockTurn = true;
        window.addEventListener('ahd:turn-complete', function () {
          try { window.webkit.messageHandlers.\(DockMessageHandler.name).postMessage('turn-complete'); } catch (e) {}
        });
      })();
      """
    controller.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    webView.evaluateJavaScript(script, completionHandler: nil)
  }

  /// Adds the marker to the webview's user agent. It applies from the next
  /// navigation, so a game page already loaded is reloaded once to pick it up.
  private func announceNativeStatus(on webView: WKWebView) {
    func set(_ base: String) {
      guard !base.contains(Self.statusMarker) else { return }
      webView.customUserAgent = base + " " + Self.statusMarker
      if let host = webView.url?.host, Self.gameHosts.contains(host) { webView.reload() }
    }
    if let agent = webView.customUserAgent, !agent.isEmpty {
      set(agent)
    } else {
      webView.evaluateJavaScript("navigator.userAgent") { result, _ in
        if let agent = result as? String, !agent.isEmpty { set(agent) }
      }
    }
  }

  fileprivate func turnCompleted() {
    guard Date().timeIntervalSince(lastTurnSignal) > 4 else { return }
    lastTurnSignal = Date()
    refreshStatus(maxAge: 3)
    // The clock can lag the turn by a moment; look once more.
    DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in self?.refreshStatus(maxAge: 3) }
  }

  // MARK: Tabs

  /// Taps, keyboard shortcuts and the More list all land here.
  func open(_ tab: Destination) {
    guard let webView else { return }
    let again = tab == current
    if !again { haptics.selectionChanged() }
    model.setExpanded(false)
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

  /// A row in the status sheet: a game page, never anything off the site.
  private func openGamePath(_ path: String) {
    guard let webView, let safe = BriefingStore.gamePath(path), let url = URL(string: siteOrigin() + safe) else { return }
    webView.load(URLRequest(url: url))
  }

  func reload() { webView?.reload() }
  func goBack() { if webView?.canGoBack == true { webView?.goBack() } }
  func goForward() { if webView?.canGoForward == true { webView?.goForward() } }
  func closeStatus() { model.setExpanded(false) }
  var statusIsOpen: Bool { model.expanded }

  private func siteOrigin() -> String {
    webView?.url?.host == Self.sandboxHost ? "https://" + Self.sandboxHost : Self.site
  }

  private func follow(_ url: URL?) {
    guard let tab = Self.destination(for: url) else { return }
    if tab == .game { lastGameURL = url }
    if url != lastURL {
      lastURL = url
      model.setExpanded(false)
    }
    let strip = Self.showsStatus(on: url, tab: tab)
    if strip != model.onStripPage {
      model.onStripPage = strip
      // Back on a game page: look for fresh figures.
      if strip { refreshStatus() }
    }
    guard tab != current else { return }
    // The player just read the inbox; ask the site for the new count.
    if current == .inbox { refreshStatus() }
    if tab == .inbox { inboxVisitedAt = Date() }
    current = tab
    select(tab)
    refreshBadge()
  }

  /// Game and Inbox pages carry the web status footer, except the bare ones.
  static func showsStatus(on url: URL?, tab: Destination) -> Bool {
    guard tab == .game || tab == .inbox, let url else { return false }
    let path = url.path.hasSuffix("/") ? String(url.path.dropLast()) : url.path
    return !bareGamePaths.contains(path)
  }

  private func select(_ tab: Destination?) {
    if model.selected != tab { model.selected = tab }
  }

  // MARK: Status

  /// Never blocks the UI: BriefingStore answers from its saved copy when the
  /// network is slow or down, and nothing here waits on it.
  private func refreshStatus(maxAge: TimeInterval = 60) {
    guard preview == nil else { return }
    BriefingStore.refresh(maxAge: maxAge) { [weak self] saved in self?.apply(saved) }
  }

  private func apply(_ saved: SavedBriefing?) {
    guard preview == nil else { return }
    let next = saved.map { DockStatus($0.data) }
    if model.status != next { model.status = next }
    refreshBadge(saved)
    scheduleTurnRefresh()
  }

  /// A look just after the turn clock runs out, so the new countdown shows
  /// without waiting for the next poll.
  private func scheduleTurnRefresh() {
    turnRefresh?.cancel()
    guard let next = model.status?.nextTurn else { return }
    let wait = next.timeIntervalSinceNow + 4
    guard wait > 0, wait < 6 * 3600 else { return }
    let work = DispatchWorkItem { [weak self] in self?.refreshStatus(maxAge: 3) }
    turnRefresh = work
    DispatchQueue.main.asyncAfter(deadline: .now() + wait, execute: work)
  }

  /// Unread count from the same snapshot the briefing and widgets use. Hidden
  /// on the Inbox itself and until a snapshot newer than the visit arrives.
  private func refreshBadge(_ snapshot: SavedBriefing? = BriefingStore.read()) {
    let unread = Int(snapshot?.data.inbox?.unread ?? 0)
    let fresh = (snapshot?.updatedAt ?? .distantPast) > inboxVisitedAt
    let value = unread > 0 && fresh && current != .inbox ? unread : 0
    if model.badge != value { model.badge = value }
  }

  private func applyPreview(_ state: String) {
    model.selected = state == "briefing" ? .briefing : .game
    model.onStripPage = state != "briefing"
    model.status = state == "signedout" ? nil : DockStatus.sample()
    model.badge = state == "signedout" ? 0 : 3
    if state == "expanded" {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.model.setExpanded(true, animated: false) }
    }
  }

  deinit {
    timers.forEach { $0.invalidate() }
    observers.forEach { NotificationCenter.default.removeObserver($0) }
  }
}

/// Receives the one message the page bridge can send.
private final class DockMessageHandler: NSObject, WKScriptMessageHandler {
  static let name = "ahdDock"
  weak var controller: NativeNavController?

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == Self.name, message.frameInfo.isMainFrame, (message.body as? String) == "turn-complete",
      let host = message.frameInfo.request.url?.host, NativeNavController.gameHosts.contains(host) else { return }
    controller?.turnCompleted()
  }
}

/// Holds the webview and the dock, and answers hardware keyboard
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
    // Esc closes the status sheet; it is only offered while the sheet is open.
    if controller?.statusIsOpen == true {
      let close = UIKeyCommand(title: "Close Status", action: #selector(closeStatus), input: UIKeyCommand.inputEscape)
      close.wantsPriorityOverSystemBehavior = true
      commands.append(close)
    }
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
  @objc private func closeStatus() { controller?.closeStatus() }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    // With nothing focused yet, shortcuts still need a responder to start from.
    if window != nil { DispatchQueue.main.async { [weak self] in _ = self?.becomeFirstResponder() } }
  }
}
