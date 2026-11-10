import ObjectiveC
import UIKit
import WebKit

/// Load feedback for the one webview: a thin progress bar above the dock while
/// a page loads, and a "cannot reach the game" screen when the page fails to
/// load. wry installs a navigation delegate that enforces the host allowlist,
/// so this one wraps it: everything is forwarded to the original delegate, and
/// the load callbacks are only observed. It never decides a navigation.
final class NativeLoadDelegate: NSObject, WKNavigationDelegate {
  private static var key: UInt8 = 0
  private let inner: WKNavigationDelegate?
  var onStart: ((URL?) -> Void)?
  var onProgress: ((Double) -> Void)?
  var onFinish: (() -> Void)?
  var onFail: ((URL?, Error) -> Void)?

  private init(inner: WKNavigationDelegate?) {
    self.inner = inner
  }

  @discardableResult
  static func install(on webview: WKWebView) -> NativeLoadDelegate {
    if let existing = webview.navigationDelegate as? NativeLoadDelegate { return existing }
    let proxy = NativeLoadDelegate(inner: webview.navigationDelegate)
    // navigationDelegate is weak; the webview owns the proxy through this association.
    objc_setAssociatedObject(webview, &key, proxy, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    webview.navigationDelegate = proxy
    return proxy
  }

  /// Errors that are not a failed load: a redirect or a new tap cancelled the
  /// previous request (-999), or the page asked to be handled elsewhere (102).
  static func isIgnorable(_ error: Error) -> Bool {
    let ns = error as NSError
    if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return true }
    if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return true }
    return false
  }

  override func responds(to aSelector: Selector!) -> Bool {
    super.responds(to: aSelector) || (inner?.responds(to: aSelector) ?? false)
  }

  override func forwardingTarget(for aSelector: Selector!) -> Any? {
    if let inner = inner, inner.responds(to: aSelector) { return inner }
    return super.forwardingTarget(for: aSelector)
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    onStart?(webView.url)
    inner?.webView?(webView, didStartProvisionalNavigation: navigation)
  }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    inner?.webView?(webView, didCommit: navigation)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    onFinish?()
    inner?.webView?(webView, didFinish: navigation)
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    onFail?(webView.url, error)
    inner?.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    onFail?(webView.url, error)
    inner?.webView?(webView, didFail: navigation, withError: error)
  }
}

/// The bar and the screen. Lives in the nav host, between the page and the dock.
final class NativeLoadView: NSObject {
  private weak var webView: WKWebView?
  private let bar = UIView()
  private let screen = UIView()
  private var progressObservation: NSKeyValueObservation?
  private var barWidth: NSLayoutConstraint?
  private var hideWork: DispatchWorkItem?
  private var failedURL: URL?
  private var onBack: (() -> Void)?
  private var previewing = false

  /// `above` is the top of the dock slot; the bar sits on it and the screen
  /// fills the page area up to it.
  func install(in host: UIView, webView: WKWebView, above: NSLayoutYAxisAnchor, onBack: @escaping () -> Void) {
    self.webView = webView
    self.onBack = onBack

    screen.backgroundColor = NativeNavController.background
    screen.translatesAutoresizingMaskIntoConstraints = false
    screen.isHidden = true
    screen.accessibilityViewIsModal = true
    host.insertSubview(screen, aboveSubview: webView)
    buildScreen()

    bar.backgroundColor = NativeNavController.accent
    bar.translatesAutoresizingMaskIntoConstraints = false
    bar.isHidden = true
    bar.isUserInteractionEnabled = false
    bar.isAccessibilityElement = false
    host.insertSubview(bar, aboveSubview: screen)

    let width = bar.widthAnchor.constraint(equalToConstant: 0)
    barWidth = width
    NSLayoutConstraint.activate([
      screen.topAnchor.constraint(equalTo: host.topAnchor),
      screen.leadingAnchor.constraint(equalTo: host.leadingAnchor),
      screen.trailingAnchor.constraint(equalTo: host.trailingAnchor),
      screen.bottomAnchor.constraint(equalTo: above),
      bar.leadingAnchor.constraint(equalTo: host.leadingAnchor),
      bar.bottomAnchor.constraint(equalTo: above),
      bar.heightAnchor.constraint(equalToConstant: 2),
      width,
    ])

    progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] view, _ in
      DispatchQueue.main.async { self?.progress(view.estimatedProgress) }
    }

    let load = NativeLoadDelegate.install(on: webView)
    load.onStart = { [weak self] _ in DispatchQueue.main.async { self?.started() } }
    load.onFinish = { [weak self] in DispatchQueue.main.async { self?.finished() } }
    load.onFail = { [weak self] url, error in
      DispatchQueue.main.async { self?.failed(url: url, error: error) }
    }
  }

  private func buildScreen() {
    let title = UILabel()
    title.text = "Cannot reach the game"
    title.font = UIFontMetrics(forTextStyle: .title2).scaledFont(for: .systemFont(ofSize: 22, weight: .bold))
    title.adjustsFontForContentSizeCategory = true
    title.textColor = .white
    title.textAlignment = .center
    title.numberOfLines = 0

    let detail = UILabel()
    detail.text = "Check your connection and try again."
    detail.font = UIFont.preferredFont(forTextStyle: .body)
    detail.adjustsFontForContentSizeCategory = true
    detail.textColor = UIColor(white: 1, alpha: 0.65)
    detail.textAlignment = .center
    detail.numberOfLines = 0

    let retry = UIButton(type: .system)
    retry.setTitle("Retry", for: .normal)
    retry.titleLabel?.font = UIFont.preferredFont(forTextStyle: .headline)
    retry.titleLabel?.adjustsFontForContentSizeCategory = true
    retry.setTitleColor(.white, for: .normal)
    retry.backgroundColor = NativeNavController.accent
    retry.layer.cornerRadius = 12
    retry.contentEdgeInsets = UIEdgeInsets(top: 12, left: 28, bottom: 12, right: 28)
    retry.accessibilityIdentifier = "load-retry"
    retry.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)

    let back = UIButton(type: .system)
    back.setTitle("Back to launcher", for: .normal)
    back.titleLabel?.font = UIFont.preferredFont(forTextStyle: .body)
    back.titleLabel?.adjustsFontForContentSizeCategory = true
    back.setTitleColor(UIColor(white: 1, alpha: 0.8), for: .normal)
    back.accessibilityIdentifier = "load-back"
    back.addTarget(self, action: #selector(backTapped), for: .touchUpInside)

    let stack = UIStackView(arrangedSubviews: [title, detail, retry, back])
    stack.axis = .vertical
    stack.alignment = .center
    stack.spacing = 14
    stack.setCustomSpacing(22, after: detail)
    stack.translatesAutoresizingMaskIntoConstraints = false
    screen.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerYAnchor.constraint(equalTo: screen.centerYAnchor),
      stack.leadingAnchor.constraint(greaterThanOrEqualTo: screen.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(lessThanOrEqualTo: screen.trailingAnchor, constant: -24),
      stack.centerXAnchor.constraint(equalTo: screen.centerXAnchor),
      stack.widthAnchor.constraint(lessThanOrEqualToConstant: 420),
    ])
  }

  /// Screenshot mode: the screen with no network and no load behind it.
  func showPreview() {
    previewing = true
    screen.isHidden = false
  }

  private func started() {
    if previewing { return }
    // A new attempt clears the old failure so a retry can show progress.
    screen.isHidden = true
    hideWork?.cancel()
    setProgress(0.08)
  }

  private func progress(_ value: Double) {
    guard webView?.isLoading == true else { return }
    setProgress(max(value, 0.08))
  }

  private func finished() {
    setProgress(1)
    let work = DispatchWorkItem { [weak self] in self?.bar.isHidden = true }
    hideWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
  }

  private func failed(url: URL?, error: Error) {
    if NativeLoadDelegate.isIgnorable(error) { return }
    hideWork?.cancel()
    bar.isHidden = true
    // The launcher is bundled, so only a game page can be unreachable. The
    // failing URL is on the error for a provisional failure; webView.url may
    // still be the previous page.
    let failing = ((error as NSError).userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? url
    guard let failing, Self.isGamePage(failing) else { return }
    failedURL = failing
    screen.isHidden = false
    UIAccessibility.post(notification: .screenChanged, argument: screen)
  }

  static func isGamePage(_ url: URL) -> Bool {
    url.scheme == "https" && NativeNavController.gameHosts.contains((url.host ?? "").lowercased())
  }

  private func setProgress(_ value: Double) {
    guard let host = bar.superview else { return }
    bar.isHidden = false
    barWidth?.constant = host.bounds.width * CGFloat(min(max(value, 0), 1))
    UIView.animate(withDuration: 0.2) { host.layoutIfNeeded() }
  }

  @objc private func retryTapped() {
    guard let webView else { return }
    screen.isHidden = true
    if let url = failedURL {
      webView.load(URLRequest(url: url))
    } else {
      webView.reload()
    }
  }

  @objc private func backTapped() {
    screen.isHidden = true
    onBack?()
  }
}
