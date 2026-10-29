import Foundation
import UIKit
import UserNotifications
import WebKit
import Security
import ObjectiveC
import CryptoKit

private struct PushDisk: Codable {
  var enabled = false
  var token = ""
  var registeredSession = ""
  var observedSession = ""
  var mayBeRegistered = false
  var needsRevoke = false
}

/// Native state is confined to the main queue. Cookies and tokens never enter JavaScript.
final class NativePush: NSObject, UNUserNotificationCenterDelegate, URLSessionTaskDelegate {
  static let shared = NativePush()
  private var state = PushDisk()
  private weak var webview: WKWebView?
  private var permission = false
  private var installed = false
  private var busy = false
  private var registering = false
  private var nextAttempt = Date.distantPast
  private var message = "Turn on alerts for new inbox activity."
  /// The game page a tapped alert asked for, opened once the webview is ready.
  private var pendingPath: String?
  private var navigationAttempts = 0
  private let origin = "https://ahousedividedgame.com"
  private lazy var client: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 12
    config.timeoutIntervalForResource = 15
    config.httpCookieStorage = nil
    config.urlCache = nil
    return URLSession(configuration: config, delegate: self, delegateQueue: nil)
  }()
  private var stateURL: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("native-push.json")
  }
  override init() {
    super.init()
    if let data = try? Data(contentsOf: stateURL), let saved = try? JSONDecoder().decode(PushDisk.self, from: data) { state = saved }
  }
  private func save() {
    do {
      try FileManager.default.createDirectory(at: stateURL.deletingLastPathComponent(), withIntermediateDirectories: true)
      try JSONEncoder().encode(state).write(to: stateURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      var url = stateURL
      var values = URLResourceValues(); values.isExcludedFromBackup = true
      try url.setResourceValues(values)
    } catch { message = "Could not save push preferences." }
  }
  private func fingerprint(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
  private func installation() -> String? {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "net.lakesidegames.ahdclient.push", kSecAttrAccount as String: "installation"]
    var read = query; read[kSecReturnData as String] = true
    var value: CFTypeRef?
    let status = SecItemCopyMatching(read as CFDictionary, &value)
    if status == errSecSuccess, let data = value as? Data { return String(data: data, encoding: .utf8) }
    guard status == errSecItemNotFound else { return nil }
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
    let secret = bytes.map { String(format: "%02x", $0) }.joined()
    var add = query; add[kSecValueData as String] = Data(secret.utf8)
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(add as CFDictionary, nil) == errSecSuccess ? secret : nil
  }
  func attach(_ view: WKWebView) {
    webview = view
    UNUserNotificationCenter.current().delegate = self
    installCallbacks()
    refreshPermission()
    openPendingPage()
  }
  private func installCallbacks() {
    guard !installed, let delegate = UIApplication.shared.delegate else { return }
    let cls: AnyClass = type(of: delegate)
    let registered = NSSelectorFromString("application:didRegisterForRemoteNotificationsWithDeviceToken:")
    let failed = NSSelectorFromString("application:didFailToRegisterForRemoteNotificationsWithError:")
    // Tao creates its app delegate dynamically. Add only absent APNs callbacks;
    // never replace another delegate implementation.
    guard class_getInstanceMethod(cls, registered) == nil, class_getInstanceMethod(cls, failed) == nil else {
      message = "Push registration is unavailable in this build."; return
    }
    let success: @convention(block) (AnyObject, UIApplication, NSData) -> Void = { _, _, data in
      DispatchQueue.main.async { NativePush.shared.receivedToken(data as Data) }
    }
    let failure: @convention(block) (AnyObject, UIApplication, NSError) -> Void = { _, _, error in
      DispatchQueue.main.async {
        NativePush.shared.registering = false
        NativePush.shared.message = NativePush.describe(error)
      }
    }
    installed = class_addMethod(cls, registered, imp_implementationWithBlock(success), "v@:@@") &&
      class_addMethod(cls, failed, imp_implementationWithBlock(failure), "v@:@@")
  }
  /// Apple's own reason, so a build or entitlement fault is not mistaken for
  /// being offline. Codes are from NSCocoaErrorDomain (3000 = the signed app
  /// has no aps-environment entitlement, 3010 = simulator).
  static func describe(_ error: NSError) -> String {
    let reason = "\(error.localizedDescription) (\(error.domain) \(error.code))"
    if error.domain == NSCocoaErrorDomain && error.code == 3000 {
      return "This build is not set up for push alerts. Update the app, then try again. " + reason
    }
    let offline = error.domain == NSURLErrorDomain
      || (error.userInfo[NSUnderlyingErrorKey] as? NSError)?.domain == NSURLErrorDomain
    return offline ? "Could not reach Apple. Try again when online. " + reason
      : "Apple declined push registration: " + reason
  }
  func status() -> [String: Any] {
    let session = (BriefingStore.session() ?? "")
    return ["enabled": state.enabled, "permissionGranted": permission, "available": installed,
      "registered": state.enabled && permission && !session.isEmpty && state.registeredSession == fingerprint(session),
      "message": message]
  }
  func configure(_ enabled: Bool, completion: @escaping ([String: Any]) -> Void) {
    state.enabled = enabled; nextAttempt = .distantPast
    if !enabled {
      state.registeredSession = ""
      UNUserNotificationCenter.current().removeAllDeliveredNotifications()
      UIApplication.shared.unregisterForRemoteNotifications()
    }
    save()
    guard enabled else { sync(); completion(status()); return }
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
      DispatchQueue.main.async {
        self.permission = granted
        self.sync()
        completion(self.status())
      }
    }
  }
  func refreshPermission() {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      DispatchQueue.main.async {
        self.permission = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
        self.sync()
      }
    }
  }
  private func receivedToken(_ token: Data) {
    registering = true
    let value = token.map { String(format: "%02x", $0) }.joined()
    if value != state.token { state.token = value; state.registeredSession = ""; nextAttempt = .distantPast; save() }
    sync()
  }
  func sync() {
    let session = (BriefingStore.session() ?? "")
    let sessionID = session.isEmpty ? "" : fingerprint(session)
    if state.observedSession != sessionID {
      state.observedSession = sessionID; nextAttempt = .distantPast
      state.registeredSession = ""
      state.needsRevoke = state.mayBeRegistered
      save()
      UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }
    let enabled = state.enabled && permission
    if !enabled || session.isEmpty {
      message = !state.enabled ? "Push alerts are off." : !permission ?
        "Allow notifications in iOS Settings, then return here." : "Sign in to multiplayer to receive alerts."
    }
    if !enabled || session.isEmpty || state.needsRevoke {
      UIApplication.shared.unregisterForRemoteNotifications()
      registering = false
    }
    if enabled && !session.isEmpty && !state.needsRevoke && installed && !registering {
      registering = true
      UIApplication.shared.registerForRemoteNotifications()
      // Apple may not call back while the device is offline. A later foreground retries.
      DispatchQueue.main.asyncAfter(deadline: .now() + 20) { self.registering = false }
    }
    guard !busy, Date() >= nextAttempt, let secret = installation() else { return }
    let register = enabled && !session.isEmpty && !state.token.isEmpty && installed && !state.needsRevoke
    guard register || state.mayBeRegistered else { return }
    var payload: [String: String] = ["installation": secret]
    if register {
      payload["provider"] = "apns"; payload["token"] = state.token
      payload["environment"] = Bundle.main.object(forInfoDictionaryKey: "AHDPushEnvironment") as? String ?? "production"
    }
    let token = state.token
    let enabledAtSend = state.enabled
    let permissionAtSend = permission
    if register { state.mayBeRegistered = true; message = "Connecting push alerts..." }
    save(); busy = true; nextAttempt = Date().addingTimeInterval(60)
    var request = URLRequest(url: URL(string: origin + "/api/push/device")!)
    request.httpMethod = register ? "POST" : "DELETE"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if register { request.setValue(session, forHTTPHeaderField: "Cookie") }
    request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
    client.dataTask(with: request) { _, response, _ in
      DispatchQueue.main.async {
        self.busy = false
        guard session == (BriefingStore.session() ?? ""), enabledAtSend == self.state.enabled,
          token == self.state.token, permissionAtSend == self.permission else {
          self.nextAttempt = .distantPast; self.sync(); return
        }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 200 {
          self.state.registeredSession = register ? sessionID : ""
          self.state.mayBeRegistered = register
          self.state.needsRevoke = false
          if register {
            self.nextAttempt = Date().addingTimeInterval(12 * 60 * 60)
            self.message = "Push alerts are on. Tap one to open what it is about."
          }
          self.save()
          if !register { self.nextAttempt = .distantPast; self.sync() }
        } else if register {
          self.state.registeredSession = ""; self.save()
          self.message = code == 401 || code == 403 ? "Sign in to multiplayer to receive alerts." :
            code == 503 ? "Push delivery is not available yet. We will retry automatically." :
            "Could not connect. We will retry when online."
        }
      }
    }.resume()
  }
  /// Ask the game to send this phone one test alert now. Completes on main.
  func sendTest(_ completion: @escaping (String) -> Void) {
    let session = BriefingStore.session() ?? ""
    guard !session.isEmpty else { completion("signed_out"); return }
    guard let secret = installation() else { completion("not_registered"); return }
    var request = URLRequest(url: URL(string: origin + "/api/push/test")!)
    request.httpMethod = "POST"
    request.timeoutInterval = 15
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(session, forHTTPHeaderField: "Cookie")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["installation": secret])
    client.dataTask(with: request) { data, response, _ in
      let code = (response as? HTTPURLResponse)?.statusCode ?? 0
      var result = code == 401 || code == 403 ? "signed_out" : code == 429 ? "rate_limited" : code >= 500 ? "retry" : "error"
      if code == 200, let data,
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let verdict = json["result"] as? String {
        result = verdict
      }
      DispatchQueue.main.async { completion(result) }
    }.resume()
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    DispatchQueue.main.async {
      let session = (BriefingStore.session() ?? "")
      let allowed = self.state.enabled && self.permission && !session.isEmpty && self.state.registeredSession == self.fingerprint(session)
      completionHandler(allowed ? [.banner, .sound] : [])
    }
  }
  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void) {
    DispatchQueue.main.async {
      let info = response.notification.request.content.userInfo
      // Servers since AHDGame #3764 name the alert's own page in `href`.
      // Older pushes carry only the inbox `path`.
      let page = (info["href"] as? String).flatMap(BriefingStore.gamePath)
        ?? (info["path"] as? String == "/notifications" ? "/notifications" : nil)
      if let page = page {
        self.pendingPath = page; self.navigationAttempts = 0; self.openPendingPage()
      }
      completionHandler()
    }
  }
  private func openPendingPage() {
    guard let path = pendingPath, let destination = URL(string: origin + path) else { pendingPath = nil; return }
    if let view = webview, let url = view.url, url.absoluteString != "about:blank" {
      pendingPath = nil
      view.load(URLRequest(url: destination))
    } else if navigationAttempts < 100 {
      navigationAttempts += 1
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.openPendingPage() }
    }
  }
}
