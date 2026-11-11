import Foundation
import UIKit
import ObjectiveC

/// Home Screen quick actions (long press the app icon). The items live in
/// Info.ios.plist so they show before the app has ever run. Tao creates its
/// app delegate at runtime, so the handler is added the way NativePush adds
/// its APNs callbacks: only when absent, never replacing anything.
enum QuickAction: String, CaseIterable {
  case inbox, actions, ask, briefing

  static let prefix = "net.lakesidegames.ahdclient.quick."

  init?(type: String) {
    guard type.hasPrefix(Self.prefix) else { return nil }
    self.init(rawValue: String(type.dropFirst(Self.prefix.count)))
  }
}

final class NativeQuickActions: NSObject {
  static let shared = NativeQuickActions()
  private var installed = false
  /// An action that arrived before the webview was ready (cold launch).
  private var pending: QuickAction?
  private var attempts = 0

  func install() {
    guard !installed, let delegate = UIApplication.shared.delegate else { return }
    let cls: AnyClass = type(of: delegate)
    let selector = NSSelectorFromString("application:performActionForShortcutItem:completionHandler:")
    guard class_getInstanceMethod(cls, selector) == nil else { return }
    let handler: @convention(block) (AnyObject, UIApplication, UIApplicationShortcutItem, @escaping (Bool) -> Void) -> Void = { _, _, item, done in
      DispatchQueue.main.async {
        let action = QuickAction(type: item.type)
        if let action { NativeQuickActions.shared.run(action) }
        done(action != nil)
      }
    }
    installed = class_addMethod(cls, selector, imp_implementationWithBlock(handler), "v@:@@@?")
  }

  /// Runs through the dock's own openers. Waits for the webview on cold launch.
  func run(_ action: QuickAction) {
    pending = action
    attempts = 0
    flush()
  }

  private func flush() {
    guard let action = pending else { return }
    if NativeNavController.shared.openQuickAction(action) {
      pending = nil
    } else if attempts < 100 {
      attempts += 1
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.flush() }
    } else {
      pending = nil
    }
  }
}
