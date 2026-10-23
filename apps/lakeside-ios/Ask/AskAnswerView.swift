import SwiftUI
import LakesideCore

/// One question and its answer: question, answer body, evidence, actions.
struct AskTurnView: View {
    let turn: ChatTurn
    let streaming: Bool
    let status: String
    let base: URL
    let liveUpgradeCost: String
    var onCopy: () -> Void
    var onHelpful: () -> Void
    var onReport: () -> Void
    var onAskWithLiveData: () -> Void
    @ScaledMetric(relativeTo: .caption) private var markSize: CGFloat = 18

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            question
            HStack(spacing: 8) {
                BrandMark(surface: .ask, size: markSize).accessibilityHidden(true)
                AskLabel(text: "Ask", color: Brand.ink)
                if turn.local { AskLabel(text: "On device", color: Brand.mint) }
                else if turn.metadata["usedMcp"].bool || !turn.liveSources.isEmpty { AskLabel(text: "Live data", color: Brand.mint) }
                Spacer(minLength: 8)
                if !turn.model.isEmpty {
                    Text(turn.model).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        .accessibilityLabel("Answered by \(turn.model)")
                }
            }
            if !turn.answer.isEmpty {
                NativeMarkdown(text: turn.answer, streaming: streaming)
                    .font(.body).lineSpacing(2)
            }
            if streaming {
                AskResearchConsole(research: turn.research, status: status, hasAnswer: !turn.answer.isEmpty)
            }
            if let stopped = turn.stopped { stoppedNote(stopped) }
            if turn.local && !streaming && !turn.answer.isEmpty { onDeviceFooter }
            if !streaming { AskEvidenceView(turn: turn, base: base) }
            if turn.metadata["cached"].bool {
                Label("Saved answer. No credits used.", systemImage: "clock.arrow.circlepath").font(.caption).foregroundStyle(.secondary)
            }
            if let reportURL = Endpoint.link(turn.reportURL, base: base) {
                HStack(spacing: 12) {
                    Link(destination: reportURL) { Label("Open report", systemImage: "doc.richtext") }
                    ShareLink(item: reportURL) { Label("Share report", systemImage: "square.and.arrow.up") }
                }.font(.footnote.weight(.semibold))
            }
            if !turn.answer.isEmpty && !streaming { actions }
        }
    }

    private var question: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(turn.attachments.enumerated()), id: \.offset) { _, file in
                Label(file["name"].string.nonempty ?? "Attachment", systemImage: "paperclip").font(.caption).foregroundStyle(.secondary)
            }
            Text(turn.question).font(.headline).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Brand.raised, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You asked: \(turn.question)")
    }

    @ViewBuilder private func stoppedNote(_ outcome: ChatTurn.StopOutcome) -> some View {
        switch outcome {
        case .confirmed:
            Label("Stopped. This answer was not saved and used no credits.", systemImage: "stop.circle")
                .font(.footnote).foregroundStyle(.secondary).accessibilityIdentifier("ask-stopped")
        case .localOnly:
            Label("Stopped on this device. The server may still finish this answer and save it to the conversation.", systemImage: "stop.circle")
                .font(.footnote).foregroundStyle(.secondary).accessibilityIdentifier("ask-stopped")
        }
    }

    private var onDeviceFooter: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Generated on this device from Ask documentation. It did not read live game state and was not saved.")
                .font(.caption).foregroundStyle(.secondary)
            Button(action: onAskWithLiveData) {
                Label("Ask with live data (uses \(liveUpgradeCost))", systemImage: "bolt.fill").font(.footnote.weight(.semibold))
            }
            .buttonStyle(.bordered).tint(Brand.mint)
            .accessibilityHint("Sends this question to Ask server with live game data. It uses an outside AI service and is saved to this conversation.")
            .accessibilityIdentifier("ask-live-upgrade")
        }
    }

    private var actions: some View {
        HStack(spacing: 18) {
            Button(action: onCopy) { Image(systemName: "doc.on.doc") }.accessibilityLabel("Copy answer")
            if turn.answerID != .null {
                Button(action: onHelpful) { Image(systemName: "hand.thumbsup") }.accessibilityLabel("Mark helpful")
                Button(action: onReport) { Image(systemName: "flag") }.accessibilityLabel("Report answer")
            }
            Spacer()
        }
        .font(.callout).buttonStyle(.borderless).foregroundStyle(.secondary)
        .frame(minHeight: 32)
    }
}

/// Sources, live reads, documentation conflicts, and the research trail.
struct AskEvidenceView: View {
    let turn: ChatTurn
    let base: URL
    @State private var showAll = false
    @State private var showTrail = false
    private let collapsedCount = 4

    var body: some View {
        if !turn.citations.isEmpty || !turn.liveSources.isEmpty || !turn.conflicts.isEmpty || !turn.research.steps.isEmpty || !turn.trail.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                if !turn.citations.isEmpty { sources }
                if !turn.liveSources.isEmpty { liveReads }
                if !turn.conflicts.isEmpty { conflicts }
                if !turn.research.steps.isEmpty { AskResearchReceipt(research: turn.research) }
                else if !turn.trail.isEmpty { legacyTrail }
            }
            .padding(.top, 2)
            .overlay(alignment: .top) { Rectangle().fill(Brand.ink.opacity(0.08)).frame(height: 1).offset(y: -6) }
        }
    }

    private var sources: some View {
        let visible = showAll ? turn.citations : Array(turn.citations.prefix(collapsedCount))
        return VStack(alignment: .leading, spacing: 8) {
            AskLabel(text: "Sources · \(turn.citations.count)")
            ForEach(Array(visible.enumerated()), id: \.offset) { index, citation in
                sourceRow(index: index + 1, citation: citation)
            }
            if turn.citations.count > collapsedCount {
                Button(showAll ? "Show fewer sources" : "Show all \(turn.citations.count) sources") { showAll.toggle() }
                    .font(.footnote.weight(.semibold))
            }
        }
    }

    @ViewBuilder private func sourceRow(index: Int, citation: JSONValue) -> some View {
        let label = citation.first("label", "title", "path").nonempty ?? "Source \(index)"
        let detail = sourceDetail(citation, label: label)
        let row = HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(index)").font(.caption.monospacedDigit().weight(.semibold)).foregroundStyle(Brand.sky).frame(minWidth: 16, alignment: .trailing)
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.footnote).foregroundStyle(Brand.ink).multilineTextAlignment(.leading)
                if !detail.isEmpty { Text(detail).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle) }
            }
            Spacer(minLength: 0)
        }
        if let url = Endpoint.link(citation["url"].string, base: base) {
            Link(destination: url) { row }.accessibilityLabel("Source \(index): \(label)").accessibilityHint("Opens in the browser")
        } else {
            row.accessibilityElement(children: .combine)
        }
    }

    private func sourceDetail(_ citation: JSONValue, label: String) -> String {
        let path = citation["path"].string
        if !path.isEmpty && path != label { return path }
        if let url = Endpoint.link(citation["url"].string, base: base), let host = url.host { return host + url.path }
        return citation["kind"].string
    }

    private var liveReads: some View {
        VStack(alignment: .leading, spacing: 6) {
            AskLabel(text: "Live game data read · \(turn.liveSources.count)", color: Brand.mint)
            ForEach(Array(turn.liveSources.enumerated()), id: \.offset) { _, source in
                Label(source.first("label", "name", "tool").nonempty ?? "Live game state", systemImage: "bolt.fill")
                    .font(.footnote).foregroundStyle(Brand.ink)
            }
        }
    }

    private var conflicts: some View {
        VStack(alignment: .leading, spacing: 6) {
            AskLabel(text: "Documentation differs from the code · \(turn.conflicts.count)", color: .orange)
            ForEach(Array(turn.conflicts.enumerated()), id: \.offset) { _, conflict in
                VStack(alignment: .leading, spacing: 2) {
                    Text(conflict["claim"].string.nonempty ?? conflict["source"].string).font(.footnote)
                    if !conflict["actual"].string.isEmpty { Text("Code: \(conflict["actual"].string)").font(.caption).foregroundStyle(.secondary) }
                }.accessibilityElement(children: .combine)
            }
        }
    }

    /// Older servers only narrate phases, with no tool calls. Keep that account
    /// rather than showing an empty receipt.
    private var legacyTrail: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { showTrail.toggle() } label: {
                HStack(spacing: 6) {
                    AskLabel(text: "Research trail · \(turn.trail.count) steps")
                    Image(systemName: showTrail ? "chevron.up" : "chevron.down").font(.caption2).foregroundStyle(.secondary)
                }
            }.buttonStyle(.plain).accessibilityValue(showTrail ? "Expanded" : "Collapsed")
            if showTrail {
                ForEach(Array(turn.trail.enumerated()), id: \.offset) { index, label in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(index + 1)").font(.caption2.monospacedDigit()).foregroundStyle(Brand.mint).frame(minWidth: 16, alignment: .trailing)
                        Text(label).font(.caption)
                    }
                }
            }
        }
    }
}
