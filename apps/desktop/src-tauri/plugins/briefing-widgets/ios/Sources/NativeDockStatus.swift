import SwiftUI
import UIKit

// MARK: - Strip and rows

struct DockStripContent: View {
  let status: DockStatus
  let now: Date
  let progress: CGFloat
  let reduce: Bool
  @Environment(\.sizeCategory) var sizeCategory

  var body: some View {
    Group {
      if sizeCategory.isAccessibilityCategory {
        // Large text stacks the figures; give the stack room so the last
        // line is not cut by the rule above the tab row.
        VStack(alignment: .leading, spacing: 4) { chips }
          .fixedSize(horizontal: false, vertical: true)
          .padding(.vertical, 8)
          .frame(maxWidth: .infinity, alignment: .leading)
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

struct DockChip<Content: View>: View {
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
struct DockRollingText: View {
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

struct DockRowView: View {
  let row: DockRow
  var reduce = false
  let open: (String) -> Void
  @Environment(\.sizeCategory) var sizeCategory

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
      if sizeCategory.isAccessibilityCategory {
        // Large text: one column, nothing truncated.
        VStack(alignment: .leading, spacing: 2) {
          title
          value
          detail
        }
        Spacer(minLength: 4)
      } else {
        VStack(alignment: .leading, spacing: 1) {
          title
          value.lineLimit(1).minimumScaleFactor(0.8)
        }
        Spacer(minLength: 8)
        detail.lineLimit(1).minimumScaleFactor(0.8)
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

  private var title: some View {
    Text(row.title).font(.footnote).foregroundColor(DockStyle.muted).fixedSize(horizontal: false, vertical: true)
  }

  private var value: some View {
    DockRollingText(text: row.value, reduce: reduce)
      .font(.system(.body, design: .rounded).weight(.semibold).monospacedDigit())
      .foregroundColor(DockStyle.text)
  }

  @ViewBuilder private var detail: some View {
    if let text = row.detail {
      Text(text)
        .font(.system(.footnote, design: .rounded).weight(.medium).monospacedDigit())
        .foregroundColor(row.tone == .up ? DockStyle.up : row.tone == .down ? DockStyle.down : DockStyle.muted)
    }
  }
}


// MARK: - Rows

/// The expanded status: one row per figure, each opening the matching page.
enum DockStatusRows {
  static func build(_ status: DockStatus) -> [DockRow] {
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

  private static func tone(_ value: Double?) -> DockRow.Tone {
    guard let value = value, value.isFinite, abs(value) >= 0.005 else { return .none }
    return value > 0 ? .up : .down
  }
}

struct DockPressStyle: ButtonStyle {
  let scale: CGFloat

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? scale : 1)
      .opacity(configuration.isPressed ? 0.85 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}
