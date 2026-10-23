import SwiftUI
import LakesideCore

/// The live research console.
///
/// While Ask works, this panel is the transcript of the work: one row per tool
/// call, running and then settled with what came back and how long it took.
/// Once the answer starts writing it folds to a single line, so the research
/// never pushes the answer down the screen.
struct AskResearchConsole: View {
    let research: ResearchTrail
    let status: String
    let hasAnswer: Bool
    @State private var expanded = true
    @State private var acceptedFold = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var motion: Animation? { reduceMotion ? nil : .snappy(duration: 0.24) }
    private var phaseTitle: String {
        research.phase.isEmpty ? "" : ResearchTrail.phaseTitle(research.phase)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if expanded && !research.steps.isEmpty {
                Divider().padding(.horizontal, 12)
                steps
            }
        }
        .background(Brand.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Brand.sky.opacity(0.14)))
        .animation(motion, value: research.steps)
        .onChange(of: hasAnswer) { _, writing in
            guard writing, !acceptedFold else { return }
            acceptedFold = true
            withAnimation(motion) { expanded = false }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ask-research-console")
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            leading
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if !hasAnswer, !phaseTitle.isEmpty {
                        Text(phaseTitle.uppercased())
                            .font(.system(size: 9, weight: .bold, design: .monospaced))
                            .tracking(0.8)
                            .foregroundStyle(Brand.sky)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(Brand.sky.opacity(0.14), in: Capsule())
                            .fixedSize()
                    }
                    if !hasAnswer, let label = status.nonempty {
                        LoadingShimmer(text: label).font(.footnote).lineLimit(1).truncationMode(.tail)
                    } else if hasAnswer {
                        Text("Research").font(.footnote.weight(.semibold)).foregroundStyle(Brand.ink)
                    } else {
                        Text("Researching…").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 8) {
                    TimelineView(.periodic(from: Date(), by: 1)) { context in
                        Text(counterLine(at: context.date))
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 4)
                    Button {
                        withAnimation(motion) { expanded.toggle() }
                    } label: {
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(.caption2.weight(.semibold))
                            .frame(width: 22, height: 22)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(expanded ? "Hide research steps" : "Show research steps")
                }
            }
        }
        .padding(12)
    }

    @ViewBuilder private var leading: some View {
        if hasAnswer || research.finishedAt != nil {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Brand.mint)
                .frame(width: 20)
                .accessibilityHidden(true)
        } else {
            ProgressView().controlSize(.small).tint(Brand.sky).frame(width: 20)
                .accessibilityHidden(true)
        }
    }

    private var steps: some View {
        VStack(spacing: 0) {
            ForEach(research.steps) { step in
                ResearchStepRow(step: step)
                    .transition(reduceMotion ? .opacity : .asymmetric(
                        insertion: .move(edge: .top).combined(with: .opacity),
                        removal: .opacity))
                if step.id != research.steps.last?.id {
                    Divider().padding(.leading, 40)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
        .transition(.opacity)
    }

    private func counterLine(at now: Date) -> String {
        var parts: [String] = []
        if !research.steps.isEmpty {
            parts.append("\(research.steps.count) step\(research.steps.count == 1 ? "" : "s")")
        }
        let tally = research.tally
        if !tally.line.isEmpty { parts.append(tally.line) }
        if let duration = research.durationText(at: now) { parts.append(duration) }
        return parts.isEmpty ? "Getting started…" : parts.joined(separator: " · ")
    }
}

/// The receipt left beside a finished answer: the same trail, compact enough to
/// sit under the answer, and expandable when the player wants the detail.
struct AskResearchReceipt: View {
    let research: ResearchTrail
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var motion: Animation? { reduceMotion ? nil : .snappy(duration: 0.22) }
    private var title: String {
        let count = research.steps.count
        let duration = research.durationText()
        return "Researched \(count) step\(count == 1 ? "" : "s")" + (duration.map { " in \($0)" } ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(motion) { expanded.toggle() }
            } label: {
                HStack(spacing: 9) {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.footnote)
                        .foregroundStyle(Brand.mint)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(.footnote.weight(.semibold)).foregroundStyle(Brand.ink)
                        let tally = research.tally.line
                        if !tally.isEmpty {
                            Text(tally).font(.caption2.monospacedDigit()).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 6)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("ask-research-receipt")
            .accessibilityLabel(title)
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityHint("Shows every step Ask took and what each one found.")

            if expanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(research.groups) { group in
                        if !group.phase.isEmpty {
                            AskLabel(text: ResearchTrail.phaseTitle(group.phase), color: Brand.sky)
                                .padding(.top, 2)
                        }
                        ForEach(group.steps) { step in ResearchStepRow(step: step) }
                    }
                }
                .transition(.opacity)
            }
        }
        .padding(12)
        .background(Brand.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Brand.ink.opacity(0.06)))
    }
}

/// One line of research: what was checked, and what came back.
struct ResearchStepRow: View {
    let step: ResearchStep

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            icon
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(step.title).font(.footnote).foregroundStyle(Brand.ink).lineLimit(1)
                    if let target = step.target.nonempty {
                        Text(target)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                if let outcome = step.summary.nonempty {
                    Text(outcome)
                        .font(.caption2)
                        .foregroundStyle(step.missed ? .orange : .secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 6)
            if step.status == .running {
                ProgressView().controlSize(.mini).tint(Brand.sky)
                    .accessibilityHidden(true)
            } else if let duration = step.durationText {
                Text(duration)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 7)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(step.accessibilityLabel)
        .accessibilityIdentifier("ask-research-step")
    }

    private var icon: some View {
        ZStack {
            Circle().fill(tint.opacity(0.13))
            Image(systemName: step.missed ? "exclamationmark" : step.symbol)
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(tint)
        }
        .frame(width: 20, height: 20)
        .accessibilityHidden(true)
    }

    private var tint: Color {
        if step.missed { return .orange }
        return step.status == .running ? Brand.sky : Brand.mint
    }
}
