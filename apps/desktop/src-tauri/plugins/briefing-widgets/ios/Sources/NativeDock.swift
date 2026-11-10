import Combine
import SwiftUI
import UIKit

// The dock: one rounded, slightly translucent surface along the bottom of the
// screen that carries the tab row and, above it, a slim status strip (turn
// clock, funds, actions). Drag it up, or tap the strip, and a panel grows out
// of the same surface with the full status; a sheet tab grows its sheet the
// same way. NativeNavController hosts it over the webview and feeds it.
//
// This file: the look, the figures, the spring and the UIKit shell.
// NativeDockLayout.swift: what the game says the tabs are.
// NativeDockModel.swift: tabs, panels and the model the views read.
// NativeDockView.swift and NativeDockStatus.swift: the views.

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
  /// A phone on its side: wide enough for the status and five icon tabs on one row.
  static let compactMaxWidth: CGFloat = 760
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

// MARK: - UIKit side

/// Fills the host above the webview but only answers touches where the dock
/// is: its slot at the bottom, or everything while the sheet is open or moving.
final class DockContainerView: UIView {
  weak var model: DockModel?

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard let model, !model.keyboardUp else { return nil }
    let open = model.expanded || model.progress > 0.001
    guard open || point.y >= bounds.height - model.slotHeight else { return nil }
    let hit = super.hitTest(point, with: event)
    return hit === self ? nil : hit
  }
}

/// Screenshot mode. Launch with `-AHDDockPreview [state]` and the dock shows
/// canned figures and a canned game layout over whatever the app opened on,
/// with no account and no network. States: collapsed (default), expanded,
/// sheet (the State sheet), more (the More sheet), signedout (app tabs only),
/// briefing (signed out fallback on the Briefing tab), offline (the
/// "cannot reach the game" screen).
enum NativeDockPreview {
  static let states: Set<String> = ["collapsed", "expanded", "sheet", "more", "signedout", "briefing", "offline", "alerts"]

  static func requestedState(_ arguments: [String] = ProcessInfo.processInfo.arguments) -> String? {
    guard let index = arguments.firstIndex(of: "-AHDDockPreview") else { return nil }
    let next = arguments.index(after: index)
    if next < arguments.endIndex, states.contains(arguments[next].lowercased()) { return arguments[next].lowercased() }
    return "collapsed"
  }

  /// A stand-in game page so the strip states are photographed over a game
  /// page and not over the launcher the app opened on.
  static let standInPage: String = {
    var rows = ""
    for index in 1...30 {
      rows += "<div class='row'><b>Senate bill \(index)</b><span>Vote closes in \(index) turns</span></div>"
    }
    return """
      <meta name='viewport' content='width=device-width, initial-scale=1'>
      <style>
        body { margin: 0; background: #1b1b26; color: #e8e8ee; font: 16px -apple-system; }
        h1 { margin: 0; padding: 70px 16px 12px; background: #23233a; }
        .row { display: flex; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid #2c2c3c; }
        span { color: #9a9ab0; }
      </style>
      <h1>Stand-in game page</h1>\(rows)
      """
  }()
}
