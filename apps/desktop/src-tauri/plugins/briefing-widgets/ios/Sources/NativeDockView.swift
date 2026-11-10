import SwiftUI
import UIKit

// The dock's views: one rounded surface holding, from the bottom up, the tab
// row, the status strip and a panel that grows out of both. The panel is the
// full status or a tab's sheet; both share the surface so the dock reads as
// one thing that unfolds.

private struct DockBaseHeightKey: PreferenceKey {
  static var defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

private struct DockPanelHeightKey: PreferenceKey {
  static var defaultValue: [String: CGFloat] = [:]
  static func reduce(value: inout [String: CGFloat], nextValue: () -> [String: CGFloat]) {
    value.merge(nextValue()) { _, new in new }
  }
}

struct DockView: View {
  @ObservedObject var model: DockModel
  @State private var dragStart: CGFloat?
  @Namespace private var pill

  private var motion: Animation {
    model.reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.38, dampingFraction: 0.78)
  }

  var body: some View {
    GeometryReader { geo in
      // The pad is the window's home-indicator inset, set by the host; the
      // geometry's own safe area grows with the keyboard and must not be used.
      let pad = model.bottomPad
      let cap = max(0, geo.size.height * 0.62)
      let extent = min(model.natural[model.panel.key] ?? 0, cap)
      let progress = min(max(model.progress, 0), 1.03)
      ZStack(alignment: .bottom) {
        scrim(progress)
        surface(extent: extent, progress: progress, scrollable: (model.natural[model.panel.key] ?? 0) > cap + 0.5)
          .frame(maxWidth: DockStyle.maxWidth)
          .padding(.horizontal, 10)
          .padding(.bottom, pad)
          // With the keyboard up the dock steps aside, like Android's.
          .opacity(model.keyboardUp ? 0 : 1)
          .allowsHitTesting(!model.keyboardUp)
          .accessibilityHidden(model.keyboardUp)
          .animation(model.reduceMotion ? .easeInOut(duration: 0.15) : .easeOut(duration: 0.18), value: model.keyboardUp)
      }
      .frame(width: geo.size.width, height: geo.size.height, alignment: .bottom)
      .onAppear { model.setCap(cap) }
      .onChange(of: cap) { model.setCap($0) }
    }
    .ignoresSafeArea()
    .environment(\.colorScheme, .dark)
    .onPreferenceChange(DockBaseHeightKey.self) { height in
      DispatchQueue.main.async { model.baseHeight = height }
    }
    .onPreferenceChange(DockPanelHeightKey.self) { heights in
      DispatchQueue.main.async { model.measured(heights) }
    }
  }

  // MARK: Surface

  private func surface(extent: CGFloat, progress: CGFloat, scrollable: Bool) -> some View {
    VStack(spacing: 0) {
      panelView(extent: extent, progress: progress, scrollable: scrollable)
      VStack(spacing: 0) {
        if model.showsStrip { strip(progress: progress) }
        tabRow
      }
      .background(
        GeometryReader { proxy in Color.clear.preference(key: DockBaseHeightKey.self, value: proxy.size.height) }
      )
      .background(measuring, alignment: .top)
      .contentShape(Rectangle())
      .simultaneousGesture(dragGesture)
    }
    .background(surfaceBackground)
    .clipShape(RoundedRectangle(cornerRadius: DockStyle.radius, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: DockStyle.radius, style: .continuous).stroke(DockStyle.hairline, lineWidth: 1))
    .shadow(color: Color.black.opacity(0.35), radius: 16, x: 0, y: 6)
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
      .onTapGesture { model.close() }
      .gesture(
        DragGesture(minimumDistance: 10).onEnded { value in
          if value.translation.height > 20 { model.close() }
        }
      )
      .allowsHitTesting(progress > 0.001 || model.expanded)
      .accessibilityLabel(Text("Close"))
      .accessibilityAddTraits(.isButton)
      .accessibilityHidden(!model.expanded)
      .ignoresSafeArea()
  }

  // MARK: Drag

  /// Drag the dock up to open the status, drag an open panel down to close it.
  /// It rides on the strip, the tab row and any panel short enough not to
  /// scroll, so a long sheet keeps its own scrolling.
  private var dragGesture: some Gesture {
    DragGesture(minimumDistance: 6, coordinateSpace: .global)
      .onChanged { value in
        if dragStart == nil {
          guard model.beginDrag() else { return }
          dragStart = model.spring.value
        }
        let extent = model.currentExtent
        guard extent > 1 else { return }
        let start = dragStart ?? 0
        model.spring.hold(at: min(max(start - value.translation.height / extent, 0), 1))
      }
      .onEnded { value in
        guard let start = dragStart else { return }
        dragStart = nil
        let extent = model.currentExtent
        guard extent > 1 else { model.close(); return }
        // Where the flick would come to rest, and how fast it was going.
        let rest = value.predictedEndTranslation.height
        let projected = start - rest / extent
        let velocity = -(rest - value.translation.height) / extent / 0.5
        model.settle(open: projected > 0.5, velocity: velocity)
      }
  }

  // MARK: Panel

  private func panelView(extent: CGFloat, progress: CGFloat, scrollable: Bool) -> some View {
    Group {
      if scrollable {
        ScrollView(.vertical, showsIndicators: false) { panelContent(model.panel) }
      } else {
        panelContent(model.panel).simultaneousGesture(dragGesture)
      }
    }
    .opacity(model.reduceMotion ? (model.expanded ? 1 : 0) : Double(min(1, progress * 1.6)))
    .animation(model.reduceMotion ? Animation.easeInOut(duration: 0.2) : nil, value: model.expanded)
    .frame(height: model.reduceMotion ? (model.expanded ? extent : 0) : extent * progress, alignment: .top)
    .clipped()
    .accessibilityHidden(!model.expanded)
    .accessibilityAction(.escape) { model.close() }
  }

  /// Invisible copies at natural height, one per panel, so each knows how far
  /// to grow before it is ever shown.
  private var measuring: some View {
    ZStack(alignment: .top) {
      ForEach(measuredPanels, id: \.key) { panel in
        panelContent(panel)
          .fixedSize(horizontal: false, vertical: true)
          .background(
            GeometryReader { proxy in
              Color.clear.preference(key: DockPanelHeightKey.self, value: [panel.key: proxy.size.height])
            }
          )
          .opacity(0)
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
    }
  }

  private var measuredPanels: [DockPanel] {
    var list = [DockPanel]()
    if model.showsStrip { list.append(.status) }
    for tab in model.tabs {
      if case .sheet(let key) = tab.kind { list.append(.sheet(key)) }
    }
    return list
  }

  @ViewBuilder private func panelContent(_ panel: DockPanel) -> some View {
    switch panel {
    case .status: statusContent
    case .sheet(let key): DockSheetContent(model: model, key: key)
    }
  }

  private var statusContent: some View {
    VStack(spacing: 0) {
      if let status = model.status {
        let list = DockStatusRows.build(status)
        ForEach(list) { row in
          DockRowView(row: row, reduce: model.reduceMotion) { path in model.openPath(path) }
          if row.id != list.last?.id {
            Rectangle().fill(DockStyle.hairline).frame(height: 1).padding(.leading, 56)
          }
        }
      }
    }
    .padding(.top, 8)
    .padding(.bottom, 2)
  }

  // MARK: Strip

  private func strip(progress: CGFloat) -> some View {
    VStack(spacing: 0) {
      Button { model.toggleStatus() } label: {
        VStack(spacing: 0) {
          Capsule().fill(Color.white.opacity(0.22)).frame(width: 34, height: 4).padding(.top, 6)
          TimelineView(.periodic(from: Date(), by: 1)) { context in
            DockStripContent(status: model.status ?? DockStatus(), now: context.date,
              progress: model.expanded && model.panel == .status ? progress : 0, reduce: model.reduceMotion)
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
      .accessibilityValue(Text(model.expanded && model.panel == .status ? "Expanded" : "Collapsed"))
      .accessibilityHint(Text(model.expanded && model.panel == .status ? "Hides the full status" : "Shows the full status"))
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
      ForEach(model.tabs) { tab in
        DockTabButton(tab: tab, selected: model.displayedID == tab.id,
          open: model.expanded && model.displayedID == tab.id,
          badge: tab.id == "more" ? model.badge : 0,
          reduce: model.reduceMotion, namespace: pill) { model.onTab(tab) }
      }
    }
    .padding(.horizontal, 4)
    .padding(.top, 2)
    .padding(.bottom, 4)
    // Like the system tab bar, the row stops growing past the largest
    // standard text size; the strip and the sheets keep scaling.
    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    .animation(motion, value: model.displayedID)
  }
}

// MARK: - Sheets

/// A tab's sheet: the game's sections, and on More the app's own first.
struct DockSheetContent: View {
  @ObservedObject var model: DockModel
  let key: String

  private var sheet: DockSheet? { model.sheet(key) }
  private var isMore: Bool { key == "more" }

  private var title: String { model.title(of: .sheet(key)) }

  private struct AppRow: Identifiable {
    let id: String
    let icon: DockIcon
    let label: String
    let count: Int
    let app: DockApp
  }

  private var appRows: [AppRow] {
    var rows = [AppRow]()
    let hasTab = { (id: String) in model.tabs.contains { $0.id == id } }
    if !hasTab("briefing") { rows.append(AppRow(id: "briefing", icon: DockAppIcons.briefing, label: "Briefing", count: 0, app: .briefing)) }
    rows.append(AppRow(id: "inbox", icon: DockAppIcons.inbox, label: "Inbox", count: model.badge, app: .inbox))
    if !hasTab("ask") { rows.append(AppRow(id: "ask", icon: DockAppIcons.ask, label: "Ask", count: 0, app: .ask)) }
    rows.append(AppRow(id: "alerts", icon: DockAppIcons.alerts, label: "Alerts", count: 0, app: .alerts))
    rows.append(AppRow(id: "launcher", icon: DockAppIcons.launcher, label: "Back to launcher", count: 0, app: .launcher))
    return rows
  }

  /// On More the app's Inbox row stands in for the game's Notifications row.
  private var sections: [DockSection] {
    guard let sheet else { return [] }
    return isMore ? sheet.sections(without: "notifications") : sheet.sections
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if !title.isEmpty {
        Text(title)
          .font(.headline)
          .foregroundColor(DockStyle.text)
          .lineLimit(2)
          .truncationMode(.tail)
          .padding(.horizontal, 16)
          .padding(.top, 14)
          .padding(.bottom, 4)
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityAddTraits(.isHeader)
      }
      if isMore {
        sectionHeader("App")
        ForEach(Array(appRows.enumerated()), id: \.element.id) { index, row in
          DockSheetRow(label: row.label, icon: row.icon, count: row.count, external: false) { model.openApp(row.app) }
          if index < appRows.count - 1 { divider }
        }
      }
      ForEach(sections) { section in
        if let name = section.title, !name.isEmpty { sectionHeader(name) }
        ForEach(Array(section.links.enumerated()), id: \.element.id) { index, link in
          DockSheetRow(label: link.label, icon: link.icon, count: 0, external: link.external) { model.openLink(link) }
          if index < section.links.count - 1 { divider }
        }
      }
    }
    .padding(.bottom, 6)
  }

  private var divider: some View {
    Rectangle().fill(DockStyle.hairline).frame(height: 1).padding(.leading, 16)
  }

  private func sectionHeader(_ name: String) -> some View {
    Text(name)
      .font(.footnote.weight(.semibold))
      .foregroundColor(DockStyle.muted)
      .lineLimit(1)
      .truncationMode(.tail)
      .padding(.horizontal, 16)
      .padding(.top, 12)
      .padding(.bottom, 2)
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityAddTraits(.isHeader)
  }
}

struct DockSheetRow: View {
  let label: String
  let icon: DockIcon?
  let count: Int
  let external: Bool
  let action: () -> Void
  @Environment(\.sizeCategory) private var sizeCategory

  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        // The icon column is always reserved, so labels line up whether or
        // not a row has an icon.
        Group {
          if let icon, icon.columns > 0 {
            DockPixelIcon(icon: icon, base: 20).foregroundColor(DockStyle.muted)
          } else {
            Color.clear
          }
        }
        .frame(width: 28, height: 28)
        .accessibilityHidden(true)
        Text(label)
          .font(.body)
          .foregroundColor(DockStyle.text)
          .lineLimit(sizeCategory.isAccessibilityCategory ? 4 : 2)
          .truncationMode(.tail)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 8)
        if count > 0 {
          Text(count > 99 ? "99+" : String(count))
            .font(.system(size: 12, weight: .bold))
            .foregroundColor(.white)
            .padding(.horizontal, 6)
            .frame(minWidth: 20, minHeight: 20)
            .background(Capsule().fill(DockStyle.accent))
            .accessibilityHidden(true)
        }
        Image(systemName: external ? "arrow.up.right" : "chevron.right")
          .font(.system(size: 11, weight: .bold))
          .foregroundColor(DockStyle.muted.opacity(0.7))
          .accessibilityHidden(true)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(DockPressStyle(scale: 0.99))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text(count > 0 ? "\(label), \(count) unread" : label))
    .accessibilityHint(Text(external ? "Opens outside the game" : "Opens the page"))
    .accessibilityAddTraits(.isButton)
  }
}

// MARK: - Pixel icons

/// The game's pixel icon, drawn as crisp square pixels in the current
/// foreground colour: whole device pixels per cell, no smoothing, no
/// fractional scaling. `emphasized` is the selected tab's small pop, one
/// device pixel more per cell, so it stays sharp too.
struct DockPixelIcon: View {
  let icon: DockIcon
  let base: CGFloat
  var emphasized = false
  /// 1 at the default text size, growing with Dynamic Type.
  @ScaledMetric(relativeTo: .caption2) private var factor: CGFloat = 1

  var body: some View {
    let side = min(base * factor, base * 1.25)
    // Room for the emphasized size; the drawing is centered in it.
    let box = side * 1.3
    Canvas { context, size in
      let columns = CGFloat(max(icon.columns, 1))
      let rows = CGFloat(max(icon.rows, 1))
      let screen = UIScreen.main.scale
      let fit = floor(min(side / columns, side / rows) * screen)
      let cell = max(fit + (emphasized ? 1 : 0), 1) / screen
      let x0 = ((size.width - cell * columns) / 2 * screen).rounded() / screen
      let y0 = ((size.height - cell * rows) / 2 * screen).rounded() / screen
      var path = Path()
      for (row, line) in icon.grid.enumerated() {
        for (column, character) in line.enumerated() where character == "1" {
          path.addRect(CGRect(x: x0 + CGFloat(column) * cell, y: y0 + CGFloat(row) * cell, width: cell, height: cell))
        }
      }
      context.fill(path, with: .foreground, style: FillStyle(antialiased: false))
    }
    .frame(width: box, height: box)
  }
}

// MARK: - Tab button

struct DockTabButton: View {
  let tab: DockTab
  let selected: Bool
  let open: Bool
  let badge: Int
  let reduce: Bool
  let namespace: Namespace.ID
  let action: () -> Void

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
          icon
            .foregroundColor(selected ? DockStyle.accent : DockStyle.muted)
        }
        .frame(width: 58, height: 30)
        .overlay(badgeView, alignment: .topTrailing)
        Text(tab.label)
          .font(.caption2.weight(.medium))
          .foregroundColor(selected ? DockStyle.text : DockStyle.muted)
          .lineLimit(1)
          .minimumScaleFactor(0.7)
          .truncationMode(.tail)
          .padding(.horizontal, 3)
      }
      .frame(maxWidth: .infinity, minHeight: 54)
      .contentShape(Rectangle())
    }
    .buttonStyle(DockPressStyle(scale: 0.94))
    .accessibilityIdentifier("ahdclient-tab-\(tab.id)")
    .accessibilityLabel(Text(badge > 0 ? "\(tab.label), \(badge) unread" : tab.label))
    .accessibilityValue(Text(isSheet ? (open ? "Open" : "Closed") : ""))
    .accessibilityHint(Text(isSheet ? "Opens a menu" : "Opens the page"))
    .accessibilityAddTraits(selected ? [.isSelected] : [])
  }

  /// Ids whose symbol has a filled form; the rest keep one look when selected.
  private static let filled: Set<String> = ["game", "briefing", "ask", "more", "company", "state"]

  private var isSheet: Bool {
    if case .sheet = tab.kind { return true }
    return false
  }

  @ViewBuilder private var icon: some View {
    if let icon = tab.icon, icon.columns > 0 {
      DockPixelIcon(icon: icon, base: 22, emphasized: selected && !reduce)
    } else {
      Image(systemName: selected && Self.filled.contains(tab.id) ? tab.symbol + ".fill" : tab.symbol)
        .font(.system(size: 20, weight: .medium))
        .scaleEffect(selected && !reduce ? 1.1 : 1)
    }
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
