import Combine
import SwiftUI
import UIKit

// The dock: one rounded, slightly translucent surface along the bottom of the
// screen that carries the tab row and, above it, a slim status strip (turn
// clock, funds, actions). Drag it up, or tap the strip, and a sheet grows out
// of the same surface with the full status. NativeNavController hosts it over
// the webview and feeds it; this file is only the model and the views.

// MARK: - Look

enum DockStyle {
  static let base = Color(red: 0x14 / 255, green: 0x14 / 255, blue: 0x1c / 255)
  static let accent = Color(red: 0xdc / 255, green: 0x26 / 255, blue: 0x26 / 255)
  static let text = Color.white.opacity(0.92)
  static let muted = Color.white.opacity(0.62)
  static let hairline = Color.white.opacity(0.09)
  static let up = Color(red: 0x4a / 255, green: 0xde / 255, blue: 0x80 / 255)
  static let down = Color(red: 0xf8 / 255, green: 0x71 / 255, blue: 0x71 / 255)
  static let radius: CGFloat = 26
  /// iPad and landscape: the dock stays a dock, centered, not a full-width bar.
  static let maxWidth: CGFloat = 560
  /// Space between the page and the dock surface.
  static let pageGap: CGFloat = 6
}

// MARK: - Figures

enum DockFormat {
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

  private static func text(_ value: Double, digits: Int) -> String {
    formatters[digits]?.string(from: NSNumber(value: value)) ?? String(value)
  }

  /// 1.2K, 3.4M, 5.6B. Same shape as the widgets so the two never disagree.
  static func compact(_ value: Double) -> String {
    guard value.isFinite else { return "n/a" }
    let units: [(Double, String)] = [(1e9, "B"), (1e6, "M"), (1e4, "K")]
    for (threshold, symbol) in units where abs(value) >= threshold {
      let divisor = symbol == "K" ? 1000 : threshold
      return text(value / divisor, digits: 1) + symbol
    }
    return text(value, digits: abs(value) < 10 ? 2 : 1)
  }

  /// A per-turn change, or nil when it is unknown or rounds to nothing.
  static func change(_ value: Double?) -> String? {
    guard let value = value, value.isFinite, abs(value) >= 0.005 else { return nil }
    return (value > 0 ? "+" : "") + compact(value)
  }

  /// "1.2 million", for VoiceOver.
  static func spoken(_ value: Double) -> String {
    guard value.isFinite else { return "unknown" }
    let units: [(Double, String)] = [(1e9, "billion"), (1e6, "million"), (1e3, "thousand")]
    for (threshold, word) in units where abs(value) >= threshold {
      return text(value / threshold, digits: 1) + " " + word
    }
    return text(value, digits: abs(value) < 10 ? 2 : 1)
  }

  static func spokenChange(_ value: Double?) -> String? {
    guard let value = value, value.isFinite, abs(value) >= 0.005 else { return nil }
    return (value > 0 ? "up " : "down ") + spoken(abs(value)) + " per turn"
  }

  /// H:MM:SS, M:SS under an hour, or "Due now" once the time has passed.
  static func countdown(to date: Date, now: Date) -> String {
    let seconds = Int(date.timeIntervalSince(now).rounded(.down))
    guard seconds > 0 else { return "Due now" }
    let hours = seconds / 3600
    let minutes = (seconds % 3600) / 60
    let rest = seconds % 60
    if hours >= 24 { return "\(hours / 24)d \(hours % 24)h" }
    if hours > 0 { return String(format: "%d:%02d:%02d", hours, minutes, rest) }
    return String(format: "%d:%02d", minutes, rest)
  }

  /// Whole minutes, so VoiceOver does not chatter every second.
  static func spokenCountdown(to date: Date, now: Date) -> String {
    let minutes = Int((date.timeIntervalSince(now) / 60).rounded(.up))
    guard minutes > 0 else { return "due now" }
    if minutes >= 120 { return "in \(minutes / 60) hours" }
    if minutes >= 60 { return "in 1 hour \(minutes % 60) minutes" }
    return minutes == 1 ? "in 1 minute" : "in \(minutes) minutes"
  }

  static func clock(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.setLocalizedDateFormatFromTemplate("EEEjmm")
    return formatter.string(from: date)
  }

  static func money(_ value: Double, code: String?) -> String {
    compact(value) + (code.map { " " + $0 } ?? "")
  }
}

/// What the dock shows, copied out of the briefing snapshot. Only these
/// fields leave BriefingStore; the strip needs no more than the widgets do.
struct DockStatus: Equatable {
  var funds: Double?
  var fundsPerTurn: Double?
  var currency: String?
  var actions: Double?
  var actionCap: Double?
  var corpName: String?
  var corpID: Int?
  var corpCash: Double?
  var corpCurrency: String?
  var corpCashPerTurn: Double?
  var influence: Double?
  var influencePerTurn: Double?
  var nationalInfluence: Double?
  var nationalPerTurn: Double?
  var turn: Int?
  var nextTurn: Date?
  var alerts = 0
  var mail = 0
  var hasInbox = false
  /// A signed-in player with a character. Anything else shows no strip.
  var showable = false

  init() {}

  init(_ data: BriefingStatus) {
    showable = data.name != nil && data.status != "no-character"
    funds = data.funds
    fundsPerTurn = data.perTurn?.funds
    currency = data.homeCurrency
    actions = data.actions
    actionCap = data.actionCap
    corpName = data.corpNav?.name
    corpID = data.corpNav?.sequentialId
    corpCash = data.corpNav?.liquidCapital
    corpCurrency = data.corpNav?.liquidCurrencyCode
    corpCashPerTurn = data.perTurn?.liquidCapital
    influence = data.politicalInfluence
    influencePerTurn = data.perTurn?.politicalInfluence
    nationalInfluence = data.nationalInfluence
    nationalPerTurn = data.perTurn?.nationalInfluence
    if let current = data.turn?.current, current.isFinite { turn = Int(current) }
    // A paused game has no next turn to count to.
    nextTurn = data.turn?.active == false ? nil : data.nextTurn
    if let inbox = data.inbox {
      hasInbox = true
      alerts = Int(inbox.unread)
      mail = Int(inbox.mail)
    }
  }

  static func sample(now: Date = Date()) -> DockStatus {
    var status = DockStatus()
    status.showable = true
    status.funds = 1_240_000
    status.fundsPerTurn = 38_500
    status.currency = "USD"
    status.actions = 12
    status.actionCap = 20
    status.corpName = "Hale Industrial"
    status.corpID = 7
    status.corpCash = 8_900_000
    status.corpCurrency = "USD"
    status.corpCashPerTurn = -120_000
    status.influence = 46.5
    status.influencePerTurn = 1.2
    status.nationalInfluence = 12.4
    status.nationalPerTurn = 0.3
    status.turn = 412
    status.nextTurn = now.addingTimeInterval(2 * 3600 + 14 * 60 + 5)
    status.alerts = 3
    status.mail = 1
    status.hasInbox = true
    return status
  }
}

// MARK: - Motion

/// The expand/collapse value (0 closed, 1 open) as a real spring, not a
/// SwiftUI animation: a drag can grab it mid-flight and a flick hands its
/// speed to the spring, so the sheet is interruptible and follows the finger.
final class DockSpring: NSObject {
  private(set) var value: CGFloat = 0
  private var velocity: CGFloat = 0
  private var target: CGFloat = 0
  private var link: CADisplayLink?
  private var lastTime: CFTimeInterval = 0
  var onChange: ((CGFloat) -> Void)?
  /// Damping ratio about 0.85: one soft overshoot, then rest.
  private let stiffness: CGFloat = 220
  private let damping: CGFloat = 25

  /// Take the value into the caller's hands (a drag in progress, or a jump).
  func hold(at newValue: CGFloat) {
    stop()
    velocity = 0
    value = newValue
    target = newValue
    onChange?(value)
  }

  /// Let go toward `newTarget` carrying `velocity` (progress per second).
  func run(to newTarget: CGFloat, velocity initial: CGFloat) {
    target = newTarget
    velocity = initial
    guard link == nil else { return }
    lastTime = 0
    let display = CADisplayLink(target: self, selector: #selector(step(_:)))
    display.add(to: .main, forMode: .common)
    link = display
  }

  @objc private func step(_ display: CADisplayLink) {
    let now = display.timestamp
    let frame = lastTime == 0 ? 1.0 / 60.0 : min(now - lastTime, 1.0 / 20.0)
    lastTime = now
    var remaining = CGFloat(frame)
    let slice: CGFloat = 1.0 / 240.0
    while remaining > 0 {
      let dt = min(slice, remaining)
      remaining -= dt
      velocity += (-stiffness * (value - target) - damping * velocity) * dt
      value += velocity * dt
    }
    if abs(value - target) < 0.0008 && abs(velocity) < 0.02 {
      value = target
      velocity = 0
      stop()
    }
    onChange?(value)
  }

  func stop() {
    link?.invalidate()
    link = nil
  }

  deinit { link?.invalidate() }
}

// MARK: - Model

final class DockModel: ObservableObject {
  typealias Tab = NativeNavController.Destination

  @Published var selected: Tab?
  /// Unread inbox count for the tab badge; zero hides it.
  @Published var badge = 0
  @Published var status: DockStatus? { didSet { stripMayHaveChanged() } }
  /// The page is a game page that carried the web status footer.
  @Published var onStripPage = false { didSet { stripMayHaveChanged() } }
  @Published private(set) var progress: CGFloat = 0
  @Published private(set) var expanded = false
  @Published var reduceMotion = UIAccessibility.isReduceMotionEnabled
  /// Height the webview must leave free at the bottom of the screen.
  @Published private(set) var slotHeight: CGFloat = 96

  var baseHeight: CGFloat = 0 { didSet { updateSlot() } }
  var bottomPad: CGFloat = 8 { didSet { updateSlot() } }
  var onSelect: (Tab) -> Void = { _ in }
  var onOpenPath: (String) -> Void = { _ in }
  let spring = DockSpring()

  init() {
    spring.onChange = { [weak self] value in self?.progress = value }
  }

  var showsStrip: Bool { onStripPage && status?.showable == true }

  private func updateSlot() {
    guard baseHeight > 0 else { return }
    let height = baseHeight + bottomPad + DockStyle.pageGap
    if abs(height - slotHeight) > 0.5 { slotHeight = height }
  }

  private func stripMayHaveChanged() {
    if !showsStrip && (expanded || progress > 0) { setExpanded(false, animated: false) }
  }

  func toggle() { setExpanded(!expanded) }

  func setExpanded(_ on: Bool, velocity: CGFloat = 0, animated: Bool = true) {
    let open = on && showsStrip
    expanded = open
    let target: CGFloat = open ? 1 : 0
    if animated && !reduceMotion {
      spring.run(to: target, velocity: velocity)
    } else {
      spring.hold(at: target)
    }
  }

  func openPath(_ path: String) {
    setExpanded(false)
    onOpenPath(path)
  }
}

// MARK: - Views

private struct DockBaseHeightKey: PreferenceKey {
  static var defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

private struct DockSheetHeightKey: PreferenceKey {
  static var defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

struct DockView: View {
  @ObservedObject var model: DockModel
  @State private var sheetNatural: CGFloat = 0
  @State private var dragStart: CGFloat?
  @Namespace private var pill

  private var motion: Animation {
    model.reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.38, dampingFraction: 0.78)
  }

  var body: some View {
    GeometryReader { geo in
      let pad = max(geo.safeAreaInsets.bottom - 8, 8)
      let cap = max(0, geo.size.height * 0.62)
      let extent = min(sheetNatural, cap)
      let progress = min(max(model.progress, 0), 1.03)
      ZStack(alignment: .bottom) {
        scrim(progress)
        surface(extent: extent, progress: progress, scrollable: sheetNatural > cap + 0.5)
          .frame(maxWidth: DockStyle.maxWidth)
          .padding(.horizontal, 10)
          .padding(.bottom, pad)
      }
      .frame(width: geo.size.width, height: geo.size.height, alignment: .bottom)
      .onAppear { model.bottomPad = pad }
      .onChange(of: pad) { model.bottomPad = $0 }
    }
    .ignoresSafeArea()
    .environment(\.colorScheme, .dark)
    .onPreferenceChange(DockBaseHeightKey.self) { height in
      DispatchQueue.main.async { model.baseHeight = height }
    }
    .onPreferenceChange(DockSheetHeightKey.self) { height in sheetNatural = height }
  }

  // MARK: Surface

  private func surface(extent: CGFloat, progress: CGFloat, scrollable: Bool) -> some View {
    VStack(spacing: 0) {
      if model.showsStrip { sheet(extent: extent, progress: progress, scrollable: scrollable) }
      VStack(spacing: 0) {
        if model.showsStrip { strip(progress: progress) }
        tabRow
      }
      .background(
        GeometryReader { proxy in Color.clear.preference(key: DockBaseHeightKey.self, value: proxy.size.height) }
      )
      .background(measuringSheet, alignment: .top)
    }
    .background(surfaceBackground)
    .clipShape(RoundedRectangle(cornerRadius: DockStyle.radius, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: DockStyle.radius, style: .continuous).stroke(DockStyle.hairline, lineWidth: 1))
    .shadow(color: Color.black.opacity(0.35), radius: 16, x: 0, y: 6)
    .simultaneousGesture(dragGesture(extent: extent), including: scrollable ? .subviews : .all)
  }

  private var surfaceBackground: some View {
    RoundedRectangle(cornerRadius: DockStyle.radius, style: .continuous)
      .fill(DockStyle.base.opacity(0.80))
      .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: DockStyle.radius, style: .continuous))
  }

  private func scrim(_ progress: CGFloat) -> some View {
    let level = model.reduceMotion ? (model.expanded ? 0.42 : 0) : 0.42 * Double(min(progress, 1))
    return Color.black.opacity(level)
      .animation(model.reduceMotion ? Animation.easeInOut(duration: 0.2) : nil, value: model.expanded)
      .contentShape(Rectangle())
      .onTapGesture { model.setExpanded(false) }
      .gesture(
        DragGesture(minimumDistance: 10).onEnded { value in
          if value.translation.height > 20 { model.setExpanded(false) }
        }
      )
      .allowsHitTesting(progress > 0.001 || model.expanded)
      .accessibilityLabel(Text("Close status"))
      .accessibilityAddTraits(.isButton)
      .accessibilityHidden(!model.expanded)
      .ignoresSafeArea()
  }

  // MARK: Drag

  private func dragGesture(extent: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 6, coordinateSpace: .global)
      .onChanged { value in
        guard model.showsStrip, extent > 1 else { return }
        if dragStart == nil { dragStart = model.spring.value }
        let start = dragStart ?? 0
        model.spring.hold(at: min(max(start - value.translation.height / extent, 0), 1))
      }
      .onEnded { value in
        guard let start = dragStart else { return }
        dragStart = nil
        guard extent > 1 else { return }
        // Where the flick would come to rest, and how fast it was going.
        let rest = value.predictedEndTranslation.height
        let projected = start - rest / extent
        let velocity = -(rest - value.translation.height) / extent / 0.5
        model.setExpanded(projected > 0.5, velocity: velocity)
      }
  }

  // MARK: Sheet

  private func sheet(extent: CGFloat, progress: CGFloat, scrollable: Bool) -> some View {
    Group {
      if scrollable {
        ScrollView(.vertical, showsIndicators: false) { sheetContent }
      } else {
        sheetContent
      }
    }
    .opacity(model.reduceMotion ? (model.expanded ? 1 : 0) : Double(min(1, progress * 1.6)))
    .animation(model.reduceMotion ? Animation.easeInOut(duration: 0.2) : nil, value: model.expanded)
    .frame(height: model.reduceMotion ? (model.expanded ? extent : 0) : extent * progress, alignment: .top)
    .clipped()
    .accessibilityHidden(!model.expanded)
    .accessibilityAction(.escape) { model.setExpanded(false) }
  }

  /// An invisible copy at natural height, so the sheet knows how far to grow.
  private var measuringSheet: some View {
    Group {
      if model.showsStrip {
        sheetContent
          .fixedSize(horizontal: false, vertical: true)
          .background(
            GeometryReader { proxy in Color.clear.preference(key: DockSheetHeightKey.self, value: proxy.size.height) }
          )
          .opacity(0)
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
    }
  }

  private var sheetContent: some View {
    VStack(spacing: 0) {
      if let status = model.status {
        let list = rows(for: status)
        ForEach(list) { row in
          DockRowView(row: row) { path in model.openPath(path) }
          if row.id != list.last?.id {
            Rectangle().fill(DockStyle.hairline).frame(height: 1).padding(.leading, 56)
          }
        }
      }
    }
    .padding(.top, 8)
    .padding(.bottom, 2)
  }

  private func rows(for status: DockStatus) -> [DockRow] {
    var list = [DockRow]()
    let rate = " per turn"
    if let funds = status.funds {
      list.append(DockRow(id: "funds", icon: "dollarsign.circle", title: "Funds",
        value: DockFormat.money(funds, code: status.currency), detail: DockFormat.change(status.fundsPerTurn).map { $0 + rate },
        tone: tone(status.fundsPerTurn), spoken: DockFormat.spoken(funds) + " " + (status.currency ?? ""),
        spokenDetail: DockFormat.spokenChange(status.fundsPerTurn), path: "/portfolio"))
    }
    if let actions = status.actions {
      let cap = status.actionCap.map { " of " + String(Int($0)) } ?? ""
      list.append(DockRow(id: "actions", icon: "bolt.fill", title: "Actions", value: String(Int(actions)) + cap, detail: nil,
        tone: .none, spoken: String(Int(actions)) + cap, spokenDetail: nil, path: "/actions"))
    }
    if let cash = status.corpCash, let id = status.corpID {
      list.append(DockRow(id: "corp", icon: "building.2", title: status.corpName.map { "Cash at " + $0 } ?? "Corporation cash",
        value: DockFormat.money(cash, code: status.corpCurrency), detail: DockFormat.change(status.corpCashPerTurn).map { $0 + rate },
        tone: tone(status.corpCashPerTurn), spoken: DockFormat.spoken(cash) + " " + (status.corpCurrency ?? ""),
        spokenDetail: DockFormat.spokenChange(status.corpCashPerTurn), path: "/corporation/\(id)"))
    }
    if let influence = status.influence {
      list.append(DockRow(id: "influence", icon: "star.circle", title: "Influence", value: DockFormat.compact(influence),
        detail: DockFormat.change(status.influencePerTurn).map { $0 + rate }, tone: tone(status.influencePerTurn),
        spoken: DockFormat.spoken(influence), spokenDetail: DockFormat.spokenChange(status.influencePerTurn), path: "/profile"))
    }
    if let national = status.nationalInfluence {
      list.append(DockRow(id: "national", icon: "flag", title: "National influence", value: DockFormat.compact(national),
        detail: DockFormat.change(status.nationalPerTurn).map { $0 + rate }, tone: tone(status.nationalPerTurn),
        spoken: DockFormat.spoken(national), spokenDetail: DockFormat.spokenChange(status.nationalPerTurn), path: "/profile"))
    }
    if let next = status.nextTurn {
      list.append(DockRow(id: "turn", icon: "clock", title: "Next turn", value: DockFormat.clock(next),
        detail: status.turn.map { "Turn \($0)" }, tone: .none, spoken: DockFormat.clock(next),
        spokenDetail: status.turn.map { "turn \($0)" }, path: nil))
    }
    if status.hasInbox {
      if status.alerts > 0 {
        list.append(DockRow(id: "alerts", icon: "tray", title: "Unread alerts", value: String(status.alerts), detail: nil,
          tone: .none, spoken: String(status.alerts), spokenDetail: nil, path: "/notifications"))
      }
      if status.mail > 0 {
        list.append(DockRow(id: "mail", icon: "envelope", title: "Unread mail", value: String(status.mail), detail: nil,
          tone: .none, spoken: String(status.mail), spokenDetail: nil, path: "/notifications"))
      }
      if status.alerts == 0 && status.mail == 0 {
        list.append(DockRow(id: "inbox", icon: "tray", title: "Inbox", value: "All read", detail: nil,
          tone: .none, spoken: "all read", spokenDetail: nil, path: "/notifications"))
      }
    }
    return list
  }

  private func tone(_ value: Double?) -> DockRow.Tone {
    guard let value = value, value.isFinite, abs(value) >= 0.005 else { return .none }
    return value > 0 ? .up : .down
  }

  // MARK: Strip

  private func strip(progress: CGFloat) -> some View {
    VStack(spacing: 0) {
      Button { model.toggle() } label: {
        VStack(spacing: 0) {
          Capsule().fill(Color.white.opacity(0.22)).frame(width: 34, height: 4).padding(.top, 6)
          TimelineView(.periodic(from: Date(), by: 1)) { context in
            DockStripContent(status: model.status ?? DockStatus(), now: context.date, progress: progress, reduce: model.reduceMotion)
          }
          .padding(.horizontal, 16)
          .frame(minHeight: 36)
        }
        .frame(maxWidth: .infinity, minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(DockPressStyle(scale: 0.99))
      .accessibilityIdentifier("ahdclient-dock-status")
      .accessibilityLabel(Text(stripLabel()))
      .accessibilityValue(Text(model.expanded ? "Expanded" : "Collapsed"))
      .accessibilityHint(Text(model.expanded ? "Hides the full status" : "Shows the full status"))
      .accessibilityAddTraits(.updatesFrequently)
      Rectangle().fill(DockStyle.hairline).frame(height: 1)
    }
  }

  private func stripLabel() -> String {
    guard let status = model.status else { return "Status" }
    var parts = ["Status"]
    if let next = status.nextTurn { parts.append("Next turn " + DockFormat.spokenCountdown(to: next, now: Date())) }
    if let funds = status.funds { parts.append("Funds " + DockFormat.spoken(funds)) }
    if let actions = status.actions {
      parts.append(String(Int(actions)) + (status.actionCap.map { " of " + String(Int($0)) } ?? "") + " actions")
    }
    return parts.joined(separator: ". ")
  }

  // MARK: Tabs

  private var tabRow: some View {
    HStack(spacing: 0) {
      ForEach(Tab.allCases, id: \.self) { tab in
        DockTabButton(tab: tab, selected: model.selected == tab, badge: tab == .inbox ? model.badge : 0,
          reduce: model.reduceMotion, namespace: pill) { model.onSelect(tab) }
      }
    }
    .padding(.horizontal, 4)
    .padding(.top, 2)
    .padding(.bottom, 4)
    // Like the system tab bar, the row stops growing past the largest
    // standard text size; the strip and the sheet keep scaling.
    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    .animation(motion, value: model.selected)
  }

  private typealias Tab = NativeNavController.Destination
}

// MARK: - Strip and rows

private struct DockStripContent: View {
  let status: DockStatus
  let now: Date
  let progress: CGFloat
  let reduce: Bool
  @Environment(\.sizeCategory) private var sizeCategory

  var body: some View {
    Group {
      if sizeCategory.isAccessibilityCategory {
        VStack(alignment: .leading, spacing: 4) { chips }
      } else {
        HStack(spacing: 12) {
          chips
          Spacer(minLength: 0)
        }
      }
    }
    .padding(.trailing, 20)
    .overlay(
      Image(systemName: "chevron.up")
        .font(.system(size: 11, weight: .bold))
        .foregroundColor(DockStyle.muted)
        .rotationEffect(.degrees(Double(min(max(progress, 0), 1)) * 180))
        .accessibilityHidden(true),
      alignment: .trailing
    )
  }

  @ViewBuilder private var chips: some View {
    if let next = status.nextTurn {
      DockChip(icon: "clock") {
        Text(DockFormat.countdown(to: next, now: now))
          .font(.system(.footnote, design: .rounded).weight(.semibold).monospacedDigit())
          .foregroundColor(DockStyle.text)
      }
    }
    if let funds = status.funds {
      DockChip(icon: "dollarsign.circle") {
        HStack(spacing: 4) {
          DockRollingText(text: DockFormat.compact(funds), reduce: reduce)
            .font(.system(.footnote, design: .rounded).weight(.semibold).monospacedDigit())
            .foregroundColor(DockStyle.text)
          if let change = DockFormat.change(status.fundsPerTurn) {
            DockRollingText(text: change, reduce: reduce)
              .font(.system(.caption2, design: .rounded).weight(.medium).monospacedDigit())
              .foregroundColor((status.fundsPerTurn ?? 0) >= 0 ? DockStyle.up : DockStyle.down)
          }
        }
      }
    }
    if let actions = status.actions {
      DockChip(icon: "bolt.fill") {
        DockRollingText(text: String(Int(actions)) + (status.actionCap.map { "/" + String(Int($0)) } ?? ""), reduce: reduce)
          .font(.system(.footnote, design: .rounded).weight(.semibold).monospacedDigit())
          .foregroundColor(DockStyle.text)
      }
    }
  }
}

private struct DockChip<Content: View>: View {
  let icon: String
  let content: Content

  init(icon: String, @ViewBuilder content: () -> Content) {
    self.icon = icon
    self.content = content()
  }

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: icon)
        .font(.system(size: 11, weight: .semibold))
        .foregroundColor(DockStyle.muted)
        .accessibilityHidden(true)
      content
    }
    .lineLimit(1)
    .minimumScaleFactor(0.7)
  }
}

/// A figure that rolls to its new value: the old one slides up and out, the
/// new one in from below. Reduce Motion gets a plain crossfade.
private struct DockRollingText: View {
  let text: String
  let reduce: Bool

  var body: some View {
    ZStack {
      Text(text)
        .id(text)
        .transition(
          reduce ? AnyTransition.opacity
            : AnyTransition.asymmetric(
              insertion: AnyTransition.move(edge: .bottom).combined(with: .opacity),
              removal: AnyTransition.move(edge: .top).combined(with: .opacity))
        )
    }
    .clipped()
    .animation(reduce ? .easeInOut(duration: 0.2) : .spring(response: 0.42, dampingFraction: 0.86), value: text)
  }
}

struct DockRow: Identifiable {
  enum Tone { case none, up, down }
  let id: String
  let icon: String
  let title: String
  let value: String
  let detail: String?
  let tone: Tone
  let spoken: String
  let spokenDetail: String?
  let path: String?
}

private struct DockRowView: View {
  let row: DockRow
  let open: (String) -> Void

  var body: some View {
    if let path = row.path {
      Button { open(path) } label: { content(showsArrow: true) }
        .buttonStyle(DockPressStyle(scale: 0.99))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(spokenLabel))
        .accessibilityHint(Text("Opens the page"))
        .accessibilityAddTraits(.isButton)
    } else {
      content(showsArrow: false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(spokenLabel))
    }
  }

  private var spokenLabel: String {
    [row.title, row.spoken, row.spokenDetail].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
  }

  private func content(showsArrow: Bool) -> some View {
    HStack(spacing: 12) {
      Image(systemName: row.icon)
        .font(.system(size: 17, weight: .medium))
        .foregroundColor(DockStyle.muted)
        .frame(width: 28)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text(row.title).font(.footnote).foregroundColor(DockStyle.muted).lineLimit(2)
        Text(row.value)
          .font(.system(.body, design: .rounded).weight(.semibold).monospacedDigit())
          .foregroundColor(DockStyle.text)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
      }
      Spacer(minLength: 8)
      if let detail = row.detail {
        Text(detail)
          .font(.system(.footnote, design: .rounded).weight(.medium).monospacedDigit())
          .foregroundColor(row.tone == .up ? DockStyle.up : row.tone == .down ? DockStyle.down : DockStyle.muted)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
      }
      if showsArrow {
        Image(systemName: "chevron.right")
          .font(.system(size: 11, weight: .bold))
          .foregroundColor(DockStyle.muted.opacity(0.7))
          .accessibilityHidden(true)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 8)
    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
    .contentShape(Rectangle())
  }
}

// MARK: - Tabs

private struct DockTabButton: View {
  let tab: NativeNavController.Destination
  let selected: Bool
  let badge: Int
  let reduce: Bool
  let namespace: Namespace.ID
  let action: () -> Void
  @ScaledMetric(relativeTo: .caption2) private var iconSize: CGFloat = 20

  var body: some View {
    Button(action: action) {
      VStack(spacing: 3) {
        ZStack {
          if selected {
            if reduce {
              Capsule().fill(DockStyle.accent.opacity(0.18)).transition(.opacity)
            } else {
              Capsule().fill(DockStyle.accent.opacity(0.18)).matchedGeometryEffect(id: "dock-pill", in: namespace)
            }
          }
          Image(systemName: selected ? tab.selectedSymbol : tab.symbol)
            .font(.system(size: iconSize, weight: .medium))
            .foregroundColor(selected ? DockStyle.accent : DockStyle.muted)
            .scaleEffect(selected && !reduce ? 1.1 : 1)
        }
        .frame(width: 58, height: 30)
        .overlay(badgeView, alignment: .topTrailing)
        Text(tab.title)
          .font(.caption2.weight(.medium))
          .foregroundColor(selected ? DockStyle.text : DockStyle.muted)
          .lineLimit(1)
          .minimumScaleFactor(0.75)
      }
      .frame(maxWidth: .infinity, minHeight: 54)
      .contentShape(Rectangle())
    }
    .buttonStyle(DockPressStyle(scale: 0.94))
    .accessibilityIdentifier("ahdclient-tab-\(tab.title.lowercased())")
    .accessibilityLabel(Text(badge > 0 ? "\(tab.title), \(badge) unread" : tab.title))
    .accessibilityAddTraits(selected ? [.isSelected] : [])
  }

  @ViewBuilder private var badgeView: some View {
    if badge > 0 {
      Text(badge > 99 ? "99+" : String(badge))
        .font(.system(size: 11, weight: .bold))
        .foregroundColor(.white)
        .padding(.horizontal, 5)
        .frame(minWidth: 18, minHeight: 18)
        .background(Capsule().fill(DockStyle.accent))
        .offset(x: 2, y: -4)
        .accessibilityHidden(true)
    }
  }
}

private struct DockPressStyle: ButtonStyle {
  let scale: CGFloat

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? scale : 1)
      .opacity(configuration.isPressed ? 0.85 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

// MARK: - UIKit side

/// Fills the host above the webview but only answers touches where the dock
/// is: its slot at the bottom, or everything while the sheet is open or moving.
final class DockContainerView: UIView {
  weak var model: DockModel?

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard let model else { return nil }
    let open = model.expanded || model.progress > 0.001
    guard open || point.y >= bounds.height - model.slotHeight else { return nil }
    let hit = super.hitTest(point, with: event)
    return hit === self ? nil : hit
  }
}

/// Screenshot mode. Launch with `-AHDDockPreview [state]` and the dock shows
/// canned figures over whatever the app opened on, with no account and no
/// network. States: collapsed (default), expanded, signedout, briefing.
enum NativeDockPreview {
  static let states: Set<String> = ["collapsed", "expanded", "signedout", "briefing"]

  static func requestedState(_ arguments: [String] = ProcessInfo.processInfo.arguments) -> String? {
    guard let index = arguments.firstIndex(of: "-AHDDockPreview") else { return nil }
    let next = arguments.index(after: index)
    if next < arguments.endIndex, states.contains(arguments[next].lowercased()) { return arguments[next].lowercased() }
    return "collapsed"
  }
}
