import Foundation

/// The daily allowance, sanitized from any `{ usage }` payload (see the
/// desktop client's usageIn). Unknown fields are dropped.
struct NativeAskUsage: Equatable {
  var used: Double
  var limit: Double
  var remaining: Double
  var liveLimit: Double
  var liveRemaining: Double
  var chartLimit: Double?
  var chartRemaining: Double?
  /// Milliseconds since the epoch.
  var resetAt: Double
  var tier: String?
  var followupCost: Double?

  init(used: Double, limit: Double, remaining: Double, liveLimit: Double = 0, liveRemaining: Double = 0,
       chartLimit: Double? = nil, chartRemaining: Double? = nil, resetAt: Double = 0, tier: String? = nil, followupCost: Double? = nil) {
    self.used = used
    self.limit = limit
    self.remaining = remaining
    self.liveLimit = liveLimit
    self.liveRemaining = liveRemaining
    self.chartLimit = chartLimit
    self.chartRemaining = chartRemaining
    self.resetAt = resetAt
    self.tier = tier
    self.followupCost = followupCost
  }

  init?(_ value: Any?) {
    guard let record = value as? [String: Any] else { return nil }
    func number(_ key: String) -> Double? {
      guard let value = record[key] as? NSNumber else { return nil }
      let double = value.doubleValue
      return double.isFinite ? double : nil
    }
    guard let used = number("used"), let limit = number("limit"), let remaining = number("remaining") else { return nil }
    self.init(used: used, limit: limit, remaining: remaining,
              liveLimit: number("mcpLimit") ?? 0, liveRemaining: number("mcpRemaining") ?? 0,
              chartLimit: number("vizLimit"), chartRemaining: number("vizRemaining"),
              resetAt: number("resetAt") ?? 0, tier: record["tier"] as? String, followupCost: number("followupCost"))
  }

  var exhausted: Bool { remaining <= 0 }

  /// "7 of 10 questions left"
  var label: String {
    "\(Self.format(remaining)) of \(Self.format(limit)) questions left"
  }

  var resetLabel: String? {
    guard resetAt > 0 else { return nil }
    return Self.resetIn(resetAt)
  }

  /// Whole numbers without a decimal; follow-ups cost half a question.
  static func format(_ value: Double) -> String {
    value.rounded() == value ? String(Int(value)) : String(format: "%.1f", value)
  }

  /// "2h 14m" / "38m" until the daily allowance resets.
  static func resetIn(_ resetAt: Double, now: Date = Date()) -> String {
    let minutes = max(0, Int(((resetAt / 1000) - now.timeIntervalSince1970) / 60 + 0.5))
    if minutes >= 60 { return "\(minutes / 60)h \(minutes % 60)m" }
    return "\(minutes)m"
  }
}

struct NativeAskCitation: Hashable {
  let label: String
  let path: String
  let url: URL?

  static func list(_ value: Any?) -> [NativeAskCitation] {
    (value as? [Any] ?? []).compactMap { item in
      if let text = item as? String, !text.isEmpty { return NativeAskCitation(label: text, path: "", url: nil) }
      guard let record = item as? [String: Any] else { return nil }
      let label = (record["label"] as? String) ?? (record["path"] as? String) ?? ""
      let path = record["path"] as? String ?? ""
      let url = (record["url"] as? String).flatMap { URL(string: $0) }.flatMap { $0.scheme == "https" || $0.scheme == "http" ? $0 : nil }
      guard !label.isEmpty || url != nil else { return nil }
      return NativeAskCitation(label: label.isEmpty ? (url?.host ?? "Source") : label, path: path == label ? "" : path, url: url)
    }
  }
}

/// A file already uploaded to the service.
struct NativeAskAttachment: Identifiable, Hashable {
  var id: String { url }
  let url: String
  let name: String
  let mimeType: String
  let size: Int
  /// A small JPEG for display. Present for photos sent from this device;
  /// history thumbnails are fetched on demand.
  var thumbnail: Data?

  var isImage: Bool { mimeType.hasPrefix("image/") }

  init(url: String, name: String, mimeType: String, size: Int, thumbnail: Data? = nil) {
    self.url = url
    self.name = name
    self.mimeType = mimeType
    self.size = size
    self.thumbnail = thumbnail
  }

  init?(_ value: Any?) {
    guard let record = value as? [String: Any], let url = record["url"] as? String, url.hasPrefix("/api/uploads/") else { return nil }
    self.init(url: url, name: record["name"] as? String ?? "Photo", mimeType: record["mimeType"] as? String ?? "image/jpeg",
              size: (record["size"] as? NSNumber)?.intValue ?? 0)
  }

  static func list(_ value: Any?) -> [NativeAskAttachment] {
    (value as? [Any] ?? []).compactMap { NativeAskAttachment($0) }
  }
}

struct NativeAskConversation: Identifiable, Hashable {
  let id: String
  var title: String
  var updated: Date?
  var isPrivate: Bool

  static func list(_ value: Any?) -> [NativeAskConversation] {
    (value as? [Any] ?? []).compactMap { item in
      guard let record = item as? [String: Any], let id = record["id"] as? String, !id.isEmpty else { return nil }
      let title = (record["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      let stamp = (record["updated"] as? NSNumber)?.doubleValue ?? (record["created"] as? NSNumber)?.doubleValue
      // The service stores milliseconds; tolerate seconds from older rows.
      let date = stamp.map { Date(timeIntervalSince1970: $0 > 100_000_000_000 ? $0 / 1000 : $0) }
      let isPrivate = (record["private"] as? NSNumber)?.boolValue ?? false
      return NativeAskConversation(id: id, title: title.isEmpty ? "Untitled conversation" : title, updated: date, isPrivate: isPrivate)
    }
  }
}

enum NativeAskTurnState: Equatable {
  case streaming
  case done
  case stopped
  /// The stream dropped after the answer began. The partial text stays.
  case interrupted(String)
  /// Nothing usable came back.
  case failed(String)
}

struct NativeAskTurn: Identifiable {
  let id: String
  var question: String
  var answer: String = ""
  var state: NativeAskTurnState = .done
  var status: String = ""
  var lookups = 0
  var model: String = ""
  var citations: [NativeAskCitation] = []
  var usedLive = false
  var liveSources: [String] = []
  var local = false
  var cached = false
  var followups: [String] = []
  var answerID: Int?
  var feedback: String?
  var attachments: [NativeAskAttachment] = []
  var chartsUsedUp = false
  var reportURL: URL?
  var sentAt = Date()

  var isWorking: Bool { state == .streaming }

  /// Fill the answer fields from a `done` payload or a cached JSON answer.
  mutating func apply(answerPayload object: [String: Any]) {
    if let text = object["answer"] as? String, !text.isEmpty { answer = text }
    model = Self.modelLabel(object) ?? model
    citations = NativeAskCitation.list(object["citations"])
    usedLive = (object["usedMcp"] as? NSNumber)?.boolValue ?? false
    liveSources = Self.liveSources(object["liveSources"])
    cached = (object["cached"] as? NSNumber)?.boolValue ?? false
    followups = (object["followups"] as? [Any] ?? []).compactMap { item in
      guard let text = (item as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), text.count >= 5 else { return nil }
      return String(text.prefix(300))
    }
    if let id = (object["answerId"] as? NSNumber)?.intValue { answerID = id }
    chartsUsedUp = (object["vizBlocked"] as? NSNumber)?.boolValue ?? false
    if let report = object["reportUrl"] as? String, let url = URL(string: report, relativeTo: URL(string: "https://ask.lakesidegames.net")) {
      reportURL = url.absoluteURL
    }
  }

  /// A saved turn from /api/conversation.
  static func saved(_ value: Any) -> NativeAskTurn? {
    guard let record = value as? [String: Any], let question = record["question"] as? String else { return nil }
    let answerID = (record["id"] as? NSNumber)?.intValue
    var turn = NativeAskTurn(id: answerID.map { "saved-\($0)" } ?? UUID().uuidString, question: question)
    turn.answer = record["answer"] as? String ?? ""
    turn.answerID = answerID
    turn.citations = NativeAskCitation.list(record["citations"])
    turn.usedLive = (record["used_mcp"] as? NSNumber)?.boolValue ?? false
    turn.cached = (record["cached"] as? NSNumber)?.boolValue ?? false
    turn.model = record["modelName"] as? String ?? Self.friendlyModel(record["model"] as? String ?? "")
    let rating = record["feedback_rating"] as? String
    turn.feedback = rating == "up" || rating == "down" ? rating : nil
    turn.attachments = NativeAskAttachment.list(record["attachments"])
    if let stamp = (record["ts"] as? NSNumber)?.doubleValue { turn.sentAt = Date(timeIntervalSince1970: stamp / 1000) }
    turn.state = turn.answer.isEmpty ? .failed("This answer was not saved.") : .done
    return turn
  }

  /// "Model · Service" so every answer names who wrote it.
  static func modelLabel(_ object: [String: Any]) -> String? {
    guard let model = object["modelName"] as? String ?? object["modelId"] as? String ?? object["model"] as? String,
          !model.isEmpty else { return nil }
    if let provider = object["providerName"] as? String, !provider.isEmpty, provider != model { return "\(model) · \(provider)" }
    return model
  }

  /// History rows keep only the raw model id ("vendor/model-name"). Show the
  /// model part, which is still the name of who wrote the answer.
  static func friendlyModel(_ raw: String) -> String {
    let name = raw.split(separator: "/").last.map(String.init) ?? raw
    if name.hasPrefix("ask-") { return "Ask" }
    return name
  }

  /// The service sends `{id, label}` objects; older builds sent strings.
  static func liveSources(_ value: Any?) -> [String] {
    (value as? [Any] ?? []).compactMap { item in
      if let text = item as? String { return text.isEmpty ? nil : text }
      if let record = item as? [String: Any], let label = record["label"] as? String, !label.isEmpty { return label }
      return nil
    }
  }
}

/// A photo picked for the next question.
struct NativeAskDraftAttachment: Identifiable, Equatable {
  enum Upload: Equatable {
    case uploading
    case ready(NativeAskAttachment)
    case failed(String)
  }

  let id: String
  let thumbnail: Data
  var upload: Upload

  var ready: NativeAskAttachment? {
    if case .ready(let attachment) = upload { return attachment }
    return nil
  }
}

/// Player-facing wording for any failure. No HTTP codes, no internals.
enum NativeAskMessages {
  static func text(for error: Error) -> String {
    if let urlError = error as? URLError {
      switch urlError.code {
      case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff:
        return "You're offline. Check your connection and try again."
      case .timedOut:
        return "Ask took too long to respond. Try again."
      case .networkConnectionLost:
        return "The connection dropped. Try again."
      case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed:
        return "Ask can't be reached right now. Try again in a moment."
      case .cancelled:
        return "The request was cancelled."
      default:
        return "Ask couldn't connect. Check your connection and try again."
      }
    }
    if let timeout = error as? NativeAskTimeoutError, case .timedOut = timeout {
      return "Ask took too long to respond. Try again."
    }
    return error.localizedDescription
  }

  static func isOffline(_ error: Error) -> Bool {
    guard let urlError = error as? URLError else { return false }
    return urlError.code == .notConnectedToInternet || urlError.code == .dataNotAllowed
  }
}
