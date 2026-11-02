import Foundation
import Security
import CryptoKit
import ImageIO

// Compiled into both the app plugin and the WidgetKit extension. Only these
// fields can be saved; neither the raw API response nor session cookies are
// written to shared defaults, files, URLs or logs.
struct BriefingStatus: Codable {
  var status: String?
  var name: String?
  var avatarUrl: String?
  var actions: Double?
  var actionCap: Double?
  var funds: Double?
  var personalHomeLiquid: Double?
  var homeCurrency: String?
  var politicalInfluence: Double?
  var nationalInfluence: Double?
  var favorability: Double?
  var isImperial: Bool?
  var electionStats: ElectionStats?
  var corpNav: CorporationStats?
  var marketWatch: [MarketWatchItem]?
  var turnBriefing: [TurnChange]?
  var turn: TurnClock?
  var inbox: InboxCounts?
  var perTurn: PerTurn?

  struct ElectionStats: Codable {
    var electionId: String
    var electionType: String?
    var countryId: String?
    var state: String?
    var status: String?
    var electionYear: Double?
    var endTurn: Double?
    var myVotePct: Double?
    var marginPct: Double?
    var seatsProjected: Double?
    var totalSeats: Double?
    var isMultiSeat: Bool?
    var history: [ElectionPoint]?
  }
  struct ElectionPoint: Codable { var turn: Double; var pct: Double; var seats: Double? }
  struct CorporationStats: Codable {
    var sequentialId: Int
    var name: String
    var logoUrl: String?
    var tickerSymbol: String?
    var sharePrice: Double?
    var priceChange1h: Double?
    var liquidCapital: Double?
    var liquidCurrencyCode: String?
    var marketingStrength: Double?
    var marketCap: Double?
    var history: [CorporationPoint]?
  }
  struct CorporationPoint: Codable {
    var turn: Double
    var sharePrice: Double
    var marketingStrength: Double
    var liquidCapital: Double
    var marketCap: Double?
  }
  struct MarketWatchItem: Codable {
    var sequentialId: Int
    var name: String
    var logoUrl: String?
    var tickerSymbol: String?
    var sharePrice: Double?
    var liquidCurrencyCode: String?
    var ownedShares: Double
  }
  /// One change the latest turn made, with the game page it is about.
  struct TurnChange: Codable {
    var category: String
    var label: String
    var value: Double
    var delta: Double
    var unit: String
    var href: String
  }
  struct TurnClock: Codable {
    var current: Double
    var date: String?
    var nextAt: String?
    var active: Bool?
  }
  struct InboxCounts: Codable {
    var unread: Double
    var mail: Double
  }
  /// How much each figure changes per turn. Influence, favorability and funds
  /// are the profile page's per-turn rates; the rest are the latest turn's
  /// recorded change. Nil means unknown, not zero.
  struct PerTurn: Codable {
    var funds: Double?
    var politicalInfluence: Double?
    var nationalInfluence: Double?
    var favorability: Double?
    var voteShare: Double?
    var sharePrice: Double?
    var marketCap: Double?
    var liquidCapital: Double?

    /// Drops values a widget could not show sensibly.
    func bounded() -> PerTurn {
      func keep(_ value: Double?) -> Double? {
        guard let value = value, value.isFinite, abs(value) < 1e18 else { return nil }
        return value
      }
      return PerTurn(funds: keep(funds), politicalInfluence: keep(politicalInfluence),
        nationalInfluence: keep(nationalInfluence), favorability: keep(favorability),
        voteShare: keep(voteShare), sharePrice: keep(sharePrice), marketCap: keep(marketCap),
        liquidCapital: keep(liquidCapital))
    }
  }

  /// When the next turn is scheduled, if the server sent a valid time.
  var nextTurn: Date? {
    guard let text = turn?.nextAt else { return nil }
    let precise = ISO8601DateFormatter()
    precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return precise.date(from: text) ?? ISO8601DateFormatter().date(from: text)
  }
}

struct SavedBriefing: Codable {
  var updatedAt: Date
  var sessionId: String
  var data: BriefingStatus
  /// Small re-encoded thumbnails keyed by role ("avatar", "corporation",
  /// "stocks"). WidgetKit renders synchronously, so AsyncImage never loads;
  /// the refresh downloads them once and the widget draws the stored bytes.
  var images: [String: Data]?
  /// The URL each thumbnail came from, so an unchanged image is not refetched.
  var imageSources: [String: String]?
  /// The data shape this was saved with. An app update that adds figures
  /// refetches at once instead of showing the old saved copy until the next
  /// scheduled refresh (2.6.0 showed no market cap until a turn passed).
  var schema: Int?
}

enum BriefingStore {
  /// `widgets=1` adds the turn clock, inbox counts, market cap, national
  /// influence and per-turn changes.
  static let endpoint = URL(string: "https://ahousedividedgame.com/api/client-status?layout=full&widgets=1")!
  /// Bump when BriefingStatus gains fields the widgets show.
  static let currentSchema = 2
  private static let queue = DispatchQueue(label: "net.lakesidegames.ahdclient.widget-refresh")
  private static var pending = [(SavedBriefing?) -> Void]()

  static func read() -> SavedBriefing? {
    guard let bytes = item(account: "briefing"), bytes.count <= 131072,
      let value = try? JSONDecoder().decode(SavedBriefing.self, from: bytes),
      let header = session(), !header.isEmpty, value.sessionId == fingerprint(header),
      Date().timeIntervalSince(value.updatedAt) < 86400 else { return nil }
    return value
  }

  private static func fingerprint(_ header: String) -> String {
    SHA256.hash(data: Data(header.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  static func clear() {
    if let request = query(account: "briefing") { SecItemDelete(request as CFDictionary) }
  }

  private static func query(account: String) -> [String: Any]? {
    guard let accessGroup = Bundle.main.object(forInfoDictionaryKey: "AHDWidgetKeychainGroup") as? String,
      !accessGroup.contains("$("), !accessGroup.isEmpty else { return nil }
    return [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "net.lakesidegames.ahdclient.widgets",
      kSecAttrAccount as String: account,
      kSecAttrAccessGroup as String: accessGroup]
  }

  private static func item(account: String) -> Data? {
    guard var request = query(account: account) else { return nil }
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data else { return nil }
    return data
  }

  static func session() -> String? {
    guard let data = item(account: "multiplayer") else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func setSession(_ header: String) {
    queue.sync { updateSession(header) }
  }

  private static func updateSession(_ header: String) {
    guard let request = query(account: "multiplayer"), session() != header else { return }
    clear()
    SecItemDelete(request as CFDictionary)
    guard !header.isEmpty else { return }
    var item = request
    item[kSecValueData as String] = Data(header.utf8)
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    // An unavailable access group stays signed out instead of falling back to
    // plaintext credentials. Entitlements are installed for both targets.
    SecItemAdd(item as CFDictionary, nil)
  }

  private static func save(_ value: SavedBriefing) {
    guard let request = query(account: "briefing"),
      let data = try? JSONEncoder().encode(value), data.count <= 131072 else { return }
    SecItemDelete(request as CFDictionary)
    var record = request
    record[kSecValueData as String] = data
    record[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(record as CFDictionary, nil)
  }

  /// `maxAge` is how old a saved copy may be before the network is asked.
  /// The default keeps polls to one a minute; the dock passes a few seconds
  /// right after a turn so the new figures are not served from before it.
  static func refresh(maxAge: TimeInterval = 60, _ completion: @escaping (SavedBriefing?) -> Void) {
    queue.async {
      pending.append(completion)
      guard pending.count == 1 else { return }
      func finish(_ value: SavedBriefing?) {
        let callbacks = pending
        pending.removeAll()
        callbacks.forEach { callback in DispatchQueue.main.async { callback(value) } }
      }
      guard let cookie = session(), !cookie.isEmpty else { clear(); finish(nil); return }
      if let saved = read(), saved.schema == currentSchema, Date().timeIntervalSince(saved.updatedAt) < maxAge {
        finish(saved); return
      }
      let config = URLSessionConfiguration.ephemeral
      config.timeoutIntervalForRequest = 10
      config.timeoutIntervalForResource = 12
      config.httpCookieStorage = nil
      config.urlCache = nil
      let client = URLSession(configuration: config, delegate: NoBriefingRedirect(), delegateQueue: nil)
      var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
      request.setValue(cookie, forHTTPHeaderField: "Cookie")
      request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
      client.dataTask(with: request) { bytes, response, _ in
        queue.async {
          defer { client.finishTasksAndInvalidate() }
          guard session() == cookie else { clear(); finish(nil); return }
          if let code = (response as? HTTPURLResponse)?.statusCode, code == 401 || code == 403 {
            clear(); finish(nil); return
          }
          guard (response as? HTTPURLResponse)?.statusCode == 200,
            let bytes = bytes, bytes.count <= 131072,
            var data = try? JSONDecoder().decode(BriefingStatus.self, from: bytes),
            data.name != nil || data.status == "no-character" else { finish(read()); return }
          data.name = data.name.map { String($0.prefix(120)) }
          data.avatarUrl = trustedImageURL(data.avatarUrl)
          if var corporation = data.corpNav {
            corporation.logoUrl = trustedImageURL(corporation.logoUrl)
            corporation.marketCap = corporation.marketCap.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
            corporation.history = corporation.history.map { Array($0.suffix(12)) }
            data.corpNav = corporation
          }
          data.nationalInfluence = data.nationalInfluence.flatMap { $0.isFinite ? $0 : nil }
          data.perTurn = data.perTurn?.bounded()
          data.marketWatch = data.marketWatch?.prefix(5).map { item in
            var safe = item
            safe.name = String(safe.name.prefix(120))
            safe.logoUrl = trustedImageURL(safe.logoUrl)
            safe.tickerSymbol = safe.tickerSymbol.map { String($0.prefix(8)) }
            return safe
          }
          data.turnBriefing = data.turnBriefing?.prefix(5).filter { item in
            item.value.isFinite && item.delta.isFinite && gamePath(item.href) != nil
          }.map { item in
            var safe = item
            safe.category = String(safe.category.prefix(20))
            safe.label = String(safe.label.prefix(80))
            safe.unit = String(safe.unit.prefix(16))
            return safe
          }
          if var turn = data.turn, turn.current.isFinite {
            turn.date = turn.date.map { String($0.prefix(40)) }
            turn.nextAt = turn.nextAt.flatMap { $0.utf8.count <= 40 ? $0 : nil }
            data.turn = turn
          } else {
            data.turn = nil
          }
          if let inbox = data.inbox, inbox.unread.isFinite, inbox.mail.isFinite {
            data.inbox = BriefingStatus.InboxCounts(unread: min(max(inbox.unread, 0), 99_999), mail: min(max(inbox.mail, 0), 99_999))
          } else {
            data.inbox = nil
          }
          let wanted = [("avatar", data.avatarUrl), ("corporation", data.corpNav?.logoUrl),
            ("stocks", data.marketWatch?.first?.logoUrl)]
          fetchImages(wanted.compactMap { key, url in url.map { (key, $0) } }, previous: read()) { images, sources in
            let saved = SavedBriefing(updatedAt: Date(), sessionId: fingerprint(cookie), data: data,
              images: images, imageSources: sources, schema: currentSchema)
            save(saved)
            finish(saved)
          }
        }
      }.resume()
    }
  }

  /// Thumbnails for the widget, reusing the previous bytes when the URL has
  /// not changed. Bounded: 6 seconds, 4 MB per download, 24 KB per thumbnail,
  /// so the whole record stays inside the 128 KB keychain cap.
  private static func fetchImages(_ wanted: [(String, String)], previous: SavedBriefing?,
    completion: @escaping ([String: Data], [String: String]) -> Void) {
    var images = [String: Data]()
    var sources = [String: String]()
    var downloads = [(String, URL)]()
    for (key, value) in wanted {
      if previous?.imageSources?[key] == value, let bytes = previous?.images?[key] {
        images[key] = bytes
        sources[key] = value
      } else if let url = URL(string: value) {
        downloads.append((key, url))
      }
    }
    guard !downloads.isEmpty else { completion(images, sources); return }
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 6
    config.timeoutIntervalForResource = 6
    config.httpCookieStorage = nil
    config.urlCache = nil
    let client = URLSession(configuration: config, delegate: NoBriefingRedirect(), delegateQueue: nil)
    let group = DispatchGroup()
    for (key, url) in downloads {
      group.enter()
      client.dataTask(with: url) { bytes, response, _ in
        defer { group.leave() }
        guard (response as? HTTPURLResponse)?.statusCode == 200, let bytes = bytes, bytes.count <= 4_000_000,
          let thumb = thumbnail(bytes) else { return }
        queue.async(group: group) {
          images[key] = thumb
          sources[key] = url.absoluteString
        }
      }.resume()
    }
    group.notify(queue: queue) {
      client.finishTasksAndInvalidate()
      completion(images, sources)
    }
  }

  private static func thumbnail(_ bytes: Data) -> Data? {
    guard let source = CGImageSourceCreateWithData(bytes as CFData, nil) else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: 132,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
    // PNG keeps logo transparency; a photo that encodes too large falls back to JPEG.
    for (type, quality) in [("public.png", 1.0), ("public.jpeg", 0.8)] {
      let out = NSMutableData()
      guard let destination = CGImageDestinationCreateWithData(out, type as CFString, 1, nil) else { continue }
      CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
      if CGImageDestinationFinalize(destination), out.length <= 24_000 { return out as Data }
    }
    return nil
  }

  /// A bounded path on the game site, or nil for anything that could leave it.
  static func gamePath(_ value: String) -> String? {
    guard value.utf8.count <= 300, value.hasPrefix("/"), !value.hasPrefix("//"),
      !value.contains("\\"), value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
      value.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
    return value
  }

  private static func trustedImageURL(_ value: String?) -> String? {
    guard let value = value, value.utf8.count <= 2048, let url = URL(string: value),
      url.scheme == "https", let host = url.host?.lowercased() else { return nil }
    let trusted = host == "ahousedividedgame.com" || host.hasSuffix(".ahousedividedgame.com")
      || host == "cdn.discordapp.com" || host.hasSuffix(".public.blob.vercel-storage.com")
    return trusted ? value : nil
  }
}

private final class NoBriefingRedirect: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}
