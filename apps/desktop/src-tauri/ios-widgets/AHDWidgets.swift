import SwiftUI
import UIKit
import WidgetKit

struct BriefingEntry: TimelineEntry {
  let date: Date
  let saved: SavedBriefing?
}

struct BriefingProvider: TimelineProvider {
  func placeholder(in context: Context) -> BriefingEntry { BriefingEntry(date: Date(), saved: .sample) }
  func getSnapshot(in context: Context, completion: @escaping (BriefingEntry) -> Void) {
    // The widget gallery shows example figures; real stats appear once added.
    completion(BriefingEntry(date: Date(), saved: context.isPreview ? .sample : BriefingStore.read()))
  }
  func getTimeline(in context: Context, completion: @escaping (Timeline<BriefingEntry>) -> Void) {
    BriefingStore.refresh { saved in
      let now = Date()
      // A later entry clears expired stats even if the OS delays networking.
      let expiry = max(now.addingTimeInterval(1), (saved?.updatedAt ?? now).addingTimeInterval(86400))
      var entries = [BriefingEntry(date: now, saved: saved)]
      var refresh = now.addingTimeInterval(1800)
      if let next = saved?.data.nextTurn, next > now, next < expiry {
        // Flip the countdown at turn time, then fetch once the turn has had a
        // few minutes to finish processing.
        entries.append(BriefingEntry(date: next, saved: saved))
        refresh = min(refresh, max(next.addingTimeInterval(300), now.addingTimeInterval(600)))
      }
      entries.append(BriefingEntry(date: expiry, saved: nil))
      completion(Timeline(entries: entries, policy: .after(refresh)))
    }
  }
}

extension SavedBriefing {
  /// Example figures for the widget gallery and loading placeholder only.
  static var sample: SavedBriefing {
    var data = BriefingStatus()
    data.status = "ready"
    data.name = "Your character"
    data.actions = 7
    data.actionCap = 15
    data.funds = 48_200
    data.personalHomeLiquid = 1_250_000
    data.homeCurrency = "USD"
    data.politicalInfluence = 64
    data.nationalInfluence = 18.6
    data.favorability = 52
    data.electionStats = BriefingStatus.ElectionStats(electionId: "000000000000000000000000",
      electionType: "Senate", countryId: "US", state: "Ohio", myVotePct: 47.8, marginPct: 2.4,
      history: [41, 43.5, 44, 46.2, 45.9, 47.8].enumerated().map {
        BriefingStatus.ElectionPoint(turn: Double($0.offset), pct: $0.element, seats: nil)
      })
    data.corpNav = BriefingStatus.CorporationStats(sequentialId: 1, name: "Example Industries",
      tickerSymbol: "EXI", sharePrice: 18.4, priceChange1h: 3.2, liquidCapital: 2_400_000,
      liquidCurrencyCode: "USD", marketingStrength: 41, marketCap: 18_400_000,
      history: [15.1, 15.8, 16.4, 16.1, 17.2, 18.4].enumerated().map {
        BriefingStatus.CorporationPoint(turn: Double($0.offset), sharePrice: $0.element,
          marketingStrength: 41, liquidCapital: 2_400_000, marketCap: $0.element * 1_000_000)
      })
    data.marketWatch = [
      BriefingStatus.MarketWatchItem(sequentialId: 1, name: "Example Industries", logoUrl: nil,
        tickerSymbol: "EXI", sharePrice: 18.4, liquidCurrencyCode: "USD", ownedShares: 1200),
      BriefingStatus.MarketWatchItem(sequentialId: 2, name: "Lakeside Rail", logoUrl: nil,
        tickerSymbol: "LKR", sharePrice: 6.75, liquidCurrencyCode: "USD", ownedShares: 400),
      BriefingStatus.MarketWatchItem(sequentialId: 3, name: "Northern Steel", logoUrl: nil,
        tickerSymbol: "NST", sharePrice: 31.2, liquidCurrencyCode: "USD", ownedShares: 90),
    ]
    data.turnBriefing = [
      BriefingStatus.TurnChange(category: "election", label: "Vote share", value: 47.8, delta: 1.9,
        unit: "percent", href: "/elections"),
      BriefingStatus.TurnChange(category: "markets", label: "Share price", value: 18.4, delta: 1.2,
        unit: "currency", href: "/corporation/1"),
      BriefingStatus.TurnChange(category: "corporation", label: "Liquid capital", value: 2_400_000,
        delta: -85_000, unit: "currency", href: "/corporation/1"),
    ]
    data.turn = BriefingStatus.TurnClock(current: 50, date: "March 1953, Week 2",
      nextAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(23 * 60)), active: true)
    data.inbox = BriefingStatus.InboxCounts(unread: 3, mail: 1)
    data.perTurn = BriefingStatus.PerTurn(funds: 1_850, politicalInfluence: -0.32, nationalInfluence: 0.64,
      favorability: -0.1, voteShare: 1.9, sharePrice: 1.2, marketCap: 1_200_000, liquidCapital: -85_000)
    return SavedBriefing(updatedAt: Date(), sessionId: "", data: data)
  }
}

private enum Palette {
  static let gold = Color(red: 0.91, green: 0.72, blue: 0.32)
  static let cream = Color(red: 0.97, green: 0.94, blue: 0.86)
  static let navy = Color(red: 0.035, green: 0.055, blue: 0.09)
  static let ink = Color(red: 0.09, green: 0.08, blue: 0.12)
  static let red = Color(red: 0.63, green: 0.10, blue: 0.14)
  static let gain = Color(red: 0.40, green: 0.84, blue: 0.52)
  static let loss = Color(red: 0.98, green: 0.44, blue: 0.42)
  static let blue = Color(red: 0.52, green: 0.72, blue: 0.98)
}

private enum Format {
  private static let formatters: [Int: NumberFormatter] = {
    var result = [Int: NumberFormatter]()
    for digits in [1, 2] {
      let formatter = NumberFormatter()
      formatter.numberStyle = .decimal
      formatter.maximumFractionDigits = digits
      result[digits] = formatter
    }
    return result
  }()

  /// Compact figure: 1.2K, 3.4M, 5.6B. Values under 10 keep two decimals so
  /// small prices and influence changes stay readable.
  static func number(_ value: Double?, suffix: String = "") -> String {
    guard let value = value, value.isFinite else { return "n/a" }
    let units: [(Double, String)] = [(1e9, "B"), (1e6, "M"), (1e4, "K")]
    for (threshold, symbol) in units where abs(value) >= threshold {
      let divisor = symbol == "K" ? 1000 : threshold
      return text(value / divisor, digits: 1) + symbol + suffix
    }
    return text(value, digits: abs(value) < 10 ? 2 : 1) + suffix
  }

  private static func text(_ value: Double, digits: Int) -> String {
    formatters[digits]?.string(from: NSNumber(value: value)) ?? String(value)
  }

  static func signed(_ value: Double, suffix: String = "") -> String {
    (value > 0 ? "+" : "") + number(value, suffix: suffix)
  }

  /// A per-turn change, or nil when it is unknown or rounds to nothing.
  static func change(_ value: Double?, suffix: String = "") -> String? {
    guard let value = value, value.isFinite, abs(value) >= 0.005 else { return nil }
    return signed(value, suffix: suffix)
  }

  static func currency(_ code: String?) -> String { code.map { " \($0)" } ?? "" }

  /// A turn change in its own unit. Vote share moves in percentage points.
  static func change(_ item: BriefingStatus.TurnChange, currency code: String?) -> (value: String, delta: String) {
    switch item.unit {
    case "currency": return (number(item.value, suffix: currency(code)), signed(item.delta, suffix: currency(code)))
    case "percent": return (number(item.value, suffix: "%"), signed(item.delta, suffix: " pp"))
    default: return (number(item.value), signed(item.delta))
    }
  }
}

/// Recent values on their own panel: a lighter card, dashed grid, a solid
/// baseline, a heavy line over a filled area, and a dot on the latest value,
/// so the trend reads clearly against the dark widget background.
private struct TrendChart: View {
  let values: [Double]
  let color: Color
  /// Formats the high and low labels; nil hides the scale.
  var scale: ((Double) -> String)? = nil

  private var points: [Double] { Array(values.filter(\.isFinite).suffix(12)) }

  private func plot(_ size: CGSize) -> CGRect {
    CGRect(x: 5, y: 5, width: max(size.width - 10, 1), height: max(size.height - 10, 1))
  }

  private func locations(_ size: CGSize) -> [CGPoint] {
    let values = points
    guard values.count >= 2, let low = values.min(), let high = values.max() else { return [] }
    let rect = plot(size)
    let spread = max(high - low, 0.0001)
    return values.enumerated().map { index, value in
      CGPoint(x: rect.minX + rect.width * CGFloat(index) / CGFloat(values.count - 1),
        y: rect.maxY - rect.height * CGFloat((value - low) / spread))
    }
  }

  private func line(_ size: CGSize) -> Path {
    var path = Path()
    let spots = locations(size)
    guard let first = spots.first else { return path }
    path.move(to: first)
    for spot in spots.dropFirst() { path.addLine(to: spot) }
    return path
  }

  private func area(_ size: CGSize) -> Path {
    var path = line(size)
    let spots = locations(size)
    guard let first = spots.first, let last = spots.last else { return Path() }
    let bottom = plot(size).maxY
    path.addLine(to: CGPoint(x: last.x, y: bottom))
    path.addLine(to: CGPoint(x: first.x, y: bottom))
    path.closeSubpath()
    return path
  }

  private func grid(_ size: CGSize) -> Path {
    var path = Path()
    let rect = plot(size)
    for fraction in [0.0, 0.5] {
      let y = rect.minY + rect.height * CGFloat(fraction)
      path.move(to: CGPoint(x: rect.minX, y: y))
      path.addLine(to: CGPoint(x: rect.maxX, y: y))
    }
    return path
  }

  private func baseline(_ size: CGSize) -> Path {
    var path = Path()
    let rect = plot(size)
    path.move(to: CGPoint(x: rect.minX, y: rect.maxY))
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
    return path
  }

  var body: some View {
    HStack(spacing: 4) {
      GeometryReader { geometry in
        ZStack(alignment: .topLeading) {
          RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color.white.opacity(0.07))
          grid(geometry.size).stroke(Color.white.opacity(0.14), style: StrokeStyle(lineWidth: 0.5, dash: [2, 3]))
          baseline(geometry.size).stroke(Color.white.opacity(0.32), lineWidth: 0.75)
          area(geometry.size)
            .fill(LinearGradient(colors: [color.opacity(0.45), color.opacity(0.04)], startPoint: .top, endPoint: .bottom))
          line(geometry.size)
            .stroke(color, style: StrokeStyle(lineWidth: 2.25, lineCap: .round, lineJoin: .round))
            .shadow(color: Color.black.opacity(0.5), radius: 1.5, x: 0, y: 1)
          if let end = locations(geometry.size).last {
            Circle().fill(color).frame(width: 6, height: 6)
              .overlay(Circle().stroke(Palette.navy, lineWidth: 1.5))
              .position(end)
          }
        }
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(Color.white.opacity(0.14), lineWidth: 0.5))
      }
      if let scale = scale, let low = points.min(), let high = points.max() {
        VStack(alignment: .trailing, spacing: 0) {
          Text(scale(high))
          Spacer(minLength: 0)
          Text(scale(low))
        }
        .font(.system(size: 9, weight: .medium)).monospacedDigit()
        .foregroundColor(Palette.cream.opacity(0.6)).lineLimit(1).padding(.vertical, 2)
      }
    }
  }
}

private enum Accessory { case circular, rectangular, inline }

/// One labelled figure with its per-turn change. `short` is the label used
/// where the widget is narrow.
private struct Figure {
  let label: String
  let short: String
  let value: String
  let change: String?
  let positive: Bool

  init(_ label: String, short: String? = nil, _ value: String, change: String? = nil, positive: Bool = true) {
    self.label = label
    self.short = short ?? label
    self.value = value
    self.change = change
    self.positive = positive
  }
}

private struct Row {
  let title: String
  let detail: String
  let value: String
  let change: String?
  let positive: Bool
  let path: String?
}

struct BriefingWidgetView: View {
  let entry: BriefingEntry
  let section: String
  @Environment(\.widgetFamily) var environmentFamily
  /// Set only by the render check, which draws each size outside WidgetKit.
  var familyOverride: WidgetFamily? = nil
  private var family: WidgetFamily { familyOverride ?? environmentFamily }

  private var data: BriefingStatus? { entry.saved?.data }
  private var isSmall: Bool { family == .systemSmall }
  private var isExtraLarge: Bool { family == .systemExtraLarge }
  /// Large and extra large share the roomy type sizes.
  private var isLarge: Bool { family == .systemLarge || isExtraLarge }

  private var accessory: Accessory? {
    if #available(iOSApplicationExtension 16.0, *) {
      switch family {
      case .accessoryCircular: return .circular
      case .accessoryRectangular: return .rectangular
      case .accessoryInline: return .inline
      default: return nil
      }
    }
    return nil
  }

  private var accent: Color {
    section == "election" ? Palette.blue :
      section == "corporation" || section == "stocks" ? Palette.gold :
      section == "overview" ? Palette.cream : Color(red: 0.86, green: 0.30, blue: 0.32)
  }

  private var sectionName: String {
    switch section {
    case "profile": return "Profile"
    case "election": return "Election"
    case "stocks": return "Stocks"
    case "overview": return "Overview"
    default: return "Corporation"
    }
  }

  private var title: String {
    if section == "profile" || section == "overview" { return data?.name ?? sectionName }
    if section == "stocks" {
      if !isSmall, let count = data?.marketWatch?.count, count > 1 { return "Your holdings" }
      if let watched = data?.marketWatch?.first { return watched.tickerSymbol.map { "$\($0.uppercased())" } ?? watched.name }
    }
    if section == "corporation" { return data?.corpNav?.name ?? "Corporation" }
    return "Your election"
  }

  /// The identity line under the name, like the page mastheads.
  private var subtitle: String {
    if section == "overview" || section == "profile", let turn = data?.turn {
      // Small widgets have room for the turn only; the in-game date was cut off.
      return (isSmall ? ["Turn \(Int(turn.current))"] : ["Turn \(Int(turn.current))", turn.date])
        .compactMap { $0 }.joined(separator: " · ")
    }
    if section == "stocks", let watched = data?.marketWatch {
      if !isSmall && watched.count > 1 { return "\(watched.count) companies" }
      if let first = watched.first { return first.name }
    }
    if section == "corporation", let ticker = data?.corpNav?.tickerSymbol, !ticker.isEmpty {
      return "$\(ticker.uppercased())"
    }
    if section == "election", let election = data?.electionStats {
      let parts = [election.electionType, election.state ?? election.countryId].compactMap { $0 }.filter { !$0.isEmpty }
      if !parts.isEmpty { return parts.joined(separator: " · ") }
    }
    return sectionName
  }

  private var identityImage: UIImage? {
    let key = section == "corporation" || section == "stocks" ? section : "avatar"
    guard let bytes = entry.saved?.images?[key] else { return nil }
    return UIImage(data: bytes)
  }

  private var monogram: String {
    let words = title.replacingOccurrences(of: "$", with: "").split(separator: " ").prefix(2)
    let letters = words.compactMap(\.first)
    return letters.isEmpty ? "A" : String(letters).uppercased()
  }

  // MARK: Per-turn changes

  /// The change between the two latest recorded values.
  private func latestChange(_ values: [Double]) -> Double? {
    guard values.count >= 2 else { return nil }
    let delta = values[values.count - 1] - values[values.count - 2]
    return delta.isFinite ? delta : nil
  }

  /// How far the vote share moved in the latest recorded turn.
  private var voteChange: Double? {
    data?.perTurn?.voteShare ?? latestChange(data?.electionStats?.history?.map(\.pct) ?? [])
  }

  private var corpHistory: [BriefingStatus.CorporationPoint] { data?.corpNav?.history ?? [] }

  private var sharePriceChange: Double? {
    data?.perTurn?.sharePrice ?? latestChange(corpHistory.map(\.sharePrice))
  }

  private var marketCapChange: Double? {
    data?.perTurn?.marketCap ?? latestChange(corpHistory.compactMap(\.marketCap))
  }

  private var capitalChange: Double? {
    data?.perTurn?.liquidCapital ?? latestChange(corpHistory.map(\.liquidCapital))
  }

  /// Share price change as a percentage of the previous turn's price.
  private var sharePricePercent: Double? {
    guard let delta = sharePriceChange, let price = data?.corpNav?.sharePrice else { return nil }
    let previous = price - delta
    guard previous > 0 else { return nil }
    let percent = delta / previous * 100
    return percent.isFinite ? percent : nil
  }

  /// The one large figure, its label, and an optional signed change.
  private var hero: (label: String, value: String, change: String?, positive: Bool)? {
    guard let data = data, data.status != "no-character" else { return nil }
    switch section {
    case "profile", "overview":
      if data.isImperial == true {
        return ("Personal cash", Format.number(data.personalHomeLiquid, suffix: Format.currency(data.homeCurrency)), nil, true)
      }
      let actions = data.actionCap.map { "\(Format.number(data.actions)) / \(Format.number($0))" } ?? Format.number(data.actions)
      return ("Actions", actions, nil, true)
    case "election":
      guard let election = data.electionStats else { return nil }
      return ("Vote share", Format.number(election.myVotePct, suffix: "%"),
        Format.change(voteChange, suffix: " pp"), (voteChange ?? 0) >= 0)
    case "stocks":
      guard let watched = data.marketWatch?.first else { return nil }
      return ("Quote", Format.number(watched.sharePrice, suffix: Format.currency(watched.liquidCurrencyCode)), nil, true)
    default:
      guard let corp = data.corpNav else { return nil }
      let price = Format.number(corp.sharePrice, suffix: Format.currency(corp.liquidCurrencyCode))
      if let delta = sharePriceChange, let change = Format.change(delta) {
        // Small widgets show only the percentage; wider ones show both.
        let percent = Format.change(sharePricePercent, suffix: "%")
        let text = isSmall ? (percent ?? change) : percent.map { "\(change) (\($0))" } ?? change
        return ("Share price", price, text, delta >= 0)
      }
      // Servers without per-turn changes: fall back to the last hour.
      let hour = corp.priceChange1h.flatMap { $0.isFinite ? $0 : nil }
      return ("Share price", price, hour.flatMap { Format.change($0, suffix: "%") }, (hour ?? 0) >= 0)
    }
  }

  private var inboxText: String? {
    guard let inbox = data?.inbox else { return nil }
    return inbox.unread > 0 ? "\(Format.number(inbox.unread)) unread" : "All read"
  }

  private func figure(_ label: String, short: String? = nil, _ value: String, change: Double?, suffix: String = "") -> Figure {
    Figure(label, short: short, value, change: Format.change(change, suffix: suffix), positive: (change ?? 0) >= 0)
  }

  /// The character's standing, each with its per-turn change.
  private var standing: [Figure] {
    guard let data = data, data.isImperial != true else { return [] }
    let money = Format.currency(data.homeCurrency)
    var result = [figure("Campaign funds", short: "Funds", Format.number(data.funds, suffix: money), change: data.perTurn?.funds),
      figure("State influence", short: "State", Format.number(data.politicalInfluence, suffix: "%"),
        change: data.perTurn?.politicalInfluence)]
    if let national = data.nationalInfluence {
      result.append(figure("National influence", short: "National", Format.number(national), change: data.perTurn?.nationalInfluence))
    }
    result.append(figure("Favorability", short: "Favor", Format.number(data.favorability, suffix: "%"),
      change: data.perTurn?.favorability))
    return result
  }

  /// The labelled figures beside or under the hero, most important first.
  private var figures: [Figure] {
    guard let data = data else { return [] }
    let money = Format.currency(data.homeCurrency)
    let cash = Figure("Personal cash", short: "Cash", Format.number(data.personalHomeLiquid, suffix: money))
    switch section {
    case "profile":
      var result = standing
      if data.isImperial == true { result.append(cash) } else { result.insert(cash, at: min(1, result.count)) }
      if let inbox = inboxText { result.append(Figure("Inbox", inbox)) }
      return result
    case "overview":
      var result = [Figure]()
      if let inbox = inboxText { result.append(Figure("Inbox", inbox)) }
      result += standing
      if let mail = data.inbox?.mail { result.append(Figure("Mail", mail > 0 ? "\(Format.number(mail)) unread" : "All read")) }
      result.append(cash)
      return result
    case "election":
      guard let election = data.electionStats else { return [] }
      var result = [Figure("Margin", Format.signed(election.marginPct ?? .nan, suffix: " pp"),
        positive: (election.marginPct ?? 0) >= 0)]
      if election.isMultiSeat == true {
        let seats = election.totalSeats.map { "\(Format.number(election.seatsProjected)) / \(Format.number($0))" }
          ?? Format.number(election.seatsProjected)
        let seatChange = latestChange((election.history ?? []).compactMap(\.seats))
        result.append(figure("Projected seats", short: "Seats", seats, change: seatChange))
      }
      if let end = election.endTurn, end.isFinite {
        if let now = data.turn?.current, end > now {
          let left = Int(end - now)
          result.append(Figure("Polls close", short: "Polls", left == 1 ? "Next turn" : "In \(left) turns"))
        } else {
          result.append(Figure("Polls close", short: "Polls", "Turn \(Int(end))"))
        }
      }
      let shares = (election.history ?? []).map(\.pct)
      if shares.count >= 3, let first = shares.first, let last = shares.last {
        result.append(figure("Over \(shares.count) turns", short: "\(shares.count) turns",
          Format.signed(last - first, suffix: " pp"), change: nil))
      }
      return result
    case "stocks":
      guard let watched = data.marketWatch?.first else { return [] }
      var result = [Figure("Shares owned", short: "Shares", Format.number(watched.ownedShares))]
      if let price = watched.sharePrice, price.isFinite {
        result.append(Figure("Holding value", short: "Value", Format.number(price * watched.ownedShares, suffix: Format.currency(watched.liquidCurrencyCode))))
      }
      return result
    default:
      guard let corp = data.corpNav else { return [] }
      let money = Format.currency(corp.liquidCurrencyCode)
      var result = [Figure]()
      if let cap = corp.marketCap {
        result.append(figure("Market cap", short: "Mkt cap", Format.number(cap, suffix: money), change: marketCapChange))
      }
      result.append(figure("Liquid capital", short: "Capital", Format.number(corp.liquidCapital, suffix: money), change: capitalChange))
      result.append(figure("Marketing", Format.number(corp.marketingStrength),
        change: latestChange(corpHistory.map(\.marketingStrength))))
      if let hour = corp.priceChange1h, hour.isFinite {
        result.append(Figure("Last hour", Format.signed(hour, suffix: "%"), positive: hour >= 0))
      }
      let prices = corpHistory.map(\.sharePrice)
      if prices.count >= 3, let first = prices.first, let last = prices.last, first > 0 {
        let trend = (last - first) / first * 100
        result.append(Figure("Over \(prices.count) turns", short: "\(prices.count) turns",
          Format.signed(trend, suffix: "%"), positive: trend >= 0))
      }
      return result
    }
  }

  private var chartValues: [Double] {
    if section == "election" { return data?.electionStats?.history?.map(\.pct) ?? [] }
    if section == "corporation" { return corpHistory.map(\.sharePrice) }
    return []
  }

  /// Blue for vote share; green or red for a rising or falling share price.
  private var chartColor: Color {
    if section == "election" { return Palette.blue }
    guard let first = chartValues.first, let last = chartValues.last else { return Palette.gold }
    return last >= first ? Palette.gain : Palette.loss
  }

  private var chartLabel: String {
    let count = min(chartValues.count, 12)
    return section == "election" ? "Vote share, last \(count) turns" : "Share price, last \(count) turns"
  }

  private func chartScale(_ value: Double) -> String {
    section == "election" ? Format.number(value, suffix: "%") : Format.number(value)
  }

  private var holdingRows: [Row] {
    (data?.marketWatch ?? []).map { item in
      let money = Format.currency(item.liquidCurrencyCode)
      return Row(title: item.tickerSymbol.map { "$\($0.uppercased())" } ?? item.name,
        detail: "\(Format.number(item.ownedShares)) shares", value: Format.number(item.sharePrice, suffix: money),
        change: item.sharePrice.map { Format.number($0 * item.ownedShares, suffix: money) }, positive: true,
        path: "/corporation/\(item.sequentialId)")
    }
  }

  private var changeRows: [Row] {
    let money = data?.corpNav?.liquidCurrencyCode
    return (data?.turnBriefing ?? []).map { item in
      let text = Format.change(item, currency: item.category == "election" ? nil : money)
      return Row(title: item.label, detail: item.category.capitalized, value: text.value, change: text.delta,
        positive: item.delta >= 0, path: BriefingStore.gamePath(item.href))
    }
  }

  /// Corporation and election figures already carry their own changes, so
  /// the latest-turn list only adds to the overview and profile.
  private var rows: [Row] {
    switch section {
    case "stocks": return holdingRows
    case "overview", "profile": return changeRows
    default: return []
    }
  }
  private var rowsTitle: String { section == "stocks" ? "Holdings" : "Latest turn" }

  private var emptyMessage: String {
    guard let saved = entry.saved else { return "Open the app and sign in to multiplayer." }
    if saved.data.status == "no-character" { return "Choose a character in the app." }
    if section == "election" { return "No election tally yet." }
    if section == "stocks" { return "No watched stocks yet." }
    return "Your character does not lead a corporation."
  }

  private var link: URL? {
    switch section {
    case "overview": return URL(string: "ahdclient://briefing/inbox")
    default: return URL(string: "ahdclient://briefing/\(section)")
    }
  }

  // MARK: Pieces

  private var mark: some View {
    Group {
      if let image = UIImage(named: "ahd-mark") {
        Image(uiImage: image).resizable().scaledToFit()
      } else {
        Text("AHD").font(.system(size: 9, weight: .black, design: .serif)).foregroundColor(Palette.cream.opacity(0.7))
      }
    }.frame(width: 16, height: 16).opacity(0.9)
  }

  private func identity(size: CGFloat) -> some View {
    let round = section == "profile" || section == "election" || section == "overview"
    let shape = RoundedRectangle(cornerRadius: round ? size / 2 : size * 0.22, style: .continuous)
    return ZStack {
      if let image = identityImage {
        Image(uiImage: image).resizable().scaledToFill()
      } else if entry.saved == nil, let markImage = UIImage(named: "ahd-mark") {
        Image(uiImage: markImage).resizable().scaledToFit()
      } else {
        LinearGradient(colors: [accent.opacity(0.85), Palette.red], startPoint: .topLeading, endPoint: .bottomTrailing)
        Text(monogram).font(.system(size: size * 0.36, weight: .semibold, design: .serif)).foregroundColor(Palette.cream)
      }
    }
    .frame(width: size, height: size)
    .clipShape(shape)
    .overlay(shape.stroke(Color.white.opacity(0.14), lineWidth: 0.5))
  }

  private var header: some View {
    HStack(alignment: .center, spacing: 7) {
      identity(size: isSmall ? 24 : 30)
      VStack(alignment: .leading, spacing: 1) {
        Text(title).font(.system(size: isSmall ? 13 : 15, weight: .semibold, design: .serif))
          .foregroundColor(Palette.cream).lineLimit(1).minimumScaleFactor(0.7)
        Text(subtitle.uppercased()).font(.system(size: 9, weight: .semibold)).tracking(0.5)
          .foregroundColor(accent).lineLimit(1)
      }
      Spacer(minLength: 2)
      if !isSmall { mark }
    }
  }

  private func label(_ text: String) -> some View {
    Text(text.uppercased()).font(.system(size: 9, weight: .medium)).tracking(0.4)
      .foregroundColor(Palette.cream.opacity(0.55)).lineLimit(1)
  }

  private func changeText(_ text: String, positive: Bool, size: CGFloat) -> some View {
    Text(text).font(.system(size: size, weight: .semibold)).monospacedDigit()
      .foregroundColor(positive ? Palette.gain : Palette.loss).lineLimit(1).minimumScaleFactor(0.7)
  }

  private func heroView(_ hero: (label: String, value: String, change: String?, positive: Bool), stacked: Bool = false) -> some View {
    VStack(alignment: .leading, spacing: 1) {
      label(hero.label)
      if stacked {
        // Medium widgets: the value gets the full column width and the change
        // sits on its own line, so neither is cut off.
        Text(hero.value).font(.system(size: 20, weight: .semibold, design: .rounded))
          .monospacedDigit().foregroundColor(Palette.cream).lineLimit(1).minimumScaleFactor(0.6)
        if let change = hero.change {
          changeText(change, positive: hero.positive, size: 10)
        }
      } else {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
          Text(hero.value).font(.system(size: isSmall ? 20 : isLarge ? 26 : 22, weight: .semibold, design: .rounded))
            .monospacedDigit().foregroundColor(Palette.cream).lineLimit(1).minimumScaleFactor(0.55)
            .layoutPriority(1)
          if let change = hero.change {
            changeText(change, positive: hero.positive, size: isSmall ? 10 : 11)
          }
        }
      }
    }
  }

  /// A compact table row: label left, value and per-turn change right.
  private func figureRow(_ item: Figure) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 4) {
      // The label never truncates ("FUN...", "MKT..."); the value scales down.
      label(item.short).fixedSize()
      Spacer(minLength: 3)
      Text(item.value).font(.system(size: 11, weight: .medium)).monospacedDigit()
        .foregroundColor(Palette.cream).lineLimit(1).minimumScaleFactor(0.5)
      if let change = item.change {
        // The change stays whole ("+3M", not "+..."); the value shrinks first.
        changeText(change, positive: item.positive, size: 9).fixedSize()
      }
    }
  }

  /// A grid cell: label above, value with its per-turn change below.
  private func figureCell(_ item: Figure) -> some View {
    VStack(alignment: .leading, spacing: 1) {
      label(item.label)
      HStack(alignment: .firstTextBaseline, spacing: 4) {
        Text(item.value).font(.system(size: 13, weight: .semibold, design: .rounded)).monospacedDigit()
          .foregroundColor(Palette.cream).lineLimit(1).minimumScaleFactor(0.6).layoutPriority(1)
        if let change = item.change {
          changeText(change, positive: item.positive, size: 9)
        }
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }

  /// Figures two to a row.
  private func figureGrid(_ items: [Figure]) -> some View {
    let pairs = stride(from: 0, to: items.count, by: 2).map { Array(items[$0..<min($0 + 2, items.count)]) }
    return VStack(alignment: .leading, spacing: 6) {
      ForEach(Array(pairs.enumerated()), id: \.offset) { _, pair in
        HStack(alignment: .top, spacing: 10) {
          ForEach(Array(pair.enumerated()), id: \.offset) { _, item in figureCell(item) }
          if pair.count == 1 { Spacer(minLength: 0).frame(maxWidth: .infinity) }
        }
      }
    }
  }

  private var rule: some View { Rectangle().fill(Color.white.opacity(0.1)).frame(height: 0.5) }

  /// "Next turn 12:34" counting down live, or why there is no countdown.
  @ViewBuilder private var turnClock: some View {
    if let turn = data?.turn {
      if turn.active == false {
        Text("Turns paused")
      } else if let next = data?.nextTurn, next > entry.date {
        (Text("Next turn ") + Text(next, style: .timer)).monospacedDigit()
      } else if data?.nextTurn != nil {
        Text("Next turn running")
      }
    }
  }

  /// The footer countdown. Timer text claims all the width it is offered, so
  /// it gets a fixed slot instead of being joined onto its label.
  @ViewBuilder private var footerClock: some View {
    if let turn = data?.turn {
      if turn.active == false {
        Text("Turns paused")
      } else if let next = data?.nextTurn, next > entry.date {
        HStack(spacing: 3) {
          Text("Next turn")
          Text(next, style: .timer).monospacedDigit().frame(width: 34, alignment: .leading)
        }
      } else if data?.nextTurn != nil {
        Text("Next turn running")
      }
    }
  }

  @ViewBuilder private var footer: some View {
    if let saved = entry.saved {
      HStack(spacing: 5) {
        if !isSmall, data?.turn != nil, section != "overview" {
          footerClock.foregroundColor(Palette.cream.opacity(0.75)).fixedSize()
        }
        Spacer(minLength: 4)
        HStack(spacing: 3) {
          Circle().fill(Palette.gain.opacity(0.85)).frame(width: 4, height: 4)
          Text(saved.updatedAt, style: .relative).multilineTextAlignment(.trailing)
        }.frame(maxWidth: 76, alignment: .trailing)
      }.font(.system(size: 9, weight: .medium)).foregroundColor(Palette.cream.opacity(0.5)).lineLimit(1)
    } else {
      Text("TAP TO OPEN").font(.system(size: 9, weight: .bold)).tracking(0.5).foregroundColor(Palette.gold.opacity(0.8))
    }
  }

  private func chart(height: CGFloat, scaled: Bool) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      if isLarge { label(chartLabel) }
      if scaled {
        TrendChart(values: chartValues, color: chartColor, scale: { value in chartScale(value) })
          .frame(height: height)
      } else {
        TrendChart(values: chartValues, color: chartColor).frame(height: height)
      }
    }
  }

  private func rowView(_ row: Row, compact: Bool) -> some View {
    let content = HStack(alignment: .center, spacing: 8) {
      VStack(alignment: .leading, spacing: 1) {
        Text(row.title).font(.system(size: 11, weight: .semibold)).foregroundColor(Palette.cream).lineLimit(1)
        if !compact {
          Text(row.detail.uppercased()).font(.system(size: 9, weight: .medium)).tracking(0.4)
            .foregroundColor(Palette.cream.opacity(0.5)).lineLimit(1)
        }
      }
      Spacer(minLength: 4)
      HStack(alignment: .firstTextBaseline, spacing: 5) {
        Text(row.value).font(.system(size: 11, weight: .medium)).monospacedDigit()
          .foregroundColor(Palette.cream).lineLimit(1).minimumScaleFactor(0.6)
        if let change = row.change {
          Text(change).font(.system(size: 9, weight: .semibold)).monospacedDigit()
            .foregroundColor(section == "stocks" ? Palette.cream.opacity(0.6) : row.positive ? Palette.gain : Palette.loss)
            .lineLimit(1)
        }
      }
    }
    return Group {
      if let path = row.path, let url = URL(string: "ahdclient://page\(path)") {
        Link(destination: url) { content }
      } else {
        content
      }
    }
  }

  private func rowList(limit: Int, compact: Bool, titled: Bool) -> some View {
    VStack(alignment: .leading, spacing: compact ? 3 : 5) {
      if titled { label(rowsTitle) }
      ForEach(Array(rows.prefix(limit).enumerated()), id: \.offset) { _, row in rowView(row, compact: compact) }
    }
  }

  // MARK: Layouts

  private var countdownHero: some View {
    VStack(alignment: .leading, spacing: 0) {
      label("Next turn")
      Group {
        if data?.turn?.active == false {
          Text("Paused")
        } else if let next = data?.nextTurn, next > entry.date {
          Text(next, style: .timer)
        } else {
          Text(data?.nextTurn == nil ? "n/a" : "Running")
        }
      }
      .font(.system(size: isLarge ? 26 : 22, weight: .semibold, design: .rounded)).monospacedDigit()
      .foregroundColor(Palette.cream).lineLimit(1).minimumScaleFactor(0.55)
      if let hero = hero {
        Text("\(hero.label) \(hero.value)").font(.system(size: 10, weight: .medium)).monospacedDigit()
          .foregroundColor(Palette.cream.opacity(0.75)).lineLimit(1)
      }
    }
  }

  private var smallLayout: some View {
    VStack(alignment: .leading, spacing: 3) {
      header
      Spacer(minLength: 0)
      if let hero = hero { heroView(hero) }
      if chartValues.count >= 2 {
        TrendChart(values: chartValues, color: chartColor).frame(height: 20)
        ForEach(Array(figures.prefix(1).enumerated()), id: \.offset) { _, item in figureRow(item) }
      } else {
        ForEach(Array(figures.prefix(3).enumerated()), id: \.offset) { _, item in figureRow(item) }
      }
      footer
    }
  }

  private var mediumLayout: some View {
    VStack(alignment: .leading, spacing: 6) {
      header
      rule
      if section == "stocks", rows.count > 1 {
        rowList(limit: 3, compact: true, titled: false)
        Spacer(minLength: 0)
      } else {
        // The hero column keeps a fixed share of the width. It used to give
        // way to the figures and shrink to a sliver ("SH...", a tiny chart).
        GeometryReader { geometry in
          HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
              if section == "overview" { countdownHero } else if let hero = hero { heroView(hero, stacked: true) }
              if chartValues.count >= 2 {
                chart(height: 30, scaled: false)
              } else {
                // No chart (Profile, Overview): the figures past the first
                // four fill the space under the hero instead of being dropped.
                ForEach(Array(figures.dropFirst(4).prefix(2).enumerated()), id: \.offset) { _, item in figureRow(item) }
                  .padding(.top, 2)
              }
            }
            .frame(width: figures.isEmpty ? geometry.size.width : geometry.size.width * 0.42, alignment: .leading)
            if !figures.isEmpty {
              VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(figures.prefix(4).enumerated()), id: \.offset) { _, item in figureRow(item) }
              }
              .frame(maxWidth: .infinity, alignment: .leading)
            }
          }
        }
      }
      footer
    }
  }

  private var largeLayout: some View {
    VStack(alignment: .leading, spacing: 7) {
      header
      rule
      if section == "overview" { countdownHero } else if let hero = hero { heroView(hero) }
      if chartValues.count >= 2 { chart(height: 64, scaled: true) }
      if !figures.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          if section != "stocks" { label("Green and red: change per turn") }
          figureGrid(Array(figures.prefix(6)))
        }
      }
      if !rows.isEmpty {
        rule
        rowList(limit: section == "stocks" ? 5 : chartValues.count >= 2 ? 2 : 3, compact: section != "stocks", titled: true)
      }
      Spacer(minLength: 0)
      footer
    }
  }

  /// iPad only: two columns, the hero and chart on the left, figures and rows on the right.
  private var extraLargeLayout: some View {
    VStack(alignment: .leading, spacing: 8) {
      header
      rule
      HStack(alignment: .top, spacing: 18) {
        VStack(alignment: .leading, spacing: 8) {
          if section == "overview" { countdownHero } else if let hero = hero { heroView(hero) }
          if chartValues.count >= 2 { chart(height: 96, scaled: true) }
          if section != "stocks", !figures.isEmpty, chartValues.count < 2 {
            figureGrid(Array(figures.prefix(6)))
          }
          Spacer(minLength: 0)
        }.frame(maxWidth: .infinity, alignment: .topLeading)
        VStack(alignment: .leading, spacing: 8) {
          if section != "stocks", !figures.isEmpty, chartValues.count >= 2 {
            label("Green and red: change per turn")
            figureGrid(Array(figures.prefix(6)))
          }
          if !rows.isEmpty {
            rowList(limit: section == "stocks" ? 8 : 4, compact: section != "stocks", titled: true)
          }
          Spacer(minLength: 0)
        }.frame(maxWidth: .infinity, alignment: .topLeading)
      }
      footer
    }
  }

  private var emptyLayout: some View {
    VStack(alignment: .leading, spacing: 8) {
      header
      if !isSmall { rule }
      Text(emptyMessage).font(.system(size: 11, weight: .medium)).foregroundColor(Palette.cream.opacity(0.7))
        .lineLimit(3).fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
      footer
    }
  }

  @ViewBuilder private var homeScreen: some View {
    if hero == nil {
      emptyLayout
    } else if isSmall {
      smallLayout
    } else if isExtraLarge {
      extraLargeLayout
    } else if isLarge {
      largeLayout
    } else {
      mediumLayout
    }
  }

  // MARK: Lock Screen

  @ViewBuilder private var lockScreen: some View {
    switch accessory {
    case .circular?: circular
    case .inline?: inline
    default: rectangular
    }
  }

  @ViewBuilder private var circular: some View {
    if #available(iOSApplicationExtension 16.0, *) {
      if section == "election", let share = data?.electionStats?.myVotePct, share.isFinite {
        Gauge(value: min(max(share, 0), 100), in: 0...100) {
          Text("VOTE")
        } currentValueLabel: {
          Text(Format.number(share)).privacySensitive()
        }.gaugeStyle(.accessoryCircular)
      } else if let actions = data?.actions, let cap = data?.actionCap, cap > 0, data?.isImperial != true {
        Gauge(value: min(max(actions, 0), cap), in: 0...cap) {
          Text("ACT")
        } currentValueLabel: {
          Text(Format.number(actions)).privacySensitive()
        }.gaugeStyle(.accessoryCircular)
      } else {
        ZStack {
          AccessoryWidgetBackground()
          Text("AHD").font(.system(size: 12, weight: .bold, design: .serif))
        }
      }
    }
  }

  private var inline: some View {
    Group {
      if section == "election", let hero = hero {
        Text("\(hero.label) \(hero.value)" + (hero.change.map { " \($0)" } ?? "")).privacySensitive()
      } else if let next = data?.nextTurn, next > entry.date, data?.turn?.active != false {
        Text("Next turn ") + Text(next, style: .timer)
      } else if let inbox = inboxText {
        Text("Inbox: \(inbox)").privacySensitive()
      } else {
        Text("A House Divided")
      }
    }
  }

  /// The first standing figure with its change, for the Lock Screen.
  private var lockFigure: String? {
    guard section == "profile", let first = figures.first else { return nil }
    return "\(first.short) \(first.value)" + (first.change.map { " \($0)" } ?? "")
  }

  private var rectangular: some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(section == "overview" || section == "profile" ? "A House Divided" : title)
        .font(.system(size: 13, weight: .semibold)).lineLimit(1)
      if let hero = hero {
        Text("\(hero.label) \(hero.value)" + (hero.change.map { " \($0)" } ?? ""))
          .font(.system(size: 12)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7).privacySensitive()
      } else if entry.saved == nil {
        Text("Open the app to sign in").font(.system(size: 12)).lineLimit(1)
      }
      if let line = lockFigure {
        Text(line).font(.system(size: 12)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7).privacySensitive()
      } else if data?.turn != nil {
        turnClock.font(.system(size: 12)).lineLimit(1)
      } else if let inbox = inboxText {
        Text("Inbox: \(inbox)").font(.system(size: 12)).lineLimit(1).privacySensitive()
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }

  private var backdrop: some View {
    ZStack {
      LinearGradient(colors: [Palette.navy, Palette.ink], startPoint: .topLeading, endPoint: .bottomTrailing)
      RadialGradient(colors: [accent.opacity(0.16), .clear], center: .topLeading, startRadius: 0, endRadius: 180)
    }
  }

  /// Lock Screen widgets use the system's tinted material, not the card.
  @ViewBuilder private var lockScreenWidget: some View {
    if #available(iOSApplicationExtension 17.0, *) {
      lockScreen.widgetURL(link).containerBackground(for: .widget) { Color.clear }
    } else {
      lockScreen.widgetURL(link)
    }
  }

  @ViewBuilder private var homeScreenWidget: some View {
    // On iOS 17+ the backdrop is the container background, so it fills the
    // whole rounded widget and the system margins inset only the content.
    if #available(iOSApplicationExtension 17.0, *) {
      homeScreen
        .privacySensitive()
        .widgetURL(link)
        .containerBackground(for: .widget) { backdrop }
    } else {
      homeScreen
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(backdrop)
        .privacySensitive()
        .widgetURL(link)
    }
  }

  var body: some View {
    if accessory != nil {
      lockScreenWidget
    } else {
      homeScreenWidget
    }
  }
}

/// Home Screen sizes plus the Lock Screen sizes on iOS 16 and later.
private func families(_ home: [WidgetFamily], circular: Bool = false, inline: Bool = false) -> [WidgetFamily] {
  var result = home
  if #available(iOSApplicationExtension 16.0, *) {
    if circular { result.append(.accessoryCircular) }
    result.append(.accessoryRectangular)
    if inline { result.append(.accessoryInline) }
  }
  return result
}

struct AHDOverviewWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "AHDOverview", provider: BriefingProvider()) { BriefingWidgetView(entry: $0, section: "overview") }
      .configurationDisplayName("AHD Overview").description("Next turn countdown, actions, inbox and mail, funds, influence and favorability with their change per turn, and the latest turn's changes.")
      .supportedFamilies(families([.systemMedium, .systemLarge, .systemExtraLarge], inline: true))
  }
}
struct AHDProfileWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "AHDProfile", provider: BriefingProvider()) { BriefingWidgetView(entry: $0, section: "profile") }
      .configurationDisplayName("AHD Profile").description("Actions, campaign funds, cash, state and national influence and favorability, each with its change per turn.")
      .supportedFamilies(families([.systemSmall, .systemMedium, .systemLarge], circular: true, inline: true))
  }
}
struct AHDElectionWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "AHDElection", provider: BriefingProvider()) { BriefingWidgetView(entry: $0, section: "election") }
      .configurationDisplayName("AHD Election").description("Vote share with its change per turn and trend chart, margin, projected seats and when polls close.")
      .supportedFamilies(families([.systemSmall, .systemMedium, .systemLarge], circular: true, inline: true))
  }
}
struct AHDCorporationWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "AHDCorporation", provider: BriefingProvider()) { BriefingWidgetView(entry: $0, section: "corporation") }
      .configurationDisplayName("AHD Corporation").description("Share price with its change per turn and trend chart, market cap, liquid capital and marketing.")
      .supportedFamilies(families([.systemSmall, .systemMedium, .systemLarge]))
  }
}
struct AHDStocksWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "AHDStocks", provider: BriefingProvider()) { BriefingWidgetView(entry: $0, section: "stocks") }
      .configurationDisplayName("AHD Stocks").description("Quotes and holding values for the companies you own shares in.")
      .supportedFamilies(families([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge]))
  }
}

@main
struct AHDWidgets: WidgetBundle {
  var body: some Widget {
    AHDOverviewWidget(); AHDProfileWidget(); AHDElectionWidget(); AHDCorporationWidget(); AHDStocksWidget()
  }
}
