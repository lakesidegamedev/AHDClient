import Combine
import SwiftUI
import UIKit
import WebKit

/// The dock, in place of the floating AHD button the site pages used to carry.
/// The game says what its tabs are (GET /api/mobile-dock); signed out, or on
/// a game that does not answer, the dock falls back to Game, Briefing, Ask and
/// More so nobody is stuck. One WKWebView still shows everything; a tab is a
/// page in it, a native sheet, or the native Ask sheet, and the dock follows
/// whatever page the webview is on, however the player got there. The dock
/// itself is SwiftUI (NativeDock*.swift).
///
/// The webview is moved into a host view and ends where the dock begins, so
/// the page ends above the dock at every inset. The dock layer covers the
/// host but only takes touches on the dock, or everywhere while a panel is
/// open. The host is also where hardware keyboard shortcuts live: it sits in
/// the responder chain above the webview, so Cmd+1 to Cmd+5 (the dock's tabs,
/// left to right) work while a page field has focus. iPad uses the same dock,
/// centered with a maximum width.
final class NativeNavController: NSObject {
  static let shared = NativeNavController()

  static let site = "https://ahousedividedgame.com"
  static let sandboxHost = "sandbox.ahousedividedgame.com"
  static let launcher = "tauri://localhost/"
  static let background = UIColor(red: 0x14 / 255, green: 0x14 / 255, blue: 0x1c / 255, alpha: 1)
  static let accent = UIColor(red: 0xdc / 255, green: 0x26 / 255, blue: 0x26 / 255, alpha: 1)

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
  private var onInboxPage = false
  private var layoutAccount: String?
  private var layoutFetchedAt = Date.distantPast
  private var layoutInFlight = false
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

    model.onTab = { [weak self] tab in self?.handle(tab) }
    model.onOpenPath = { [weak self] path in self?.openGamePath(path) }
    model.onApp = { [weak self] app in self?.perform(app) }
    // A new layout can move the page to a different tab; look again.
    model.$layout.dropFirst().receive(on: DispatchQueue.main).sink { [weak self] _ in
      guard let self else { return }
      self.select(self.selection(for: self.lastURL))
    }.store(in: &cancellables)
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
      self?.refreshLayout(maxAge: 30)
    })
    // Paint the last known figures and the cached tabs at once, then ask for fresh ones.
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

  /// A tap on a tab, or a Cmd+number: the tab does what the game (or the app,
  /// for its own tabs) says it does.
  func handle(_ tab: DockTab) {
    guard webView != nil else { return }
    if model.displayedID != tab.id { haptics.selectionChanged() }
    switch tab.kind {
    case .sheet(let key):
      model.toggleSheet(key)
    case .page(let href):
      model.close()
      openGamePath(href)
      // Highlight the tab at once; following the page corrects it if the
      // navigation is refused.
      select(tab.id)
    case .app(let app):
      model.close()
      perform(app, from: tab)
    }
  }

  /// Cmd+1 to Cmd+5: the dock's tabs, left to right.
  func openTab(at index: Int) {
    guard model.tabs.indices.contains(index) else { return }
    handle(model.tabs[index])
  }

  var tabTitles: [String] { model.tabs.map { $0.label } }

  /// The app's own destinations, from a tab or from the More sheet.
  func perform(_ app: DockApp, from tab: DockTab? = nil) {
    guard let webView else { return }
    let again = tab.map { $0.id == model.selectedID } ?? false
    let site = siteOrigin()
    switch app {
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
      return
    case .launcher:
      if let url = URL(string: Self.launcher) { webView.load(URLRequest(url: url)) }
    }
    if let tab { select(tab.id) }
  }

  /// A row in a sheet or the status: a game page, never anything off the site.
  private func openGamePath(_ path: String) {
    guard let webView, let safe = BriefingStore.gamePath(path), let url = URL(string: siteOrigin() + safe) else { return }
    webView.load(URLRequest(url: url))
  }

  func reload() { webView?.reload() }
  func goBack() { if webView?.canGoBack == true { webView?.goBack() } }
  func goForward() { if webView?.canGoForward == true { webView?.goForward() } }
  func closePanel() { model.close() }
  var panelIsOpen: Bool { model.expanded }

  private func siteOrigin() -> String {
    webView?.url?.host == Self.sandboxHost ? "https://" + Self.sandboxHost : Self.site
  }

  private static func isOurPage(_ url: URL?) -> Bool {
    guard let url, let host = url.host else { return false }
    if url.scheme == "tauri" && host == "localhost" { return true }
    return url.scheme == "https" && gameHosts.contains(host)
  }

  private func selection(for url: URL?) -> String? {
    DockTabs.selection(for: url, tabs: model.tabs, usingGameTabs: model.usingGameTabs)
  }

  private func follow(_ url: URL?) {
    guard Self.isOurPage(url), let url else { return }
    let isGame = url.scheme == "https"
    let path = DockTabs.path(url)
    let inbox = isGame && path == "/notifications"
    if isGame && !inbox { lastGameURL = url }
    if url != lastURL {
      lastURL = url
      model.close()
    }
    let strip = Self.showsStatus(on: url)
    if strip != model.onStripPage {
      model.onStripPage = strip
      // Back on a game page: look for fresh figures.
      if strip { refreshStatus() }
    }
    if inbox != onInboxPage {
      // The player just read the inbox; ask the site for the new count.
      if onInboxPage { refreshStatus() }
      if inbox { inboxVisitedAt = Date() }
      onInboxPage = inbox
      refreshBadge()
    }
    let tab = selection(for: url)
    guard tab != model.selectedID else { return }
    // A new section of the game can change what the game wants in the dock.
    if model.selectedID != nil { refreshLayout(maxAge: 300) }
    select(tab)
  }

  /// Game pages carry the web status footer, except the bare ones.
  static func showsStatus(on url: URL?) -> Bool {
    guard let url, url.scheme == "https", let host = url.host, gameHosts.contains(host) else { return false }
    return !bareGamePaths.contains(DockTabs.path(url))
  }

  private func select(_ id: String?) {
    if model.selectedID != id { model.selectedID = id }
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
    syncAccount(saved)
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

  /// Unread count from the same snapshot the briefing and widgets use, shown
  /// on More. Hidden on the Inbox itself and until a snapshot newer than the
  /// visit arrives.
  private func refreshBadge(_ snapshot: SavedBriefing? = BriefingStore.read()) {
    let unread = Int(snapshot?.data.inbox?.unread ?? 0)
    let fresh = (snapshot?.updatedAt ?? .distantPast) > inboxVisitedAt
    let value = unread > 0 && fresh && !onInboxPage ? unread : 0
    if model.badge != value { model.badge = value }
  }

  // MARK: Layout

  /// Which account the dock layout belongs to: the character's name, or the
  /// session when the player has no character yet. Nil when signed out.
  private func account(of saved: SavedBriefing?) -> String? {
    guard let saved else { return nil }
    return DockLayoutCache.accountKey(saved.data.name) ?? "s-" + String(saved.sessionId.prefix(16))
  }

  /// A different account (or none) swaps the dock to that account's cached
  /// tabs, or to the app tabs, at once; a fresh copy is asked for behind it.
  private func syncAccount(_ saved: SavedBriefing?) {
    let next = account(of: saved)
    guard next != layoutAccount else { return }
    layoutAccount = next
    layoutFetchedAt = .distantPast
    model.setLayout(DockLayoutCache.load(account: next))
    if next != nil { refreshLayout(maxAge: 0) }
  }

  /// Never blocks the UI. A failure keeps whatever the dock already has.
  private func refreshLayout(maxAge: TimeInterval) {
    guard preview == nil, !layoutInFlight, let account = layoutAccount,
      Date().timeIntervalSince(layoutFetchedAt) >= maxAge,
      let cookie = BriefingStore.session(), !cookie.isEmpty else { return }
    layoutInFlight = true
    layoutFetchedAt = Date()
    DockLayoutClient.fetch(cookie: cookie) { [weak self] outcome in
      guard let self else { return }
      self.layoutInFlight = false
      // The player may have switched account while the request was out.
      guard self.layoutAccount == account else { return }
      switch outcome {
      case .layout(let layout, let bytes):
        DockLayoutCache.save(bytes, account: account)
        self.model.setLayout(layout)
      case .signedOut:
        self.model.setLayout(nil)
      case .unavailable:
        break
      }
    }
  }

  private func applyPreview(_ state: String) {
    let signedOut = state == "signedout" || state == "briefing"
    model.setLayout(signedOut ? nil : DockFixture.layout)
    select(state == "briefing" ? "briefing" : signedOut ? "game" : "state")
    model.onStripPage = !signedOut
    model.status = signedOut ? nil : DockStatus.sample()
    model.badge = signedOut ? 0 : 3
    let panel: DockPanel? = state == "expanded" ? .status : state == "sheet" ? .sheet("state") : state == "more" ? .sheet("more") : nil
    if let panel {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.model.open(panel, animated: false) }
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
    // Cmd+1 to Cmd+5 are the dock's tabs, whatever the game or the fallback made them.
    var commands = (controller?.tabTitles ?? []).prefix(9).enumerated().map { index, title in
      command(title, input: String(index + 1), action: #selector(openTab(_:)), tag: index)
    }
    commands.append(command("Ask", input: "k", action: #selector(openAsk)))
    commands.append(command("Reload Page", input: "r", action: #selector(reloadPage)))
    commands.append(command("Back", input: "[", action: #selector(goBack)))
    commands.append(command("Forward", input: "]", action: #selector(goForward)))
    // Esc closes the open panel; it is only offered while one is open.
    if controller?.panelIsOpen == true {
      let close = UIKeyCommand(title: "Close", action: #selector(closePanel), input: UIKeyCommand.inputEscape)
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
    guard let index = sender.propertyList as? Int else { return }
    controller?.openTab(at: index)
  }

  @objc private func openAsk() { controller?.perform(.ask) }
  @objc private func reloadPage() { controller?.reload() }
  @objc private func goBack() { controller?.goBack() }
  @objc private func goForward() { controller?.goForward() }
  @objc private func closePanel() { controller?.closePanel() }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    // With nothing focused yet, shortcuts still need a responder to start from.
    if window != nil { DispatchQueue.main.async { [weak self] in _ = self?.becomeFirstResponder() } }
  }
}
