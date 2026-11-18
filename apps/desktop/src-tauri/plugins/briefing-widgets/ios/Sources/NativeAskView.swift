import Foundation
import PhotosUI
import SwiftUI
import UIKit

/// AHD red. A little lighter in dark mode so white text on it keeps 4.5:1.
enum NativeAskTint {
  static let uiColor = UIColor { traits in
    traits.userInterfaceStyle == .dark
      ? UIColor(red: 217 / 255, green: 54 / 255, blue: 63 / 255, alpha: 1)
      : UIColor(red: 200 / 255, green: 32 / 255, blue: 47 / 255, alpha: 1)
  }
  static let color = Color(uiColor)
}

/// The sheet. iPad and other wide layouts get history in a sidebar; iPhone
/// gets a single conversation with history in its own sheet.
struct NativeAskView: View {
  @ObservedObject var model: NativeAskModel

  var body: some View {
    GeometryReader { geo in
      if geo.size.width >= 740 {
        NativeAskSplitLayout(model: model, sidebarWidth: geo.size.width >= 1000 ? 340 : 300)
      } else {
        NativeAskCompactLayout(model: model)
      }
    }
    .accentColor(NativeAskTint.color)
    .tint(NativeAskTint.color)
    .overlay(alignment: .top) { NativeAskToast(message: model.toast) }
    .onAppear { model.start() }
    .accessibilityAction(.escape) { model.onClose?() }
  }
}

private struct NativeAskCompactLayout: View {
  @ObservedObject var model: NativeAskModel
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    NavigationView {
      NativeAskThreadPane(model: model, compact: true)
    }
    .navigationViewStyle(.stack)
    .sheet(isPresented: $model.showingHistory) {
      NavigationView {
        NativeAskHistoryList(model: model, sidebar: false)
          .navigationTitle("History")
          .navigationBarTitleDisplayMode(.large)
          .toolbar {
            ToolbarItem(placement: .confirmationAction) {
              Button("Done") { model.showingHistory = false }
            }
          }
      }
      .navigationViewStyle(.stack)
      .accentColor(NativeAskTint.color)
      .tint(NativeAskTint.color)
      // Sheets do not inherit the host's appearance override on their own.
      .preferredColorScheme(colorScheme)
    }
  }
}

private struct NativeAskSplitLayout: View {
  @ObservedObject var model: NativeAskModel
  let sidebarWidth: CGFloat

  var body: some View {
    HStack(spacing: 0) {
      NavigationView {
        NativeAskHistoryList(model: model, sidebar: true)
          .navigationTitle("Ask")
          .toolbar {
            ToolbarItem(placement: .navigationBarLeading) { NativeAskCloseButton(model: model) }
            ToolbarItem(placement: .navigationBarTrailing) {
              Button { model.newConversation() } label: { Image(systemName: "square.and.pencil") }
                .disabled(model.sending || model.turns.isEmpty)
                .accessibilityLabel("New chat")
            }
          }
      }
      .navigationViewStyle(.stack)
      .frame(width: sidebarWidth)
      Divider().ignoresSafeArea()
      NavigationView {
        NativeAskThreadPane(model: model, compact: false)
      }
      .navigationViewStyle(.stack)
    }
  }
}

private struct NativeAskCloseButton: View {
  @ObservedObject var model: NativeAskModel

  var body: some View {
    Button { model.onClose?() } label: {
      Image(systemName: "xmark.circle.fill")
        .font(.system(size: 26))
        .symbolRenderingMode(.hierarchical)
        .foregroundColor(.secondary)
    }
    .accessibilityLabel("Close Ask")
  }
}

// MARK: - History

private struct NativeAskHistoryList: View {
  @ObservedObject var model: NativeAskModel
  let sidebar: Bool
  @State private var query = ""

  private var filtered: [NativeAskConversation] {
    let text = query.trimmingCharacters(in: .whitespaces)
    return text.isEmpty ? model.conversations : model.conversations.filter { $0.title.localizedCaseInsensitiveContains(text) }
  }

  var body: some View {
    styled(
      List {
        if let usage = model.usage, model.provider == .server, model.signedIn {
          Section { NativeAskQuotaCard(usage: usage) }
        }
        Section {
          Button { model.newConversation() } label: {
            Label("New chat", systemImage: "square.and.pencil")
          }
          .disabled(model.sending)
        }
        Section(header: Text("Recent")) {
          if !model.signedIn && !model.isPreview {
            Text("Link your game account to see your conversations.")
              .font(.subheadline)
              .foregroundColor(.secondary)
          } else if model.historyLoading && model.conversations.isEmpty {
            ForEach(0..<5, id: \.self) { _ in NativeAskHistoryPlaceholder() }
          } else if let error = model.historyError, model.conversations.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
              Text(error).font(.subheadline).foregroundColor(.secondary)
              Button("Try again") { Task { await model.refreshHistory() } }
                .font(.subheadline.weight(.semibold))
            }
            .padding(.vertical, 4)
          } else if filtered.isEmpty {
            Text(query.isEmpty ? "No conversations yet. Your questions will appear here." : "No conversations match.")
              .font(.subheadline)
              .foregroundColor(.secondary)
          } else {
            ForEach(filtered) { conversation in
              row(conversation)
            }
          }
        }
      }
    )
    .refreshable { await model.refreshHistory() }
    .searchable(text: $query, prompt: "Search conversations")
    .task { if !model.historyLoaded { await model.refreshHistory() } }
  }

  @ViewBuilder private func styled<Content: View>(_ list: Content) -> some View {
    if sidebar {
      list.listStyle(.sidebar)
    } else {
      list.listStyle(.insetGrouped)
    }
  }

  private func row(_ conversation: NativeAskConversation) -> some View {
    let current = conversation.id == model.conversationID
    return Button { model.openConversation(conversation) } label: {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 3) {
          Text(conversation.title)
            .font(.body.weight(current ? .semibold : .regular))
            .foregroundColor(.primary)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
          if let updated = conversation.updated {
            Text(Self.relative(updated)).font(.caption).foregroundColor(.secondary)
          }
        }
        Spacer(minLength: 0)
        if conversation.isPrivate {
          Image(systemName: "lock.fill")
            .font(.caption)
            .foregroundColor(.secondary)
            .accessibilityLabel("Private")
        }
      }
      .padding(.vertical, 3)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .listRowBackground(current ? NativeAskTint.color.opacity(0.12) : nil)
    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
      Button(role: .destructive) { model.deleteConversation(conversation) } label: {
        Label("Delete", systemImage: "trash")
      }
    }
    .contextMenu {
      Button(role: .destructive) { model.deleteConversation(conversation) } label: {
        Label("Delete conversation", systemImage: "trash")
      }
    }
    .accessibilityHint(Text("Opens this conversation"))
    .accessibilityAddTraits(current ? .isSelected : [])
  }

  static func relative(_ date: Date) -> String {
    let age = Date().timeIntervalSince(date)
    if age < 60 { return "Just now" }
    if age < 7 * 86_400 {
      let formatter = RelativeDateTimeFormatter()
      formatter.unitsStyle = .full
      return formatter.localizedString(for: date, relativeTo: Date())
    }
    return date.formatted(date: .abbreviated, time: .omitted)
  }
}

private struct NativeAskHistoryPlaceholder: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("A conversation title here").font(.body)
      Text("2 days ago").font(.caption)
    }
    .redacted(reason: .placeholder)
    .accessibilityHidden(true)
  }
}

private struct NativeAskQuotaCard: View {
  let usage: NativeAskUsage

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .firstTextBaseline) {
        Text("Today").font(.subheadline.weight(.semibold))
        Spacer()
        if let reset = usage.resetLabel {
          Text("Resets in \(reset)").font(.caption).foregroundColor(.secondary)
        }
      }
      meter("Questions", remaining: usage.remaining, limit: usage.limit)
      if usage.liveLimit > 0 {
        meter("Live game data", remaining: usage.liveRemaining, limit: usage.liveLimit)
      }
      if let limit = usage.chartLimit, limit > 0 {
        meter("Charts and maps", remaining: usage.chartRemaining ?? 0, limit: limit)
      }
    }
    .padding(.vertical, 6)
    .accessibilityElement(children: .combine)
  }

  private func meter(_ title: String, remaining: Double, limit: Double) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack {
        Text(title).font(.caption)
        Spacer()
        Text("\(NativeAskUsage.format(remaining)) of \(NativeAskUsage.format(limit)) left")
          .font(.caption.monospacedDigit())
          .foregroundColor(.secondary)
      }
      ProgressView(value: limit > 0 ? min(1, max(0, remaining / limit)) : 0)
        .tint(remaining <= 0 ? Color(.systemOrange) : NativeAskTint.color)
    }
  }
}

// MARK: - Thread

private struct NativeAskThreadPane: View {
  @ObservedObject var model: NativeAskModel
  let compact: Bool

  var body: some View {
    content
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .principal) { NativeAskTitle(model: model) }
        ToolbarItemGroup(placement: .navigationBarLeading) {
          if compact {
            NativeAskCloseButton(model: model)
            Button { model.showingHistory = true } label: { Image(systemName: "clock.arrow.circlepath") }
              .accessibilityLabel("History")
          }
        }
        ToolbarItemGroup(placement: .navigationBarTrailing) {
          if compact {
            Button { model.newConversation() } label: { Image(systemName: "square.and.pencil") }
              .disabled(model.sending || model.turns.isEmpty)
              .accessibilityLabel("New chat")
          } else if model.canShareConversation {
            Button { model.shareConversation() } label: { Image(systemName: "square.and.arrow.up") }
              .accessibilityLabel("Share conversation")
          }
          NativeAskOptionsMenu(model: model)
        }
      }
  }

  @ViewBuilder private var content: some View {
    if model.provider == .server && model.connecting && !model.connected && model.turns.isEmpty && !model.isPreview {
      VStack(spacing: 14) {
        ProgressView()
        Text("Checking your game account").font(.subheadline).foregroundColor(.secondary)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityElement(children: .combine)
    } else if model.provider == .server && !model.signedIn && model.turns.isEmpty {
      NativeAskLinkView(model: model)
    } else if model.needsConsent {
      NativeAskConsentView(model: model)
    } else {
      NativeAskConversationView(model: model)
    }
  }
}

private struct NativeAskTitle: View {
  @ObservedObject var model: NativeAskModel

  private var subtitle: String {
    if model.provider == .appleOnDevice { return "On this \(NativeAskModel.deviceName)" }
    if model.offline { return "Offline" }
    if model.connecting && !model.connected && !model.isPreview { return "Connecting" }
    guard model.signedIn else { return "" }
    return model.usage?.label ?? ""
  }

  var body: some View {
    VStack(spacing: 1) {
      Text(model.turns.isEmpty ? "Ask" : model.currentTitle)
        .font(.headline)
        .lineLimit(1)
      if !subtitle.isEmpty {
        Text(subtitle)
          .font(.caption2)
          .foregroundColor(model.usage?.exhausted == true && model.provider == .server ? Color(.systemOrange) : .secondary)
          .lineLimit(1)
      }
    }
    .frame(maxWidth: 280)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }
}

private struct NativeAskOptionsMenu: View {
  @ObservedObject var model: NativeAskModel

  var body: some View {
    Menu {
      Section {
        Picker(selection: $model.provider, label: Text("Answers from")) {
          Label("Online, with live game data", systemImage: "network").tag(NativeAskProvider.server)
          Label("On this \(NativeAskModel.deviceName), private", systemImage: "lock.iphone").tag(NativeAskProvider.appleOnDevice)
        }
      }
      if model.provider == .server {
        Section {
          Toggle(isOn: $model.useLive) { Label("Use live game data", systemImage: "dot.radiowaves.left.and.right") }
          Toggle(isOn: $model.visualizations) { Label("Charts and maps", systemImage: "chart.bar.xaxis") }
        }
      }
      Section {
        Button { model.shareConversation() } label: { Label("Share conversation", systemImage: "square.and.arrow.up") }
          .disabled(!model.canShareConversation)
        if model.signedIn && model.consented {
          Button { model.reviewingConsent = true } label: { Label("AI providers", systemImage: "hand.raised") }
        }
      }
      if let usage = model.usage, model.provider == .server {
        Section {
          Text(usage.resetLabel.map { "\(usage.label). Resets in \($0)." } ?? usage.label)
        }
      }
    } label: {
      Image(systemName: "ellipsis.circle")
    }
    .accessibilityLabel("Options")
  }
}

private struct NativeAskKeyboardDismiss: ViewModifier {
  @ViewBuilder func body(content: Content) -> some View {
    if #available(iOS 16.0, *) {
      content.scrollDismissesKeyboard(.interactively)
    } else {
      content
    }
  }
}

private struct NativeAskConversationView: View {
  @ObservedObject var model: NativeAskModel

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          if model.loadingConversation {
            NativeAskLoadingThread()
          } else if model.turns.isEmpty {
            NativeAskEmptyState(model: model)
          } else {
            ForEach(model.turns) { turn in
              NativeAskTurnView(model: model, turn: turn, isLast: turn.id == model.turns.last?.id)
                .id(turn.id)
                .padding(.bottom, 36)
            }
          }
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 8)
        .frame(maxWidth: 720)
        .frame(maxWidth: .infinity)
      }
      .modifier(NativeAskKeyboardDismiss())
      .onChange(of: model.turns.count) { _ in
        guard let last = model.turns.last else { return }
        withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo(last.id, anchor: .top) }
      }
      .onAppear {
        if let last = model.turns.last { proxy.scrollTo(last.id, anchor: .top) }
      }
      .safeAreaInset(edge: .bottom, spacing: 0) { NativeAskComposer(model: model) }
    }
  }
}

private struct NativeAskBanners: View {
  @ObservedObject var model: NativeAskModel

  var body: some View {
    VStack(spacing: 10) {
      if model.offline {
        NativeAskBanner(icon: "wifi.slash", color: Color(.systemOrange),
                        text: "You're offline. Ask will reconnect when you're back online.")
      }
      if let notice = model.notice {
        NativeAskBanner(icon: "exclamationmark.circle.fill", color: Color(.systemOrange), text: notice,
                        onDismiss: { model.notice = nil })
      }
      if model.provider == .server && !model.signedIn && !model.turns.isEmpty && !model.connecting {
        NativeAskBanner(icon: "person.crop.circle.badge.exclamationmark", color: NativeAskTint.color,
                        text: "Link your game account to keep asking.",
                        actionTitle: "Link account", action: { model.onLinkAccount?() })
      }
      if model.provider == .server, model.signedIn, let usage = model.usage, usage.exhausted {
        NativeAskBanner(icon: "hourglass", color: Color(.systemOrange), text: model.quotaMessage,
                        actionTitle: model.appleAvailable ? "Answer on this \(NativeAskModel.deviceName)" : nil,
                        action: { model.provider = .appleOnDevice })
      }
      if model.provider == .appleOnDevice {
        NativeAskBanner(icon: "lock.iphone", color: Color(.systemBlue),
                        text: model.appleAvailable
                          ? "Answers are written privately on this \(NativeAskModel.deviceName). They can't see live game data."
                          : model.appleMessage,
                        actionTitle: "Use online answers", action: { model.provider = .server })
      }
    }
    .padding(.bottom, hasBanner ? 2 : 0)
    .animation(.easeInOut(duration: 0.2), value: model.notice)
  }

  private var hasBanner: Bool {
    model.offline || model.notice != nil || model.provider == .appleOnDevice
      || (model.provider == .server && !model.signedIn && !model.turns.isEmpty && !model.connecting)
      || (model.provider == .server && model.signedIn && model.usage?.exhausted == true)
  }
}

private struct NativeAskBanner: View {
  let icon: String
  let color: Color
  let text: String
  var actionTitle: String? = nil
  var action: (() -> Void)? = nil
  var onDismiss: (() -> Void)? = nil

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: icon)
        .font(.body.weight(.semibold))
        .foregroundColor(color)
        .frame(width: 22)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 8) {
        Text(text).font(.subheadline).fixedSize(horizontal: false, vertical: true)
        if let actionTitle, let action {
          Button(actionTitle, action: action)
            .font(.subheadline.weight(.semibold))
            .buttonStyle(.borderless)
        }
      }
      Spacer(minLength: 0)
      if let onDismiss {
        Button(action: onDismiss) {
          Image(systemName: "xmark")
            .font(.caption.weight(.bold))
            .foregroundColor(.secondary)
            .frame(width: 28, height: 28)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Dismiss")
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(.secondarySystemFill)))
    .transition(.opacity)
  }
}

private struct NativeAskEmptyState: View {
  @ObservedObject var model: NativeAskModel

  private var starters: [(String, String)] {
    if model.provider == .appleOnDevice {
      return [
        ("bolt.fill", "How do actions and action points work?"),
        ("arrow.triangle.2.circlepath", "What happens during a game turn, and in what order?"),
        ("building.columns.fill", "How does a bill become law?"),
      ]
    }
    return [
      ("clock.arrow.circlepath", "What did I miss while I was away?"),
      ("bolt.fill", "How do actions and action points work?"),
      ("chart.bar.fill", "Chart the five largest economies by GDP"),
      ("map.fill", "Show unemployment by country on a map"),
    ]
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 21) {
      VStack(alignment: .leading, spacing: 7) {
        Text("Ask about the game")
          .font(.title2.weight(.semibold))
          .accessibilityAddTraits(.isHeader)
        Text(model.provider == .server
          ? "Look up a rule, plan your next move, or catch up on the latest turn."
          : "Answers are written privately on this \(NativeAskModel.deviceName) from the game's guides.")
          .font(.subheadline)
          .foregroundColor(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.top, 26)

      VStack(spacing: 0) {
        Divider()
        ForEach(Array(starters.enumerated()), id: \.offset) { item in
          Button { model.draft = item.element.1 } label: {
            HStack(spacing: 14) {
              Image(systemName: item.element.0)
                .font(.body)
                .foregroundColor(NativeAskTint.color)
                .frame(width: 24)
              Text(item.element.1)
                .font(.subheadline)
                .foregroundColor(.primary)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
              Spacer(minLength: 8)
              Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundColor(.secondary)
                .accessibilityHidden(true)
            }
            .padding(.trailing, 2)
            .padding(.vertical, 13)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .disabled(!model.canAsk)
          .accessibilityHint(Text("Fills the question field"))
          Divider()
        }
      }
    }
  }
}

private struct NativeAskLoadingThread: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 28) {
      ForEach(0..<2, id: \.self) { _ in
        VStack(alignment: .leading, spacing: 14) {
          HStack {
            Spacer()
            Capsule().fill(Color(.tertiarySystemFill)).frame(width: 210, height: 38)
          }
          NativeAskSkeleton()
        }
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Loading the conversation")
  }
}

struct NativeAskSkeleton: View {
  @State private var dim = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach([0.96, 0.84, 0.62], id: \.self) { width in
        GeometryReader { geo in
          Capsule().fill(Color(.tertiarySystemFill)).frame(width: geo.size.width * CGFloat(width))
        }
        .frame(height: 12)
      }
    }
    .opacity(dim ? 0.45 : 1)
    .onAppear {
      withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Writing the answer")
  }
}

struct NativeAskMark: View {
  var size: CGFloat = 24

  var body: some View {
    ZStack {
      Circle().fill(NativeAskTint.color)
      Image(systemName: "building.columns.fill")
        .font(.system(size: size * 0.46, weight: .semibold))
        .foregroundColor(.white)
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

private struct NativeAskPill: View {
  let text: String
  let icon: String

  var body: some View {
    Label(text, systemImage: icon)
      .font(.caption2.weight(.semibold))
      .foregroundColor(.secondary)
      .padding(.horizontal, 8)
      .padding(.vertical, 3)
      .background(Capsule().fill(Color(.tertiarySystemFill)))
  }
}

private struct NativeAskTurnView: View {
  @ObservedObject var model: NativeAskModel
  let turn: NativeAskTurn
  let isLast: Bool
  @State private var reporting = false
  @State private var sourcesOpen = false

  private static let reasons = ["Wrong information", "Out of date", "Didn't answer my question", "Something else"]

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      question
      header
      answer
      footer
      if turn.state == .done && !turn.answer.isEmpty { actions }
      if isLast && turn.state == .done && !turn.followups.isEmpty && !model.sending { followups }
    }
  }

  private var question: some View {
    HStack {
      Spacer(minLength: 56)
      VStack(alignment: .trailing, spacing: 6) {
        if !turn.attachments.isEmpty {
          HStack(spacing: 6) {
            ForEach(turn.attachments) { attachment in
              NativeAskSentPhoto(attachment: attachment, model: model)
            }
          }
        }
        Text(turn.question)
          .font(.body)
          .foregroundColor(.primary)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, 15)
          .padding(.vertical, 10)
          .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(.secondarySystemFill)))
          .textSelection(.enabled)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(Text("You asked: \(turn.question)"))
  }

  private var header: some View {
    HStack(spacing: 8) {
      NativeAskMark(size: 24)
      Text("Ask").font(.subheadline.weight(.semibold))
      if turn.local { NativeAskPill(text: "On this \(NativeAskModel.deviceName)", icon: "lock.fill") }
      if turn.state == .stopped { NativeAskPill(text: "Stopped", icon: "stop.fill") }
      Spacer()
    }
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder private var answer: some View {
    switch turn.state {
    case .streaming:
      if turn.answer.isEmpty {
        NativeAskSkeleton()
      } else {
        NativeAskAnswerView(text: turn.answer, model: model)
      }
      NativeAskStatusLine(text: turn.status, lookups: turn.lookups)
    case .failed(let message):
      NativeAskErrorCard(message: message, actionTitle: "Try again") { model.retry(turn.id) }
    case .interrupted(let message):
      NativeAskAnswerView(text: turn.answer, model: model)
      NativeAskErrorCard(message: message, actionTitle: "Check and retry") { model.retry(turn.id) }
    case .done, .stopped:
      NativeAskAnswerView(text: turn.answer, model: model)
    }
  }

  private var modelLine: String {
    if turn.local {
      return turn.citations.isEmpty ? "Written on this \(NativeAskModel.deviceName)" : "Written on this \(NativeAskModel.deviceName) from the game's guides"
    }
    return turn.model.isEmpty ? "" : "Written by \(turn.model)"
  }

  @ViewBuilder private var footer: some View {
    if turn.state != .streaming && !turn.answer.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        if turn.chartsUsedUp {
          Label("Charts and maps are used up for today, so this answer comes without them.", systemImage: "chart.bar.xaxis")
            .font(.footnote)
            .foregroundColor(.secondary)
        }
        if turn.usedLive {
          Label(turn.liveSources.isEmpty ? "Used live game data" : "Live game data: " + turn.liveSources.joined(separator: ", "),
                systemImage: "dot.radiowaves.left.and.right")
            .font(.footnote)
            .foregroundColor(.secondary)
        }
        if let report = turn.reportURL {
          Button { model.open(report) } label: { Label("Open the full report", systemImage: "doc.richtext") }
            .font(.footnote.weight(.semibold))
            .buttonStyle(.borderless)
        }
        if !turn.citations.isEmpty { sources }
        if !modelLine.isEmpty {
          Text(modelLine).font(.caption).foregroundColor(Color(.tertiaryLabel))
        }
      }
    }
  }

  private var sources: some View {
    DisclosureGroup(isExpanded: $sourcesOpen) {
      VStack(alignment: .leading, spacing: 9) {
        ForEach(Array(turn.citations.enumerated()), id: \.offset) { item in
          if let url = item.element.url {
            Button { model.open(url) } label: { sourceRow(item.offset, item.element, linked: true) }
              .buttonStyle(.plain)
          } else {
            sourceRow(item.offset, item.element, linked: false)
          }
        }
      }
      .padding(.top, 8)
    } label: {
      Label("Sources (\(turn.citations.count))", systemImage: "books.vertical")
        .font(.footnote.weight(.medium))
        .foregroundColor(.secondary)
    }
  }

  private func sourceRow(_ index: Int, _ citation: NativeAskCitation, linked: Bool) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text("\(index + 1)")
        .font(.caption2.monospacedDigit().weight(.semibold))
        .foregroundColor(.secondary)
        .frame(minWidth: 14)
      Text(citation.label)
        .font(.footnote)
        .foregroundColor(linked ? NativeAskTint.color : .primary)
        .multilineTextAlignment(.leading)
      if linked {
        Image(systemName: "arrow.up.right").font(.caption2).foregroundColor(.secondary)
      }
    }
  }

  private var actions: some View {
    HStack(spacing: 2) {
      actionButton("doc.on.doc", label: "Copy answer") { model.copy(turn) }
      if model.canShareConversation && !turn.local {
        actionButton("square.and.arrow.up", label: "Share conversation") { model.shareConversation() }
      }
      Spacer()
      if turn.answerID != nil {
        actionButton(turn.feedback == "up" ? "hand.thumbsup.fill" : "hand.thumbsup", label: "Helpful", selected: turn.feedback == "up") {
          model.rate(turn.id, rating: "up")
        }
        actionButton(turn.feedback == "down" ? "hand.thumbsdown.fill" : "hand.thumbsdown", label: "Not helpful", selected: turn.feedback == "down") {
          reporting = true
        }
      }
    }
    .padding(.leading, -8)
    .confirmationDialog("What was wrong with this answer?", isPresented: $reporting, titleVisibility: .visible) {
      ForEach(Self.reasons, id: \.self) { reason in
        Button(reason) { model.rate(turn.id, rating: "down", reason: reason) }
      }
      Button("Cancel", role: .cancel) {}
    }
  }

  private func actionButton(_ icon: String, label: String, selected: Bool = false, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: icon)
        .font(.subheadline.weight(.medium))
        .frame(width: 38, height: 34)
        .contentShape(Rectangle())
    }
    .buttonStyle(.borderless)
    .foregroundColor(selected ? NativeAskTint.color : .secondary)
    .accessibilityLabel(Text(label))
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  private var followupNote: String? {
    guard let left = model.followupsLeft else { return nil }
    if left <= 0 { return "Follow-ups are used up here. Each new question costs one." }
    let cost = model.usage?.followupCost.map { $0 == 0.5 ? "half a question" : "\(NativeAskUsage.format($0)) of a question" } ?? "half a question"
    return "Follow-ups cost \(cost). \(left) left in this conversation."
  }

  private var followups: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Follow up").font(.footnote.weight(.semibold)).foregroundColor(.secondary)
      ForEach(turn.followups, id: \.self) { followup in
        Button { model.send(followup) } label: {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "arrow.turn.down.right").font(.footnote.weight(.semibold))
            Text(followup)
              .font(.subheadline)
              .multilineTextAlignment(.leading)
              .fixedSize(horizontal: false, vertical: true)
          }
          .foregroundColor(NativeAskTint.color)
          .padding(.horizontal, 14)
          .padding(.vertical, 10)
          .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(NativeAskTint.color.opacity(0.08)))
          .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(NativeAskTint.color.opacity(0.2), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(!model.canAsk)
        .accessibilityHint(Text("Sends this question"))
      }
      if let note = followupNote {
        Text(note).font(.caption).foregroundColor(.secondary).padding(.top, 2)
      }
    }
  }
}

private struct NativeAskStatusLine: View {
  let text: String
  let lookups: Int

  var body: some View {
    HStack(spacing: 8) {
      ProgressView().controlSize(.small)
      Text(text.isEmpty ? "Thinking" : text)
        .font(.footnote)
        .foregroundColor(.secondary)
      if lookups > 0 {
        Text("\u{00B7} \(lookups) \(lookups == 1 ? "lookup" : "lookups")")
          .font(.footnote.monospacedDigit())
          .foregroundColor(Color(.tertiaryLabel))
      }
    }
    .accessibilityElement(children: .combine)
  }
}

private struct NativeAskErrorCard: View {
  let message: String
  let actionTitle: String
  let action: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundColor(Color(.systemOrange))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 10) {
        Text(message).font(.subheadline).fixedSize(horizontal: false, vertical: true)
        Button(actionTitle, action: action)
          .buttonStyle(.bordered)
          .controlSize(.small)
      }
      Spacer(minLength: 0)
    }
    .padding(14)
    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(.secondarySystemBackground)))
  }
}

private struct NativeAskSentPhoto: View {
  let attachment: NativeAskAttachment
  let model: NativeAskModel
  @State private var data: Data?

  var body: some View {
    Group {
      if let bytes = data ?? attachment.thumbnail, let image = UIImage(data: bytes) {
        Image(uiImage: image).resizable().scaledToFill()
      } else {
        ZStack {
          Color(.secondarySystemBackground)
          Image(systemName: attachment.isImage ? "photo" : "doc").foregroundColor(.secondary)
        }
      }
    }
    .frame(width: 76, height: 76)
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    .task(id: attachment.url) {
      if attachment.thumbnail == nil { data = await model.thumbnail(for: attachment) }
    }
    .accessibilityLabel(Text("Attached photo"))
  }
}

// MARK: - Composer

private struct NativeAskComposer: View {
  @ObservedObject var model: NativeAskModel
  @FocusState private var focused: Bool
  @State private var pickingPhoto = false

  private var placeholder: String {
    if model.provider == .appleOnDevice { return "Ask privately on this \(NativeAskModel.deviceName)" }
    if !model.draftAttachments.isEmpty { return "Ask about the photo" }
    return model.turns.isEmpty ? "Ask about the game" : "Ask a follow-up"
  }

  private var hint: (String, Bool)? {
    let count = model.trimmedDraft.utf16.count
    if count > NativeAskModel.maxQuestion - 80 {
      let left = NativeAskModel.maxQuestion - count
      return (left >= 0 ? "\(left) characters left" : "\(-left) characters over the limit", left < 0)
    }
    return nil
  }

  var body: some View {
    VStack(spacing: 8) {
      // Notices sit with the composer so they stay visible wherever the
      // thread is scrolled.
      NativeAskBanners(model: model)
      if model.sending {
        Label("Writing · safe to close", systemImage: "ellipsis.bubble")
          .font(.footnote)
          .foregroundColor(.secondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      if !model.draftAttachments.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 12) {
            ForEach(model.draftAttachments) { item in
              NativeAskDraftThumb(item: item) { model.removeAttachment(item.id) }
            }
          }
          .padding(.top, 8)
          .padding(.horizontal, 4)
        }
      }
      HStack(alignment: .bottom, spacing: 10) {
        if model.provider == .server {
          Button { pickingPhoto = true } label: {
            Image(systemName: "photo.on.rectangle.angled")
              .font(.system(size: 20))
              .frame(width: 36, height: 38)
          }
          .disabled(!model.canAttach)
          .accessibilityLabel("Attach a photo")
        }
        field
        sendButton
      }
      if let hint {
        Text(hint.0)
          .font(.caption2)
          .foregroundColor(hint.1 ? Color(.systemRed) : .secondary)
          .frame(maxWidth: .infinity, alignment: .trailing)
          .padding(.horizontal, 6)
      }
    }
    .padding(.horizontal, 14)
    .padding(.top, 10)
    .padding(.bottom, 10)
    .frame(maxWidth: 760)
    .frame(maxWidth: .infinity)
    .background(Color(.secondarySystemBackground))
    .overlay(Divider(), alignment: .top)
    .sheet(isPresented: $pickingPhoto) {
      NativeAskPhotoPicker(limit: max(1, NativeAskModel.maxAttachments - model.draftAttachments.count),
                           onPick: { image in model.addPhoto(image) },
                           onDone: { pickingPhoto = false })
        .ignoresSafeArea()
    }
  }

  @ViewBuilder private var input: some View {
    if #available(iOS 16.0, *) {
      TextField(placeholder, text: $model.draft, axis: .vertical).lineLimit(1...6)
    } else {
      TextField(placeholder, text: $model.draft)
    }
  }

  private var field: some View {
    input
      .font(.body)
      .focused($focused)
      .submitLabel(.send)
      .onSubmit { if model.canSend { model.send() } }
      .padding(.horizontal, 14)
      .padding(.vertical, 9)
      .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color(.systemBackground)))
      .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Color(.separator), lineWidth: 0.5))
      .accessibilityLabel(Text("Question"))
  }

  @ViewBuilder private var sendButton: some View {
    if model.sending {
      Button { model.stop() } label: {
        Image(systemName: "stop.circle.fill")
          .font(.system(size: 32))
          .symbolRenderingMode(.palette)
          .foregroundStyle(Color(.systemBackground), Color.primary)
      }
      .frame(width: 38, height: 38)
      .accessibilityLabel("Stop answer")
    } else {
      Button {
        model.send()
        if !UIAccessibility.isVoiceOverRunning { focused = false }
      } label: {
        Image(systemName: "arrow.up.circle.fill")
          .font(.system(size: 32))
          .symbolRenderingMode(.palette)
          .foregroundStyle(Color.white, model.canSend ? NativeAskTint.color : Color(.systemGray4))
      }
      .frame(width: 38, height: 38)
      .disabled(!model.canSend)
      .keyboardShortcut(.return, modifiers: .command)
      .accessibilityLabel("Send question")
    }
  }
}

private struct NativeAskDraftThumb: View {
  let item: NativeAskDraftAttachment
  let onRemove: () -> Void

  private var failure: String? {
    if case .failed(let message) = item.upload { return message }
    return nil
  }

  var body: some View {
    ZStack(alignment: .topTrailing) {
      ZStack {
        if let image = UIImage(data: item.thumbnail) {
          Image(uiImage: image).resizable().scaledToFill()
        } else {
          Color(.secondarySystemBackground)
          Image(systemName: "photo").foregroundColor(.secondary)
        }
        if item.upload == .uploading {
          Color.black.opacity(0.35)
          ProgressView().tint(.white)
        } else if failure != nil {
          Color.black.opacity(0.45)
          Image(systemName: "exclamationmark.triangle.fill").foregroundColor(.white)
        }
      }
      .frame(width: 64, height: 64)
      .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
      Button(action: onRemove) {
        Image(systemName: "xmark.circle.fill")
          .font(.system(size: 20))
          .symbolRenderingMode(.palette)
          .foregroundStyle(Color.white, Color.black.opacity(0.65))
      }
      .offset(x: 7, y: -7)
      .accessibilityLabel("Remove photo")
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(Text(failure.map { "Photo did not upload. \($0)" } ?? (item.upload == .uploading ? "Photo uploading" : "Photo attached")))
  }
}

/// PHPicker needs no photo library permission and runs out of process.
private struct NativeAskPhotoPicker: UIViewControllerRepresentable {
  let limit: Int
  let onPick: (UIImage) -> Void
  let onDone: () -> Void

  func makeCoordinator() -> Coordinator { Coordinator(onPick: onPick, onDone: onDone) }

  func makeUIViewController(context: Context) -> PHPickerViewController {
    var configuration = PHPickerConfiguration()
    configuration.filter = .images
    configuration.selectionLimit = limit
    configuration.preferredAssetRepresentationMode = .current
    let picker = PHPickerViewController(configuration: configuration)
    picker.delegate = context.coordinator
    return picker
  }

  func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}

  final class Coordinator: NSObject, PHPickerViewControllerDelegate {
    let onPick: (UIImage) -> Void
    let onDone: () -> Void

    init(onPick: @escaping (UIImage) -> Void, onDone: @escaping () -> Void) {
      self.onPick = onPick
      self.onDone = onDone
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
      onDone()
      let onPick = self.onPick
      for result in results where result.itemProvider.canLoadObject(ofClass: UIImage.self) {
        result.itemProvider.loadObject(ofClass: UIImage.self) { object, _ in
          guard let image = object as? UIImage else { return }
          DispatchQueue.main.async { onPick(image) }
        }
      }
    }
  }
}

// MARK: - Access screens

private struct NativeAskConsentView: View {
  @ObservedObject var model: NativeAskModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        ZStack {
          Circle().fill(NativeAskTint.color.opacity(0.12)).frame(width: 60, height: 60)
          Image(systemName: "hand.raised.fill").font(.system(size: 26, weight: .semibold)).foregroundColor(NativeAskTint.color)
        }
        .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 10) {
          Text("Ask uses outside AI services")
            .font(.title2.weight(.bold))
            .accessibilityAddTraits(.isHeader)
          Text("Ask answers with AI models run by other companies. When you send a question, it goes to one of the services below. They receive the text you type, earlier messages in the same chat, any photo you attach, and, if you ask about your own character, your own game records. Your username, email and account IDs are not sent.")
            .font(.subheadline)
            .foregroundColor(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(model.recipients.enumerated()), id: \.offset) { item in
            VStack(alignment: .leading, spacing: 3) {
              Text(item.element.name).font(.subheadline.weight(.semibold))
              if !item.element.detail.isEmpty {
                Text(item.element.detail).font(.footnote).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
              }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            if item.offset < model.recipients.count - 1 { Divider().padding(.leading, 16) }
          }
        }
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(.secondarySystemBackground)))
        Text("Each service has its own terms and data handling. Every answer names the model and service that wrote it. On-device answers stay on this \(NativeAskModel.deviceName).")
          .font(.footnote)
          .foregroundColor(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        Link(destination: NativeAskConsent.privacyURL) {
          Label("Ask privacy notice", systemImage: "lock.doc")
        }
        .font(.footnote.weight(.semibold))
        VStack(spacing: 12) {
          if model.consented {
            Button { model.reviewingConsent = false } label: { Text("Keep using Ask").frame(maxWidth: .infinity) }
              .buttonStyle(.borderedProminent)
              .controlSize(.large)
            Button(role: .destructive) { model.withdrawConsent() } label: { Text("Withdraw permission").frame(maxWidth: .infinity) }
              .buttonStyle(.bordered)
              .controlSize(.large)
          } else {
            Button { model.grantConsent() } label: { Text("Allow and continue").frame(maxWidth: .infinity) }
              .buttonStyle(.borderedProminent)
              .controlSize(.large)
            Text("Ask sends nothing until you allow it.")
              .font(.footnote)
              .foregroundColor(.secondary)
              .frame(maxWidth: .infinity)
            if model.appleAvailable {
              Button("Use private on-device answers instead") { model.provider = .appleOnDevice }
                .font(.subheadline)
                .buttonStyle(.borderless)
            }
          }
        }
        .padding(.top, 4)
      }
      .padding(24)
      .frame(maxWidth: 600)
      .frame(maxWidth: .infinity)
    }
  }
}

private struct NativeAskLinkView: View {
  @ObservedObject var model: NativeAskModel

  var body: some View {
    ScrollView {
      VStack(spacing: 18) {
        ZStack {
          Circle().fill(NativeAskTint.color.opacity(0.12)).frame(width: 72, height: 72)
          Image(systemName: "person.crop.circle.badge.checkmark")
            .font(.system(size: 32, weight: .medium))
            .foregroundColor(NativeAskTint.color)
        }
        .accessibilityHidden(true)
        .padding(.top, 40)
        Text("Link your game account")
          .font(.title2.weight(.bold))
          .accessibilityAddTraits(.isHeader)
        Text("Ask answers from your own game: your character, party, offices and companies. Link the account you play with to start.")
          .font(.subheadline)
          .foregroundColor(.secondary)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
        VStack(spacing: 12) {
          Button { model.onLinkAccount?() } label: { Text("Link game account").frame(maxWidth: .infinity) }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
          Button { model.reconnect() } label: { Text("Try again").frame(maxWidth: .infinity) }
            .buttonStyle(.bordered)
            .controlSize(.large)
          if model.appleAvailable {
            Button("Use private on-device answers") { model.provider = .appleOnDevice }
              .font(.subheadline)
              .buttonStyle(.borderless)
              .padding(.top, 4)
          }
        }
        .frame(maxWidth: 340)
        .padding(.top, 6)
        if let notice = model.notice {
          Label(notice, systemImage: model.offline ? "wifi.slash" : "exclamationmark.circle")
            .font(.footnote)
            .foregroundColor(.secondary)
            .multilineTextAlignment(.center)
            .padding(.top, 4)
        }
      }
      .padding(28)
      .frame(maxWidth: 520)
      .frame(maxWidth: .infinity)
    }
  }
}

private struct NativeAskToast: View {
  let message: String?

  var body: some View {
    ZStack {
      if let message {
        Label(message, systemImage: "checkmark.circle.fill")
          .font(.subheadline.weight(.semibold))
          .padding(.horizontal, 16)
          .padding(.vertical, 10)
          .background(.regularMaterial, in: Capsule())
          .shadow(color: Color.black.opacity(0.12), radius: 12, y: 4)
          .padding(.top, 10)
          .transition(.move(edge: .top).combined(with: .opacity))
          .accessibilityHidden(true)
      }
    }
    .animation(.spring(response: 0.35, dampingFraction: 0.85), value: message)
    .allowsHitTesting(false)
  }
}

extension NativeAskModel {
  /// Whether a starter or follow-up can be sent right now.
  var canAsk: Bool {
    guard !sending, !loadingConversation else { return false }
    if provider == .appleOnDevice { return appleAvailable }
    return signedIn && consented && !(usage?.exhausted ?? false)
  }
}
