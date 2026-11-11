import Combine
import SafariServices
import SwiftUI
import WidgetKit
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
  private let openHaptic = UIImpactFeedbackGenerator(style: .light)
  private let closeHaptic = UIImpactFeedbackGenerator(style: .soft)
  private let turnHaptic = UINotificationFeedbackGenerator()
  private let refreshControl = UIRefreshControl()
  private var loadingObservation: NSKeyValueObservation?
  private let messages = DockMessageHandler()
  private var slotConstraint: NSLayoutConstraint?
  private var hosting: UIHostingController<DockView>?
  private var cancellables = Set<AnyCancellable>()
  private var onInboxPage = false
  /// The signed-in session's fingerprint; nil signed out. Keys the layout cache.
  private var layoutAccount: String?
  /// The game's language cookie, read from the webview; unknown until first read.
  private var layoutLocale: String?
  private var localeKnown = false
  /// The country the page is about (Nation follows the page); nil is home.
  private var layoutCountry: String?
  private var onSandbox = false
  private var layoutFetchedAt = [String: Date]()
  private var layoutInFlight: String?
  private var lastGameURL: URL?
  private var lastURL: URL?
  private var lastPlace = ""
  private weak var container: DockContainerView?
  private let loadView = NativeLoadView()
  private var inboxVisitedAt = Date.distantPast
  private var urlObservation: NSKeyValueObservation?
  private var turnRefresh: DispatchWorkItem?
  /// The figures the widgets last drew from, so a reload only follows a change.
  private var widgetFigures: Data?
  private var lastTurnSignal = Date.distantPast
  private var timers = [Timer]()
  private var observers = [NSObjectProtocol]()
  private let preview = NativeDockPreview.requestedState()

  func attach(_ webView: WKWebView) {
    self.webView = webView
    DockLayoutCache.removeLegacy()
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
    self.container = container

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
    homeInsetChanged()
    loadView.install(in: host, webView: webView, above: slot.topAnchor) { [weak self] in
      self?.perform(.launcher)
    }

    model.onTab = { [weak self] tab in self?.handle(tab) }
    model.onDragBegan = { [weak self] in
      self?.openHaptic.prepare()
      self?.closeHaptic.prepare()
    }
    model.onOpenPath = { [weak self] path in self?.openGamePath(path) }
    model.onOpenExternal = { [weak self] url in self?.openExternal(url) }
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
    // An open panel is modal for VoiceOver: the page behind it is out of
    // reach, and the panel's title is announced as it opens.
    model.$expanded.removeDuplicates().dropFirst().receive(on: DispatchQueue.main).sink { [weak self] open in
      guard let self else { return }
      if open { self.openHaptic.impactOccurred() } else { self.closeHaptic.impactOccurred() }
      self.openHaptic.prepare()
      self.closeHaptic.prepare()
      self.container?.accessibilityViewIsModal = open
      if open { UIAccessibility.post(notification: .screenChanged, argument: self.model.title(of: self.model.panel)) }
    }.store(in: &cancellables)
    model.$panel.removeDuplicates().dropFirst().receive(on: DispatchQueue.main).sink { [weak self] panel in
      guard let self, self.model.expanded else { return }
      UIAccessibility.post(notification: .screenChanged, argument: self.model.title(of: panel))
    }.store(in: &cancellables)
    // With the soft keyboard up the dock steps aside, as Android's does.
    observers.append(NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak self] note in
      self?.keyboardChanged(note)
    })
    observers.append(NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] _ in
      self?.model.setKeyboardUp(false)
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
    // The launcher's own screen changes are history updates the url
    // observation never sees; the launcher reports them through the handler.
    installLauncherReport(on: webView)
    installPullToRefresh(on: webView)
    // The status poll. BriefingStore also refuses to ask the network more
    // than once a minute, so this and the other triggers cannot pile up.
    timers.append(Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
      guard UIApplication.shared.applicationState == .active else { return }
      self?.refreshStatus()
    })
    observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.refreshStatus()
      if let url = self?.webView?.url, NativeLoadView.isGamePage(url) {
        NativeAlerts.shared.clearDelivered(viewing: DockTabs.path(url))
      }
      self?.refreshLocale()
      self?.refreshLayout(maxAge: 30)
    })
    refreshLocale()
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

  /// The home indicator inset of the window; the dock's bottom pad follows
  /// this and never the keyboard.
  func homeInsetChanged() {
    guard let inset = host?.window?.safeAreaInsets.bottom else { return }
    model.setHomeInset(inset)
  }

  private func keyboardChanged(_ note: Notification) {
    guard let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
    guard let window = host?.window else { return }
    // Judge the keyboard against the app's own window, in its coordinates:
    // on iPad in Split View, Slide Over or a smaller window the app does not
    // own the bottom of the screen.
    let local = window.convert(frame, from: window.screen.coordinateSpace)
    let docked = DockKeyboard.coversDock(keyboard: local, window: window.bounds)
    // A native sheet (Ask) has its own keyboard; the page behind it stays put.
    if docked, let host, Self.owningController(of: host)?.presentedViewController != nil { return }
    model.setKeyboardUp(docked)
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
      let truthful = DockUserAgent.truthful(base, isPad: UIDevice.current.userInterfaceIdiom == .pad, systemVersion: UIDevice.current.systemVersion)
      webView.customUserAgent = truthful + " " + Self.statusMarker
      if preview == nil, let host = webView.url?.host, Self.gameHosts.contains(host) { webView.reload() }
    }
    if let agent = webView.customUserAgent, !agent.isEmpty {
      set(agent)
    } else {
      webView.evaluateJavaScript("navigator.userAgent") { result, _ in
        if let agent = result as? String, !agent.isEmpty { set(agent) }
      }
    }
  }

  fileprivate func launcherMoved() {
    follow(webView?.url)
  }

  /// The launcher is the app's own page and changes screens with history
  /// updates, which the url observation does not see. It reports each one so
  /// no timer has to ask.
  private func installLauncherReport(on webView: WKWebView) {
    let script = """
      (function () {
        if (location.protocol !== 'tauri:' || window.__ahdDockNav) return;
        window.__ahdDockNav = true;
        function report() {
          try { window.webkit.messageHandlers.\(DockMessageHandler.name).postMessage('launcher-moved'); } catch (e) {}
        }
        ['pushState', 'replaceState'].forEach(function (name) {
          var original = history[name];
          history[name] = function () { var result = original.apply(this, arguments); report(); return result; };
        });
        window.addEventListener('popstate', report);
        window.addEventListener('hashchange', report);
      })();
      """
    webView.configuration.userContentController.addUserScript(
      WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    webView.evaluateJavaScript(script, completionHandler: nil)
  }

  /// Pull down at the top of a game page to reload it, with the system
  /// spinner. The launcher never gets one, and the control is only attached
  /// while a game page is showing.
  private func installPullToRefresh(on webView: WKWebView) {
    refreshControl.tintColor = .white
    refreshControl.addTarget(self, action: #selector(pulledToRefresh), for: .valueChanged)
    loadingObservation = webView.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
      guard !view.isLoading else { return }
      DispatchQueue.main.async { self?.endRefreshing() }
    }
  }

  @objc private func pulledToRefresh() {
    guard let webView, Self.isGamePageURL(webView.url) else {
      endRefreshing()
      return
    }
    webView.reload()
  }

  private func endRefreshing() {
    guard refreshControl.isRefreshing else { return }
    refreshControl.endRefreshing()
    turnHaptic.notificationOccurred(.success)
  }

  private static func isGamePageURL(_ url: URL?) -> Bool {
    guard let url else { return false }
    return url.scheme == "https" && gameHosts.contains(url.host ?? "")
  }

  /// A game page gets the control; the launcher gets none.
  private func syncRefreshControl(for url: URL) {
    guard let scrollView = webView?.scrollView else { return }
    if Self.isGamePageURL(url) {
      if scrollView.refreshControl == nil { scrollView.refreshControl = refreshControl }
    } else if scrollView.refreshControl != nil {
      refreshControl.endRefreshing()
      scrollView.refreshControl = nil
    }
  }

  /// A link to an outside site opens in a Safari sheet over the game. The
  /// check is looser than the dock's own list: any plain https address.
  func openExternalPage(_ url: URL) {
    DispatchQueue.main.async { [weak self] in
      guard let self, url.scheme == "https", url.user == nil, url.password == nil, url.host != nil else { return }
      let safari = SFSafariViewController(url: url)
      safari.preferredBarTintColor = Self.background
      safari.preferredControlTintColor = .white
      self.topController()?.present(safari, animated: true)
    }
  }

  fileprivate func turnCompleted() {
    guard Date().timeIntervalSince(lastTurnSignal) > 4 else { return }
    lastTurnSignal = Date()
    turnHaptic.notificationOccurred(.success)
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
    case .alerts:
      NativeAlerts.shared.showManager(from: topController())
      return
    case .launcher:
      if let url = URL(string: Self.launcher) { webView.load(URLRequest(url: url)) }
    }
    if let tab { select(tab.id) }
  }

  /// A Home Screen quick action. Signed-out players land on the launcher, the
  /// rest use the same openers as the dock. False means the webview is not ready yet.
  func openQuickAction(_ action: QuickAction) -> Bool {
    guard let webView, let current = webView.url, current.absoluteString != "about:blank" else { return false }
    guard !(BriefingStore.session() ?? "").isEmpty else {
      if let url = URL(string: Self.launcher) { webView.load(URLRequest(url: url)) }
      return true
    }
    model.close()
    switch action {
    case .inbox: perform(.inbox)
    case .briefing: perform(.briefing)
    case .ask: perform(.ask)
    case .actions: openGamePath("/actions")
    }
    return true
  }

  /// A game link that opened the app. Signed-out players land on the launcher.
  /// False means the webview is not ready yet.
  func openLink(_ path: String) -> Bool {
    guard let webView, let current = webView.url, current.absoluteString != "about:blank" else { return false }
    model.close()
    guard !(BriefingStore.session() ?? "").isEmpty else {
      if let url = URL(string: Self.launcher) { webView.load(URLRequest(url: url)) }
      return true
    }
    // The link names the live site, so it opens there even from the sandbox.
    if let url = URL(string: Self.site + path) { webView.load(URLRequest(url: url)) }
    return true
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
    if isGame && !inbox {
      lastGameURL = url
      rememberGamePage(url, path: path)
    }
    lastURL = url
    syncRefreshControl(for: url)
    // Only a move to another page closes the open sheet; a query or hash
    // update on the same page (a tabbed page syncing its tab) leaves it be.
    let place = (url.host ?? "") + path
    if place != lastPlace {
      lastPlace = place
      if isGame { NativeAlerts.shared.clearDelivered(viewing: path) }
      model.close()
      pageMoved(url, path: path, isGame: isGame)
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

  /// A new page: sign-out pages drop the dock to the app tabs at once, the
  /// sandbox gets the app tabs, a country page moves Nation to that country,
  /// and the language cookie is looked at again.
  private func pageMoved(_ url: URL, path: String, isGame: Bool) {
    guard isGame else { return }
    if DockTabs.signedOutPaths.contains(path) {
      signedOutNavigation()
      return
    }
    // A vanished session drops the dock to the app tabs now, not at the next poll.
    syncAccount()
    let sandbox = url.host == Self.sandboxHost
    if sandbox != onSandbox {
      onSandbox = sandbox
      // The sandbox is another world: the production account's tabs do not apply.
      reapplyLayout(strict: true)
      if !sandbox { refreshLayout(maxAge: 0) }
    }
    if !sandbox {
      let country = DockTabs.country(inPath: path)
      if country != layoutCountry {
        layoutCountry = country
        reapplyLayout(strict: false)
        refreshLayout(maxAge: 300)
      }
    }
    refreshLocale()
  }

  /// Keep the live page for the next launch. Signed-in only, live host only,
  /// and never a sign-in page; the fingerprint ties it to this session.
  private func rememberGamePage(_ url: URL, path: String) {
    guard url.host == "ahousedividedgame.com", let account = layoutAccount else { return }
    let first = path.split(separator: "/").first.map(String.init) ?? ""
    guard !["login", "register", "logout", "auth", "api"].contains(first) else { return }
    let page = path + (url.query.map { "?" + $0 } ?? "")
    guard let safe = BriefingStore.gamePath(page) else { return }
    LastGameStore.save(path: safe, account: account)
  }

  /// /login, /register or /logout: forget the account's tabs now, then let
  /// the status poll say whether a session survived.
  private func signedOutNavigation() {
    if let account = layoutAccount { DockLayoutCache.clear(account: account) }
    LastGameStore.clear()
    layoutAccount = nil
    layoutFetchedAt.removeAll()
    model.setLayout(nil)
    NativeAlerts.shared.cancelReminder()
    refreshStatus(maxAge: 0)
  }

  /// Rows the game marks external open outside the game webview: a Safari
  /// sheet for https, the mail app for mailto. Never `webView.load`.
  private func openExternal(_ url: URL) {
    guard DockExternal.url(url.absoluteString) != nil else { return }
    if url.scheme == "https" {
      let safari = SFSafariViewController(url: url)
      safari.preferredBarTintColor = Self.background
      safari.preferredControlTintColor = .white
      topController()?.present(safari, animated: true)
    } else {
      UIApplication.shared.open(url)
    }
  }

  private func topController() -> UIViewController? {
    var top = host.flatMap { Self.owningController(of: $0) }
    while let next = top?.presentedViewController { top = next }
    return top
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
    syncAccount()
    refreshBadge(saved)
    reloadWidgetsIfChanged(saved)
    scheduleTurnRefresh()
    if let saved { NativeAlerts.shared.updateBadge(unread: saved.data.inbox?.unread ?? 0) }
    offerAlerts(saved)
    NativeAlerts.shared.syncReminder(signedIn: saved != nil && layoutAccount != nil)
  }

  /// Widgets draw from the same snapshot. When the dock sees new figures, ask
  /// for a reload, but only if they changed: reloads count against a daily budget.
  private func reloadWidgetsIfChanged(_ saved: SavedBriefing?) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    let figures = saved.flatMap { try? encoder.encode($0.data) }
    guard figures != widgetFigures else { return }
    let first = widgetFigures == nil
    widgetFigures = figures
    // The first look after launch is the baseline; the app already reloads then.
    if !first { WidgetCenter.shared.reloadAllTimelines() }
  }

  /// The one-time alerts question, a moment after the first signed-in status
  /// load, never over a panel or another sheet, and only on a game page.
  private func offerAlerts(_ saved: SavedBriefing?) {
    guard saved != nil, layoutAccount != nil, !NativeAlerts.shared.asked else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
      guard let self, UIApplication.shared.applicationState == .active, !self.model.expanded,
        self.topController()?.presentedViewController == nil else { return }
      let onGame = self.webView?.url.map { NativeLoadView.isGamePage($0) && !self.onInboxPage } ?? false
      NativeAlerts.shared.askOnce(from: self.topController(), signedIn: self.layoutAccount != nil,
        statusLoaded: true, onGamePage: onGame)
    }
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

  /// The cache key for the dock on show: session, language, country.
  private func layoutKey() -> String? {
    layoutAccount.map { DockLayoutCache.key(account: $0, locale: layoutLocale, country: layoutCountry) }
  }

  /// Show the cached tabs for the current key. `strict` also drops to the app
  /// tabs when there is nothing cached; otherwise the dock keeps what it has
  /// until fresh tabs arrive. Signed out or on the sandbox: app tabs.
  private func reapplyLayout(strict: Bool) {
    guard layoutAccount != nil, !onSandbox else {
      model.setLayout(nil)
      return
    }
    if let cached = DockLayoutCache.load(key: layoutKey()) {
      model.setLayout(cached)
    } else if strict {
      model.setLayout(nil)
    }
  }

  /// The signed-in session decides the account: a different one (or none)
  /// swaps the dock to that account's cached tabs, or to the app tabs, at
  /// once, and a fresh copy is asked for behind it. The old account's cache
  /// goes with its session.
  private func syncAccount() {
    let next = BriefingStore.sessionFingerprint()
    guard next != layoutAccount else { return }
    if let old = layoutAccount { DockLayoutCache.clear(account: old) }
    if next == nil || layoutAccount != nil { LastGameStore.clear() }
    layoutAccount = next
    layoutFetchedAt.removeAll()
    if next == nil || localeKnown { reapplyLayout(strict: true) }
    if next != nil { refreshLayout(maxAge: 0) }
  }

  /// Reads the game's `ahd-locale` cookie from the webview. The game picks its
  /// language from that cookie alone; a change swaps to that language's cached
  /// tabs and asks for fresh ones.
  private func refreshLocale(then run: (() -> Void)? = nil) {
    guard let store = webView?.configuration.websiteDataStore.httpCookieStore else {
      run?()
      return
    }
    store.getAllCookies { [weak self] cookies in
      DispatchQueue.main.async {
        guard let self else { return }
        let value = cookies.first { $0.name == "ahd-locale" && $0.domain.hasSuffix("ahousedividedgame.com") }?.value
        let locale = DockLocale.valid(value)
        let first = !self.localeKnown
        let changed = first || locale != self.layoutLocale
        self.localeKnown = true
        self.layoutLocale = locale
        if changed && self.layoutAccount != nil {
          self.reapplyLayout(strict: first)
          self.refreshLayout(maxAge: 0)
        }
        run?()
      }
    }
  }

  /// Never blocks the UI. A failure keeps whatever the dock already has.
  private func refreshLayout(maxAge: TimeInterval) {
    guard preview == nil, !onSandbox, layoutAccount != nil else { return }
    guard localeKnown else {
      refreshLocale { [weak self] in self?.refreshLayout(maxAge: maxAge) }
      return
    }
    guard layoutInFlight == nil, let key = layoutKey(), let account = layoutAccount,
      Date().timeIntervalSince(layoutFetchedAt[key] ?? .distantPast) >= maxAge,
      let cookie = BriefingStore.session(), !cookie.isEmpty else { return }
    layoutInFlight = key
    layoutFetchedAt[key] = Date()
    DockLayoutClient.fetch(cookie: cookie, locale: layoutLocale, country: layoutCountry) { [weak self] outcome in
      guard let self else { return }
      self.layoutInFlight = nil
      // The session may have changed while the request was out: adopt it.
      guard BriefingStore.sessionFingerprint() == account else {
        self.syncAccount()
        return
      }
      // So may the language, the country or the world: ask again for what is on show now.
      guard self.layoutKey() == key, !self.onSandbox else {
        self.refreshLayout(maxAge: 0)
        return
      }
      switch outcome {
      case .layout(let layout, let bytes):
        DockLayoutCache.save(bytes, key: key)
        self.model.setLayout(layout)
      case .signedOut:
        DockLayoutCache.clear(account: account)
        self.model.setLayout(nil)
      case .unavailable:
        break
      }
    }
  }

  private func applyPreview(_ state: String) {
    if state == "offline" {
      loadView.showPreview()
      model.setLayout(DockFixture.layout)
      select("game")
      model.onStripPage = false
      return
    }
    let signedOut = state == "signedout" || state == "briefing"
    model.setLayout(signedOut ? nil : DockFixture.layout)
    // The strip lives on game pages, so the strip states show a stand-in game
    // page, not the launcher the app opened on.
    if !signedOut, let webView {
      webView.loadHTMLString(NativeDockPreview.standInPage, baseURL: URL(string: Self.site))
    }
    select(state == "briefing" ? "briefing" : signedOut ? "game" : "state")
    model.onStripPage = !signedOut
    model.status = signedOut ? nil : DockStatus.sample()
    model.badge = signedOut ? 0 : 3
    if state == "alerts" {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
        NativeAlerts.shared.present(.ask, from: self?.topController(), preview: true)
      }
    }
    if state == "reminder" {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
        NativeAlerts.shared.present(.on, from: self?.topController(), preview: true)
      }
    }
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
    guard message.name == Self.name, message.frameInfo.isMainFrame, let body = message.body as? String,
      let url = message.frameInfo.request.url else { return }
    if body == "launcher-moved", url.scheme == "tauri", url.host == "localhost" {
      controller?.launcherMoved()
    } else if body == "turn-complete", let host = url.host, NativeNavController.gameHosts.contains(host) {
      controller?.turnCompleted()
    }
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

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    controller?.homeInsetChanged()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    controller?.homeInsetChanged()
    // With nothing focused yet, shortcuts still need a responder to start from.
    if window != nil { DispatchQueue.main.async { [weak self] in _ = self?.becomeFirstResponder() } }
  }
}
