import Foundation
import UIKit
import ObjectiveC

/// Game links (https://ahousedividedgame.com/...) open the app instead of
/// Safari. Tao creates its app delegate at runtime, so the universal link
/// handler is added the way NativeQuickActions adds its own: only when absent.
/// Only safe game pages open in the app; anything else returns false and iOS
/// hands the link to Safari.
enum NativeLinks {
  /// Hosts the app claims. The sandbox host is not an associated domain.
  static let hosts: Set<String> = ["ahousedividedgame.com", "www.ahousedividedgame.com"]
  /// Never opened from a link: API, sign-in and account routes.
  private static let blocked = ["/api", "/login", "/auth", "/register", "/logout"]

  /// The game path (with query) a link maps to, or nil when the app must not open it.
  static func gamePath(for url: URL) -> String? {
    guard url.scheme == "https", let host = url.host?.lowercased(), hosts.contains(host),
      url.port == nil || url.port == 443, url.user == nil,
      let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    let path = parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
    let lowered = path.lowercased()
    for prefix in blocked where lowered == prefix || lowered.hasPrefix(prefix + "/") { return nil }
    if lowered.contains("%2f") || lowered.contains("%5c") || lowered.contains("/../") || lowered.hasSuffix("/..") { return nil }
    let query = parts.percentEncodedQuery.map { "?" + $0 } ?? ""
    return BriefingStore.gamePath(path + query)
  }
}

final class NativeLinkHandler: NSObject {
  static let shared = NativeLinkHandler()
  private var installed = false
  /// A link that arrived before the webview was ready (cold launch).
  private var pending: String?
  private var attempts = 0

  func install() {
    guard !installed, let delegate = UIApplication.shared.delegate else { return }
    let cls: AnyClass = type(of: delegate)
    let selector = NSSelectorFromString("application:continueUserActivity:restorationHandler:")
    guard class_getInstanceMethod(cls, selector) == nil else { return }
    let handler: @convention(block) (AnyObject, UIApplication, NSUserActivity, @escaping ([Any]?) -> Void) -> Bool = { _, _, activity, _ in
      guard activity.activityType == NSUserActivityTypeBrowsingWeb, let url = activity.webpageURL,
        let path = NativeLinks.gamePath(for: url) else { return false }
      DispatchQueue.main.async { NativeLinkHandler.shared.run(path) }
      return true
    }
    installed = class_addMethod(cls, selector, imp_implementationWithBlock(handler), "B@:@@@?")
  }

  /// Waits for the webview on cold launch, then uses the dock's opener.
  func run(_ path: String) {
    pending = path
    attempts = 0
    flush()
  }

  private func flush() {
    guard let path = pending else { return }
    if NativeNavController.shared.openLink(path) {
      pending = nil
    } else if attempts < 100 {
      attempts += 1
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.flush() }
    } else {
      pending = nil
    }
  }
}
