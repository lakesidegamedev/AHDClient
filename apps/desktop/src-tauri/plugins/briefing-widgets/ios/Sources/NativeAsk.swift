import Foundation
import SwiftUI
import UIKit
import WebKit

// Native Ask, file map:
//   NativeAsk.swift          networking, session handling, the sheet controller
//   NativeAskData.swift      answer, history and quota models parsed from the service
//   NativeAskModel.swift     sheet state: conversation, history, streaming, recovery
//   NativeAskView.swift      SwiftUI layouts for iPhone and iPad
//   NativeAskMarkdown.swift  answer rendering: markdown, tables, charts, maps
//   NativeAskPreview.swift   canned sample conversation for -AHDAskPreview
//
// scripts/tests/native-ask-auth.py compiles this file up to `func ask(question:`
// without UIKit, SwiftUI or WebKit, so everything above that point must only
// use Foundation.

private let nativeAskOrigin = URL(string: "https://ask.lakesidegames.net")!
private let nativeAskLogin = URL(string: "https://ask.lakesidegames.net/auth/login?next=%2F")!
private let nativeAhdLogin = URL(string: "https://auth.ahousedividedgame.com/auth/ahd?return=https%3A%2F%2Fask.lakesidegames.net%2Fauth%2Fnative%2Fcallback")!
private let nativeSandboxHost = "sandbox.ahousedividedgame.com"

enum NativeAskProvider: String, Hashable {
  case server
  case appleOnDevice

  var title: String {
    switch self {
    case .server: return "Online, with live game data"
    case .appleOnDevice: return "On this device"
    }
  }
}

/// An outside company that may receive an Ask server question, from /api/me.
struct NativeAskRecipient: Hashable {
  let name: String
  let detail: String
}

/// App Store guideline 5.1.2(i): name the outside AI services and get the
/// player's permission before an Ask server question reaches them. Permission
/// is tied to the exact list, so a provider added on the server asks again.
/// Same key and signature as the webview Ask panel (consent.ts).
enum NativeAskConsent {
  static let key = "ahdclient.ask.aiConsent"
  static let privacyURL = URL(string: "https://ask.lakesidegames.net/privacy")!

  /// Used only when the Ask server predates the aiProviders field.
  static let fallback: [NativeAskRecipient] = [
    NativeAskRecipient(name: "Meta", detail: "Muse Spark models. On Meta's contributor tier, Meta may use the question and answer to train its models"),
    NativeAskRecipient(name: "Ollama", detail: "Ollama Cloud hosted models"),
    NativeAskRecipient(name: "DeepSeek", detail: "DeepSeek models, operated from China"),
    NativeAskRecipient(name: "Command Code", detail: "MiniMax models"),
    NativeAskRecipient(name: "OpenRouter", detail: "relays to the vendor of the chosen model"),
    NativeAskRecipient(name: "Google", detail: "Gemini models"),
  ]

  static func recipients(from profile: [String: Any]) -> [NativeAskRecipient] {
    let list = (profile["aiProviders"] as? [[String: Any]] ?? []).compactMap { item -> NativeAskRecipient? in
      guard let name = item["name"] as? String, !name.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
      return NativeAskRecipient(name: name, detail: item["detail"] as? String ?? "")
    }
    return list.isEmpty ? fallback : list
  }

  static func signature(_ recipients: [NativeAskRecipient]) -> String {
    recipients.map { "\($0.name)|\($0.detail)" }.sorted().joined(separator: "\n")
  }

  static func granted(_ recipients: [NativeAskRecipient]) -> Bool {
    UserDefaults.standard.string(forKey: key) == signature(recipients)
  }

  static func grant(_ recipients: [NativeAskRecipient]) {
    UserDefaults.standard.set(signature(recipients), forKey: key)
  }

  static func withdraw() {
    UserDefaults.standard.removeObject(forKey: key)
  }
}

enum NativeAskError: LocalizedError {
  case signedOut
  case loginFailed
  case server(String)
  case emptyAnswer
  /// HTTP 429: the daily allowance is spent. Carries the service's own
  /// sentence and its usage snapshot so the quota display updates.
  case quota(String, [String: Any]?)
  /// HTTP 5xx: the service is unwell. Transient, so reads retry it.
  case unavailable(Int)
  /// The answer stream ended without its final event.
  case streamDropped

  var errorDescription: String? {
    switch self {
    case .signedOut, .loginFailed:
      return "Ask could not find a linked game account. Link your game account in AHDClient first."
    case .server(let message): return message
    case .emptyAnswer: return "Ask returned an empty answer. Try again."
    case .quota(let message, _): return message
    case .unavailable: return "Ask is having trouble right now. Try again in a moment."
    case .streamDropped: return "The connection dropped before the answer finished."
    }
  }

  /// True when the same read may succeed if repeated shortly.
  static func isTransient(_ error: Error) -> Bool {
    if case NativeAskError.unavailable(let status)? = error as? NativeAskError {
      return status == 500 || status == 502 || status == 503 || status == 504
    }
    if let urlError = error as? URLError {
      switch urlError.code {
      case .timedOut, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .resourceUnavailable:
        return true
      default:
        return false
      }
    }
    return false
  }
}

enum NativeAskTimeoutError: LocalizedError {
  case timedOut(String)

  var errorDescription: String? {
    switch self {
    case .timedOut(let operation): return "Ask (\(operation)) timed out. Check your connection and try again."
    }
  }
}

func withNativeAskTimeout<T>(seconds: UInt64, operation: @escaping @Sendable () async throws -> T) async throws -> T {
  try await withThrowingTaskGroup(of: T.self) { group in
    group.addTask { try await operation() }
    group.addTask {
      try await Task.sleep(nanoseconds: seconds * 1_000_000_000)
      throw NativeAskTimeoutError.timedOut("request")
    }
    defer { group.cancelAll() }
    guard let result = try await group.next() else { throw CancellationError() }
    return result
  }
}

private final class NativeAskRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  private let allowedHosts: Set<String> = [
    "ask.lakesidegames.net",
    "auth.ahousedividedgame.com",
    "auth.lakesidegames.net",
    "ahousedividedgame.com",
    "www.ahousedividedgame.com",
    "sandbox.ahousedividedgame.com",
  ]

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    guard let url = request.url, url.scheme == "https", let host = url.host?.lowercased(), allowedHosts.contains(host) else {
      completionHandler(nil)
      return
    }
    completionHandler(request)
  }
}

final class NativeAskAPI: @unchecked Sendable {
  private let storage: HTTPCookieStorage
  private let transport: URLSession
  private let unifiedSessionCookie: String?
  private let gameAuthCookieHeader: String?

  init(gameCookies: [HTTPCookie]) {
    // Use the backed, private store supplied by the ephemeral session.
    // HTTPCookieStorage() accepts setCookie calls but retains nothing on Apple.
    let configuration = URLSessionConfiguration.ephemeral
    let storage = configuration.httpCookieStorage!
    self.storage = storage
    self.unifiedSessionCookie = gameCookies.first { cookie in
      let domain = cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased()
      return cookie.name == "__Host-lakeside_session"
        && (domain == "auth.lakesidegames.net" || domain == "lakesidegames.net")
        && !cookie.value.isEmpty
    }?.value
    self.gameAuthCookieHeader = Self.cookieHeader(from: gameCookies.filter { cookie in
      let domain = cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased()
      let gameDomain = domain == "ahousedividedgame.com" || domain == "www.ahousedividedgame.com" || domain == nativeSandboxHost
      return gameDomain && Self.isGameAuthCookie(cookie) && !cookie.value.isEmpty
    })
    configuration.httpShouldSetCookies = true
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 30
    // A live-data answer can stream for several minutes. The service sends a
    // keepalive every 5s, so the per-request idle timeout still catches a dead
    // connection; the resource cap only bounds a runaway stream.
    configuration.timeoutIntervalForResource = 600
    configuration.urlCache = nil
    transport = URLSession(configuration: configuration, delegate: NativeAskRedirectDelegate(), delegateQueue: nil)
    for cookie in gameCookies where Self.isRelevant(cookie) {
      storage.setCookie(cookie)
      if Self.isGameAuthCookie(cookie), let brokerCookie = Self.brokerCookie(from: cookie) {
        storage.setCookie(brokerCookie)
      }
    }
  }

  private static func isRelevant(_ cookie: HTTPCookie) -> Bool {
    let domain = cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased()
    let gameDomain = domain == "ahousedividedgame.com" || domain == "www.ahousedividedgame.com" || domain == nativeSandboxHost
    let authDomain = domain == "auth.ahousedividedgame.com"
    let unifiedAuthDomain = domain == "auth.lakesidegames.net"
    let askDomain = domain == "ask.lakesidegames.net"
    // The issuer's SSO cookies are distinct from each app's opaque session.
    // Keep their original domain and realm path so Ask's OIDC redirects can
    // reuse the game login without sending issuer credentials to Ask itself.
    let issuerSSO = unifiedAuthDomain && (cookie.name == "KEYCLOAK_IDENTITY" || cookie.name == "KEYCLOAK_SESSION")
    let session = Self.isAskCookieName(cookie.name) || Self.isGameAuthCookie(cookie)
    return ((gameDomain || authDomain || unifiedAuthDomain || askDomain) && session || issuerSSO) && !cookie.value.isEmpty
  }

  private static func isAskCookieName(_ name: String) -> Bool {
    name == "ask_session" || name == "__Host-ask_session" || name == "__Host-ask_login"
      || name == "__Host-lakeside_login" || name == "__Host-lakeside_session"
  }

  private static func isAskSessionCookie(_ name: String) -> Bool {
    name == "ask_session" || name == "__Host-ask_session" || name == "__Host-lakeside_session"
  }

  private static func isGameAuthCookie(_ cookie: HTTPCookie) -> Bool {
    cookie.name == "auth-token" || cookie.name.range(of: "^auth-token-[A-Za-z0-9-]+$", options: .regularExpression) != nil
      || cookie.name.range(of: "^(?:__Secure-)?(?:authjs|next-auth)\\.session-token(?:\\.[0-9]+)?$", options: .regularExpression) != nil
  }

  private static func cookieHeader(from cookies: [HTTPCookie]) -> String? {
    var values = [String: String]()
    for cookie in cookies {
      values[cookie.name] = "\(cookie.name)=\(cookie.value)"
    }
    let header = values.keys.sorted().compactMap { values[$0] }.joined(separator: "; ")
    return header.isEmpty ? nil : header
  }

  private static func brokerCookie(from cookie: HTTPCookie) -> HTTPCookie? {
    guard isGameAuthCookie(cookie) else { return nil }
    var properties = cookie.properties ?? [:]
    properties[.domain] = "auth.ahousedividedgame.com"
    properties[.path] = "/"
    properties[.secure] = "TRUE"
    return HTTPCookie(properties: properties)
  }

  private var askCookie: HTTPCookie? {
    storage.cookies(for: nativeAskOrigin)?.first { Self.isAskSessionCookie($0.name) }
  }

  private var hasAskAuthentication: Bool {
    askCookie != nil || unifiedSessionCookie != nil
  }

  private func askCookieHeader() -> String? {
    var values = storage.cookies(for: nativeAskOrigin)?.map { "\($0.name)=\($0.value)" } ?? []
    if let unifiedSessionCookie,
       !values.contains(where: { $0.hasPrefix("__Host-lakeside_session=") }) {
      // The unified session is host-only on auth.lakesidegames.net. Forward it
      // explicitly only to Ask; never attach it to the legacy game broker.
      values.append("__Host-lakeside_session=\(unifiedSessionCookie)")
    }
    return values.isEmpty ? nil : values.joined(separator: "; ")
  }

  private func clearAskCookies() {
    for cookie in storage.cookies(for: nativeAskOrigin) ?? [] where Self.isAskCookieName(cookie.name) {
      storage.deleteCookie(cookie)
    }
  }

  private func request(_ path: String, body: [String: Any]? = nil, query: [URLQueryItem] = []) throws -> URLRequest {
    guard path.hasPrefix("/") else { throw NativeAskError.server("Invalid Ask request.") }
    var url = nativeAskOrigin.appendingPathComponent(String(path.dropFirst()))
    if !query.isEmpty {
      // appendingPathComponent would percent-encode a literal "?", so query
      // parameters always go through URLComponents.
      guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
        throw NativeAskError.server("Invalid Ask request.")
      }
      components.queryItems = query
      guard let withQuery = components.url else { throw NativeAskError.server("Invalid Ask request.") }
      url = withQuery
    }
    var request = URLRequest(url: url)
    request.timeoutInterval = path == "/api/ask" ? 60 : 30
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(nativeAskOrigin.absoluteString, forHTTPHeaderField: "Origin")
    request.setValue(nativeAskOrigin.absoluteString + "/", forHTTPHeaderField: "Referer")
    if let cookieHeader = askCookieHeader() {
      request.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
    }
    if let body {
      request.httpMethod = "POST"
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    return request
  }

  private func establishSession(at loginURL: URL) async throws {
    var request = URLRequest(url: loginURL)
    request.timeoutInterval = 30
    if loginURL.host == "auth.ahousedividedgame.com", let gameAuthCookieHeader {
      // The desktop link compatibility cookie is scoped to the game's
      // account endpoint, so URLSession will not send it to the broker even
      // after cloning it into the ephemeral cookie jar. Send the already
      // filtered game session explicitly on this trusted first-party hop.
      request.setValue(gameAuthCookieHeader, forHTTPHeaderField: "Cookie")
    }
    let (_, response) = try await transport.data(for: request)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), hasAskAuthentication else {
      throw NativeAskError.loginFailed
    }
  }

  private func ensureSession(force: Bool = false, preferGameHandoff: Bool = true) async throws {
    if !force, hasAskAuthentication { return }
    do {
      if preferGameHandoff {
        do {
          try await establishSession(at: nativeAhdLogin)
          return
        } catch {
          // Legacy linked game accounts use the AHD broker. Migrated accounts
          // may already have a unified Lakeside auth session, so fall through
          // to Ask's normal login when the broker cannot complete silently.
        }
      }
      try await establishSession(at: nativeAskLogin)
    } catch let error as NativeAskError {
      throw error
    } catch {
      throw NativeAskError.loginFailed
    }
  }

  /// Map an HTTP status to the error the sheet explains to the player.
  private static func failure(status: Int, payload: [String: Any]?) -> NativeAskError {
    let message = (payload?["error"] as? String).flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
    switch status {
    case 401: return .signedOut
    case 429: return .quota(message ?? "You have used today's questions. They come back after the daily reset.", payload?["usage"] as? [String: Any])
    case 500...599: return .unavailable(status)
    default: return .server(message ?? "Something went wrong. Try again.")
    }
  }

  private func json(_ request: URLRequest) async throws -> [String: Any] {
    let (data, response) = try await transport.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw NativeAskError.server("Ask returned an invalid response.") }
    guard (200..<300).contains(http.statusCode) else {
      throw Self.failure(status: http.statusCode, payload: (try? JSONSerialization.jsonObject(with: data)) as? [String: Any])
    }
    guard let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
      throw NativeAskError.server("Ask returned invalid data.")
    }
    return value
  }

  func connect() async throws -> [String: Any] {
    do {
      try await ensureSession()
      return try await json(try request("/api/me"))
    } catch let error as NativeAskError {
      guard case .signedOut = error else { throw error }
      clearAskCookies()
      try await ensureSession(force: true, preferGameHandoff: false)
      return try await json(try request("/api/me"))
    }
  }

  /// Stream one answer. Events arrive on the main actor in order; the full
  /// `done` payload is returned. A stream that drops after it started throws
  /// `streamDropped` so the caller can keep the partial answer.
  func ask(question: String, conversationID: String, useLive: Bool, visualizations: Bool, attachments: [String],
           onEvent: @escaping @MainActor (NativeAskStreamEvent) -> Void) async throws -> [String: Any] {
    let body: [String: Any] = [
      "question": question,
      "convId": conversationID,
      "game": "ahd",
      "useMcp": useLive,
      "length": "standard",
      "style": "standard",
      "effort": "auto",
      "visualizations": visualizations,
      "mode": "auto",
      "tz": TimeZone.current.identifier,
      "attachments": attachments.map { ["url": $0] },
    ]
    return try await withSession { () async throws -> [String: Any] in
      let request = try self.request("/api/ask", body: body)
      let (bytes, response) = try await self.transport.bytes(for: request)
      defer { bytes.task.cancel() }
      guard let http = response as? HTTPURLResponse else {
        throw NativeAskError.server("Ask returned an invalid response.")
      }
      let streaming = http.mimeType == "text/event-stream"
      if http.statusCode != 200 || !streaming {
        // Refusals (quota, validation, auth) and cached answers arrive as
        // plain JSON rather than a stream.
        var data = Data()
        for try await byte in bytes {
          data.append(byte)
          if data.count > 2_000_000 { break }
        }
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard http.statusCode == 200 else { throw Self.failure(status: http.statusCode, payload: object) }
        guard let object, let answer = object["answer"] as? String,
              !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw NativeAskError.emptyAnswer }
        return object
      }
      var started = false
      var final: [String: Any]?
      do {
        try await self.readEvents(bytes) { name, value in
          let object = value as? [String: Any]
          switch name {
          case "meta":
            started = true
            await onEvent(.meta(conversationID: object?["convId"] as? String, requestID: object?["reqId"] as? String,
                                followupsLeft: (object?["followupsLeft"] as? NSNumber)?.intValue,
                                usage: object?["usage"] as? [String: Any]))
          case "status":
            if let label = object?["label"] as? String, !label.isEmpty { await onEvent(.status(label)) }
          case "action":
            // Tool names are internal. Count them; never show them.
            await onEvent(.lookup)
          case "delta":
            let delta = value as? String ?? (object?["delta"] as? String ?? "")
            if !delta.isEmpty {
              started = true
              await onEvent(.delta(delta))
            }
          case "done":
            final = object ?? [:]
            return true
          case "error":
            // The service names the field `error`; older builds used `message`.
            throw NativeAskError.server(object?["error"] as? String ?? object?["message"] as? String ?? value as? String
              ?? "Ask could not complete the answer. Try again.")
          default:
            break
          }
          return false
        }
      } catch let error as NativeAskError {
        throw error
      } catch is CancellationError {
        throw CancellationError()
      } catch {
        if Task.isCancelled { throw CancellationError() }
        // A transport failure after the answer began is a dropped stream;
        // before that it is an ordinary connection error.
        if started { throw NativeAskError.streamDropped }
        throw error
      }
      guard let final else { throw NativeAskError.streamDropped }
      return final
    }
  }

  /// Run an authenticated call. On a 401 mid-session the Ask session is
  /// re-established once and the call repeats; a second 401 is final.
  private func withSession<T>(_ operation: () async throws -> T) async throws -> T {
    try await ensureSession()
    do {
      return try await operation()
    } catch NativeAskError.signedOut {
      clearAskCookies()
      try await ensureSession(force: true, preferGameHandoff: false)
      return try await operation()
    }
  }

  /// Authenticated read with retry: transient failures (timeouts, dropped
  /// connections, 5xx) repeat twice with growing backoff.
  private func read(_ path: String, query: [URLQueryItem] = []) async throws -> [String: Any] {
    var attempt = 0
    while true {
      do {
        return try await withSession { () async throws -> [String: Any] in try await self.json(try self.request(path, query: query)) }
      } catch let error where NativeAskError.isTransient(error) && attempt < 2 {
        attempt += 1
        try await Task.sleep(nanoseconds: UInt64(attempt) * 800_000_000)
      }
    }
  }

  private func write(_ path: String, body: [String: Any]) async throws -> [String: Any] {
    try await withSession { () async throws -> [String: Any] in try await self.json(try self.request(path, body: body)) }
  }

  func profile() async throws -> [String: Any] {
    try await read("/api/me")
  }

  func conversations() async throws -> [String: Any] {
    try await read("/api/conversations")
  }

  func conversation(id: String) async throws -> [String: Any] {
    try await read("/api/conversation", query: [URLQueryItem(name: "id", value: id)])
  }

  func nextCost(conversationID: String) async throws -> [String: Any] {
    try await read("/api/nextcost", query: [URLQueryItem(name: "convId", value: conversationID)])
  }

  func deleteConversation(id: String) async throws {
    _ = try await write("/api/conversation/delete", body: ["id": id])
  }

  /// A public link to the conversation. Conversations with attachments are
  /// private on the service and cannot be shared.
  func share(conversationID: String) async throws -> URL {
    let payload = try await write("/api/conversation/share", body: ["id": conversationID])
    guard let text = payload["url"] as? String, let url = URL(string: text), url.scheme == "https" else {
      throw NativeAskError.server("This conversation could not be shared.")
    }
    return url
  }

  func feedback(answerID: Int, rating: String, reason: String) async throws {
    _ = try await write("/api/answer/feedback", body: ["answerId": answerID, "rating": rating, "reason": reason])
  }

  /// Upload one attachment. The body is the raw file; the service checks the
  /// bytes against the declared type and returns `{url, name, mimeType, size}`.
  func upload(_ data: Data, filename: String, mimeType: String) async throws -> [String: Any] {
    try await withSession { () async throws -> [String: Any] in
      var request = try self.request("/api/upload")
      request.httpMethod = "POST"
      request.httpBody = data
      request.timeoutInterval = 90
      request.setValue(mimeType, forHTTPHeaderField: "Content-Type")
      let encoded = filename.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "photo.jpg"
      request.setValue(encoded, forHTTPHeaderField: "X-Filename")
      return try await self.json(request)
    }
  }

  /// Bytes of an earlier upload, for thumbnails in history.
  func attachment(path: String) async throws -> Data {
    guard path.hasPrefix("/api/uploads/") else { throw NativeAskError.server("Attachment not found.") }
    return try await withSession { () async throws -> Data in
      var request = try self.request(path)
      request.setValue("*/*", forHTTPHeaderField: "Accept")
      let (data, response) = try await self.transport.data(for: request)
      guard let http = response as? HTTPURLResponse else { throw NativeAskError.server("Attachment not found.") }
      guard (200..<300).contains(http.statusCode) else { throw Self.failure(status: http.statusCode, payload: nil) }
      return data
    }
  }

  /// Render an `ahd-map` specification to SVG. Public on the service, so it
  /// works for previews without a session too.
  func renderMap(_ spec: Data) async throws -> String {
    var lastError: Error = NativeAskError.server("This map could not be rendered.")
    for attempt in 0..<3 {
      do {
        var request = try self.request("/api/map/render")
        request.httpMethod = "POST"
        request.httpBody = spec
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("image/svg+xml", forHTTPHeaderField: "Accept")
        let (data, response) = try await transport.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw NativeAskError.server("This map could not be rendered.") }
        guard (200..<300).contains(http.statusCode) else {
          throw Self.failure(status: http.statusCode, payload: (try? JSONSerialization.jsonObject(with: data)) as? [String: Any])
        }
        guard let svg = String(data: data, encoding: .utf8), svg.contains("<svg") else {
          throw NativeAskError.server("This map could not be rendered.")
        }
        return svg
      } catch let error where NativeAskError.isTransient(error) && attempt < 2 {
        lastError = error
        try await Task.sleep(nanoseconds: UInt64(attempt + 1) * 700_000_000)
      }
    }
    throw lastError
  }

  func context(question: String) async throws -> (text: String, files: [String]) {
    try await ensureSession()
    let payload = try await withNativeAskTimeout(seconds: 30) { [self] in
      try await self.json(try self.request("/api/ask/context", body: ["question": question, "game": "ahd"]))
    }
    return (payload["context"] as? String ?? "", payload["files"] as? [String] ?? [])
  }

  /// Server-Sent Events framing. The handler returns true on a terminal
  /// event so the stream is released at `done` instead of waiting for EOF.
  private func readEvents(_ bytes: URLSession.AsyncBytes, handler: (String, Any) async throws -> Bool) async throws {
    var lineBytes: [UInt8] = []
    var event = "message"
    var dataLines: [String] = []
    func emit() async throws -> Bool {
      defer { dataLines.removeAll(); event = "message" }
      guard !dataLines.isEmpty else { return false }
      let payload = dataLines.joined(separator: "\n")
      guard let data = payload.data(using: .utf8),
            let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
        throw NativeAskError.server("Ask sent an answer this app could not read. Try again.")
      }
      return try await handler(event, value)
    }
    for try await byte in bytes {
      try Task.checkCancellation()
      if byte == 10 {
        let line = String(bytes: lineBytes, encoding: .utf8) ?? ""
        lineBytes.removeAll(keepingCapacity: true)
        if line.isEmpty {
          if try await emit() { return }
        } else if line.hasPrefix(":") {
          continue
        } else if line.hasPrefix("event:") {
          event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
        } else if line.hasPrefix("data:") {
          var chunk = String(line.dropFirst(5))
          if chunk.hasPrefix(" ") { chunk.removeFirst() }
          dataLines.append(chunk)
        }
      } else if byte != 13 {
        lineBytes.append(byte)
      }
    }
    if try await emit() { return }
    throw NativeAskError.streamDropped
  }

  /// Abort a server generation. Records nothing and costs no quota.
  func stop(requestID: String) async {
    guard let request = try? self.request("/api/ask/stop", body: ["reqId": requestID]) else { return }
    _ = try? await transport.data(for: request)
  }
}

/// One event from the answer stream, in arrival order.
enum NativeAskStreamEvent {
  case meta(conversationID: String?, requestID: String?, followupsLeft: Int?, usage: [String: Any]?)
  case status(String)
  case lookup
  case delta(String)
}

/// Hosts the sheet and reports its own dismissal, which SwiftUI's
/// onDisappear does not do reliably for UIKit-presented sheets.
final class NativeAskHostingController: UIHostingController<NativeAskView> {
  var onClosed: (@MainActor () -> Void)?

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if isBeingDismissed || presentingViewController == nil { onClosed?() }
  }

  /// False only when screenshot mode forces an appearance.
  var followsSystemAppearance = true
  private var activeObserver: NSObjectProtocol?
  private var traitRegistration: Any?

  override func viewDidLoad() {
    super.viewDidLoad()
    activeObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.applySystemAppearance()
    }
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    applySystemAppearance()
    if #available(iOS 17.0, *), traitRegistration == nil, let scene = view.window?.windowScene {
      traitRegistration = scene.registerForTraitChanges([UITraitUserInterfaceStyle.self]) { [weak self] (_: UIWindowScene, _: UITraitCollection) in
        self?.applySystemAppearance()
      }
    }
  }

  deinit {
    if let activeObserver { NotificationCenter.default.removeObserver(activeObserver) }
  }

  /// The launcher window is pinned dark, so the sheet would inherit dark.
  /// Follow the device's own light or dark setting instead.
  func applySystemAppearance(from scene: UIWindowScene? = nil) {
    guard followsSystemAppearance else { return }
    let system = (scene ?? view.window?.windowScene)?.traitCollection.userInterfaceStyle ?? UIScreen.main.traitCollection.userInterfaceStyle
    let style: UIUserInterfaceStyle = system == .unspecified ? .dark : system
    if overrideUserInterfaceStyle != style { overrideUserInterfaceStyle = style }
  }

  override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
    super.viewWillTransition(to: size, with: coordinator)
    coordinator.animate(alongsideTransition: nil) { [weak self] _ in self?.fitToPresenter() }
  }

  /// iPad shows Ask as a large floating card with history in a sidebar.
  func fitToPresenter() {
    guard UIDevice.current.userInterfaceIdiom == .pad, modalPresentationStyle == .formSheet else { return }
    let bounds = presentingViewController?.view.bounds ?? view.window?.bounds ?? UIScreen.main.bounds
    preferredContentSize = NativeAskController.cardSize(for: bounds.size)
  }
}

final class NativeAskController: NSObject {
  static let shared = NativeAskController()
  private weak var webView: WKWebView?
  private weak var presented: NativeAskHostingController?
  /// Kept for the whole app session so the draft and the open conversation
  /// survive closing and reopening the sheet.
  private var model: NativeAskModel?
  private var previewScheduled = false

  func attach(_ webView: WKWebView) {
    self.webView = webView
    if let state = NativeAskPreview.requestedState(), !previewScheduled {
      previewScheduled = true
      schedulePreview(state, attempt: 0)
    }
  }

  func present() {
    Task { @MainActor [weak self] in self?.show(preview: nil) }
  }

  /// Screenshot mode: wait for the app window, then present a canned sheet.
  private func schedulePreview(_ state: String, attempt: Int) {
    Task { @MainActor [weak self] in
      guard let self else { return }
      if self.webView?.window?.rootViewController != nil {
        // Let the launcher finish its first layout so the sheet animates in.
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        self.show(preview: state)
      } else if attempt < 120 {
        try? await Task.sleep(nanoseconds: 500_000_000)
        self.schedulePreview(state, attempt: attempt + 1)
      }
    }
  }

  @MainActor private func show(preview: String?) {
    guard let webView, let root = webView.window?.rootViewController else { return }
    if presented != nil { return }
    let presenter = Self.topController(root)
    let model: NativeAskModel
    if let preview {
      model = NativeAskModel(preview: preview)
      self.model = model
    } else if let existing = self.model, existing.webView === webView, !existing.isPreview {
      model = existing
    } else {
      model = NativeAskModel(webView: webView)
      self.model = model
    }
    model.onClose = { [weak self] in self?.dismiss() }
    model.onLinkAccount = { [weak self] in self?.linkAccount() }
    model.onOpenURL = { [weak self] url in self?.open(url) }
    model.onShare = { [weak self] items in self?.share(items) }
    let host = NativeAskHostingController(rootView: NativeAskView(model: model))
    host.onClosed = { [weak model] in model?.sheetClosed() }
    host.view.backgroundColor = .systemBackground
    host.view.tintColor = NativeAskTint.uiColor
    // Ask follows the device appearance even though the launcher window is
    // pinned dark. Screenshot mode can force either for review.
    NativeLauncherAppearance.apply(to: webView)
    if preview != nil, let style = NativeAskPreview.requestedAppearance() {
      host.followsSystemAppearance = false
      host.overrideUserInterfaceStyle = style == "light" ? .light : .dark
    } else {
      host.applySystemAppearance(from: webView.window?.windowScene)
    }
    if UIDevice.current.userInterfaceIdiom == .pad {
      host.modalPresentationStyle = .formSheet
      host.preferredContentSize = Self.cardSize(for: presenter.view.bounds.size)
    } else {
      host.modalPresentationStyle = .pageSheet
      if let sheet = host.sheetPresentationController {
        sheet.detents = [.medium(), .large()]
        sheet.selectedDetentIdentifier = .large
        sheet.prefersGrabberVisible = true
        sheet.prefersScrollingExpandsWhenScrolledToEdge = true
        sheet.preferredCornerRadius = 24
      }
    }
    presented = host
    presenter.present(host, animated: true)
  }

  static func cardSize(for bounds: CGSize) -> CGSize {
    CGSize(width: max(320, min(1120, bounds.width - 64)), height: max(480, bounds.height - 72))
  }

  private func dismiss() {
    Task { @MainActor [weak self] in self?.presented?.dismiss(animated: true) }
  }

  private func linkAccount() {
    loadInGame(URL(string: "https://ahousedividedgame.com/client/link")!)
  }

  /// Game pages open in the app's own webview and close the sheet. Anything
  /// else opens in Safari.
  private func open(_ url: URL) {
    Task { @MainActor [weak self] in
      guard let self else { return }
      if let game = Self.gameURL(url, current: self.webView?.url) {
        self.loadInGame(game)
      } else if url.scheme == "https" || url.scheme == "http" || url.scheme == "mailto" {
        UIApplication.shared.open(url)
      }
    }
  }

  private func loadInGame(_ url: URL) {
    Task { @MainActor [weak self] in
      guard let self else { return }
      let webView = self.webView
      if let presented = self.presented {
        presented.dismiss(animated: true) { webView?.load(URLRequest(url: url)) }
      } else {
        webView?.load(URLRequest(url: url))
      }
    }
  }

  private func share(_ items: [Any]) {
    Task { @MainActor [weak self] in
      guard let host = self?.presented else { return }
      let top = Self.topController(host)
      let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
      if let popover = sheet.popoverPresentationController {
        popover.sourceView = top.view
        popover.sourceRect = CGRect(x: top.view.bounds.maxX - 72, y: top.view.safeAreaInsets.top + 24, width: 1, height: 1)
        popover.permittedArrowDirections = [.up]
      }
      top.present(sheet, animated: true)
    }
  }

  /// A link to a game page, rewritten onto the world the player is in (the
  /// sandbox stays on the sandbox).
  static func gameURL(_ url: URL, current: URL?) -> URL? {
    let gameHosts: Set<String> = ["ahousedividedgame.com", "www.ahousedividedgame.com", nativeSandboxHost]
    guard url.scheme == "https", let host = url.host?.lowercased(), gameHosts.contains(host) else { return nil }
    guard let currentHost = current?.host?.lowercased(), gameHosts.contains(currentHost), currentHost != host,
          var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
    components.host = currentHost
    return components.url ?? url
  }

  private static func topController(_ root: UIViewController) -> UIViewController {
    if let presented = root.presentedViewController { return topController(presented) }
    if let navigation = root as? UINavigationController, let visible = navigation.visibleViewController { return topController(visible) }
    if let tab = root as? UITabBarController, let selected = tab.selectedViewController { return topController(selected) }
    return root
  }
}

/// The launcher and the game webview are designed dark. The app itself
/// follows the system appearance (Info.ios.plist sets no style), so only the
/// window that hosts the game is pinned dark; native sheets such as Ask set
/// their own style from the device setting.
enum NativeLauncherAppearance {
  private static var observers: [NSObjectProtocol] = []

  static func pinDark(_ webView: WKWebView) {
    apply(to: webView)
    if observers.isEmpty {
      for name in [UIWindow.didBecomeVisibleNotification, UIWindow.didBecomeKeyNotification, UIApplication.didBecomeActiveNotification] {
        observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak webView] _ in
          if let webView { apply(to: webView) }
        })
      }
    }
    // The webview can join its window after the plugin loads.
    for delay in [0.05, 0.3, 1.0, 3.0] {
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak webView] in
        if let webView { apply(to: webView) }
      }
    }
  }

  static func apply(to webView: WKWebView) {
    guard let window = webView.window, window.overrideUserInterfaceStyle != .dark else { return }
    window.overrideUserInterfaceStyle = .dark
  }
}
