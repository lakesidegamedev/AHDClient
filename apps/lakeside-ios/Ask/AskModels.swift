import SwiftUI
import UIKit
import LakesideCore

/// Where the player's permission for outside AI services is stored.
enum AskConsentStore {
    static let key = "lakeside.ask.aiConsent"
    static let privacyURL = URL(string: "https://ask.lakesidegames.net/privacy")

    static func granted(_ recipients: [AIRecipient]) -> Bool {
        UserDefaults.standard.string(forKey: key) == AIConsent.signature(recipients)
    }
    static func grant(_ recipients: [AIRecipient]) {
        UserDefaults.standard.set(AIConsent.signature(recipients), forKey: key)
    }
    static func withdraw() {
        UserDefaults.standard.removeObject(forKey: key)
    }
    /// True when permission was given for an earlier list of services.
    static var hasEarlierGrant: Bool { UserDefaults.standard.string(forKey: key) != nil }
}

/// Endpoints added in Ask 3.0.0. Each one is hidden when the server answers
/// 404, so the app keeps working against older servers.
@MainActor final class AskFeatures: ObservableObject {
    enum State: Equatable { case unknown, available, unavailable }
    @Published var watches: State = .unknown
    @Published var reports: State = .unknown
    @Published var watchItems: [JSONValue] = []
    @Published var watchLimit: Int?
    @Published var watchEvents: [JSONValue] = []
    @Published var reportItems: [JSONValue] = []

    func refresh(_ session: AppSession) async {
        let watchList = await load(session, "/api/watches")
        let reportList = await load(session, "/api/reports")
        apply(watchList, state: \.watches) { value in applyWatches(value) }
        apply(reportList, state: \.reports) { value in reportItems = value["reports"].array }
    }

    func refreshWatches(_ session: AppSession) async throws {
        let value = try await session.get("/api/watches")
        watches = .available
        applyWatches(value)
    }

    private func applyWatches(_ value: JSONValue) {
        watchItems = value["watches"].array
        watchLimit = value["limit"].number.map { Int($0) }
        watchEvents = value["events"].array
    }

    func refreshReports(_ session: AppSession) async throws {
        let value = try await session.get("/api/reports")
        reports = .available
        reportItems = value["reports"].array
    }

    private enum Outcome { case value(JSONValue), missing, failed }

    private func load(_ session: AppSession, _ path: String) async -> Outcome {
        do { return .value(try await session.get(path)) }
        catch {
            if error.failureKind == .some(.notFound) { return .missing }
            return .failed
        }
    }

    private func apply(_ outcome: Outcome, state: ReferenceWritableKeyPath<AskFeatures, State>, update: (JSONValue) -> Void) {
        switch outcome {
        case .value(let value): self[keyPath: state] = .available; update(value)
        case .missing: self[keyPath: state] = .unavailable
        case .failed: break
        }
    }
}

struct ChatTurn: Identifiable {
    var id: String
    var question: String
    var answer: String
    var citations: [JSONValue] = []
    var liveSources: [JSONValue] = []
    var conflicts: [JSONValue] = []
    var answerID: JSONValue = .null
    var reportURL: String = ""
    var model: String = ""
    var local = false
    var stopped: StopOutcome?
    /// Status narration from older servers. Kept as a fallback for a stream
    /// that predates structured research steps.
    var trail: [String] = []
    var research = ResearchTrail()
    var metadata: JSONValue = .null
    var attachments: [JSONValue] = []

    enum StopOutcome { case confirmed, localOnly }

    /// "Model · Service" so every answer names who wrote it.
    static func modelLabel(_ value: JSONValue) -> String {
        let model = value.first("modelName", "modelId", "model")
        let provider = value["providerName"].string
        if !model.isEmpty, !provider.isEmpty, provider != model { return "\(model) · \(provider)" }
        return model
    }

    init(id: String, question: String, answer: String, attachments: [JSONValue] = []) {
        self.id = id
        self.question = question
        self.answer = answer
        self.attachments = attachments
    }

    /// A saved turn from GET /api/conversation.
    init(saved value: JSONValue) {
        let identifier = value["id"].string
        self.init(id: identifier.isEmpty ? UUID().uuidString : identifier, question: value["question"].string, answer: value["answer"].string,
                  attachments: value["attachments"].array)
        citations = value["citations"].array
        answerID = value["id"]
        model = ChatTurn.modelLabel(value)
        metadata = value
    }

    var exportTurn: ExportTurn {
        ExportTurn(question: question, answer: answer, model: model,
                   sources: (citations + liveSources).map { ExportSource(label: $0.first("label", "title", "path"), url: $0["url"].string) })
    }
}

/// One tool call in the research pass.
///
/// The server announces each call twice, under one id: a start carrying the
/// human verb, kind and target, then a completion carrying the duration, the
/// summary of what came back, and whether it found anything. Keeping that as a
/// value type means the view renders a step without re-parsing JSON, and the
/// session tests can exercise the correlation directly.
struct ResearchStep: Identifiable, Equatable {
    enum Status: Equatable { case running, done }

    let id: String
    var name: String
    var label: String
    var verb: String
    var kind: String
    var icon: String
    var target: String
    var phase: String
    var status: Status
    var ok: Bool?
    var summary: String
    var milliseconds: Int

    init?(event: JSONValue, fallbackPhase: String = "") {
        let identifier = event["id"].string
        let name = event["name"].string
        let verb = event["verb"].string
        let label = event["label"].string
        guard !identifier.isEmpty || !name.isEmpty || !verb.isEmpty || !label.isEmpty else { return nil }
        id = identifier.isEmpty ? "local-\(UUID().uuidString)" : identifier
        self.name = name
        self.label = label
        self.verb = verb
        kind = event["kind"].string
        icon = event["icon"].string
        target = event["target"].string
        let kindPhase = ResearchStep.phase(for: kind)
        let declared = event["phase"].string
        phase = !declared.isEmpty ? declared : (!kindPhase.isEmpty ? kindPhase : fallbackPhase)
        status = event["state"].string == "end" ? .done : .running
        ok = event["ok"] == .null ? nil : event["ok"].bool
        summary = event["summary"].string
        milliseconds = max(0, Int(event["ms"].number ?? 0))
    }

    /// What the player reads. The verb comes from the server's vocabulary; a
    /// legacy single-shot event only has its old `tool(query)` label.
    var title: String {
        if !verb.isEmpty { return verb }
        if !label.isEmpty { return label }
        return name.isEmpty ? "Research step" : name
    }

    var missed: Bool { status == .done && ok == false }

    var durationText: String? {
        guard status == .done else { return nil }
        if milliseconds < 950 { return "\(max(1, milliseconds))ms" }
        return String(format: "%.1fs", Double(milliseconds) / 1000)
    }

    var symbol: String {
        let key = icon.isEmpty ? ResearchStep.icon(for: name) : icon
        return switch key {
        case "search": "magnifyingglass"
        case "file": "doc.text"
        case "history": "clock.arrow.circlepath"
        case "corp": "building.2"
        case "ballot": "checkmark.rectangle"
        case "chart": "chart.bar"
        case "globe": "globe"
        case "map": "map"
        case "person": "person"
        case "people": "person.2"
        case "math": "function"
        case "list": "list.bullet"
        case "docs": "book.closed"
        case "flag": "flag"
        case "market": "chart.line.uptrend.xyaxis"
        case "live": "bolt"
        default: "wrench.and.screwdriver"
        }
    }

    /// Older servers send only a tool name, so its family stands in for the icon.
    static func icon(for name: String) -> String {
        let value = name.lowercased()
        if value.contains("search") || value.contains("grep") { return "search" }
        if value.contains("read") { return "file" }
        if value.contains("history") || value.contains("change") { return "history" }
        if value.contains("corp") || value.contains("sector") { return "corp" }
        if value.contains("elect") || value.contains("race") { return "ballot" }
        if value.contains("map") || value.contains("geo") { return "map" }
        if value.contains("countr") || value.contains("globe") { return "globe" }
        if value.contains("character") || value.contains("player") { return "person" }
        return "tool"
    }

    mutating func settle(_ event: JSONValue) {
        status = .done
        if event["ok"] != .null { ok = event["ok"].bool }
        if event["ms"] != .null { milliseconds = max(0, Int(event["ms"].number ?? 0)) }
        if !event["summary"].string.isEmpty { summary = event["summary"].string }
    }

    var accessibilityLabel: String {
        var parts = [title]
        if let target = target.nonempty { parts.append(target) }
        if status == .running { parts.append("working") }
        else if let outcome = summary.nonempty { parts.append(outcome) }
        return parts.joined(separator: ", ")
    }

    static func phase(for kind: String) -> String {
        switch kind {
        case "source": "search"
        case "file": "read"
        case "history": "history"
        case "live": "live"
        case "community": "community"
        case "math": "think"
        case "catalogue": "think"
        default: ""
        }
    }
}

/// The research pass as the player sees it: one ordered set of steps with the
/// same start/end correlation the server uses. Durations are measured on the
/// device from the first step to the first answer token, which is the wait the
/// player actually experienced.
struct ResearchTrail: Equatable {
    private(set) var steps: [ResearchStep] = []
    var phase: String = ""
    var startedAt: Date?
    var finishedAt: Date?
    static let limit = 60

    mutating func apply(_ event: JSONValue, at now: Date = Date()) {
        let state = event["state"].string
        if state == "end" {
            if let identifier = event["id"].string.nonempty,
               let index = steps.lastIndex(where: { $0.id == identifier }) {
                steps[index].settle(event)
            } else if var orphan = ResearchStep(event: event, fallbackPhase: phase) {
                // A completion without its start (a dropped frame, or an older
                // server) still settles into a row rather than a silent gap.
                orphan.status = .done
                if startedAt == nil { startedAt = now }
                steps.append(orphan)
            }
            return
        }
        if state == "start" {
            guard steps.count < Self.limit, let step = ResearchStep(event: event, fallbackPhase: phase) else { return }
            if startedAt == nil { startedAt = now }
            if phase.isEmpty { phase = step.phase }
            steps.append(step)
            return
        }
        // A single event from an older server: already finished by the time it
        // arrives, and its label is the old `tool(query)` form.
        guard steps.count < Self.limit, var legacy = ResearchStep(event: event, fallbackPhase: phase) else { return }
        legacy.status = .done
        if startedAt == nil { startedAt = now }
        steps.append(legacy)
    }

    func durationText(at now: Date = Date()) -> String? {
        guard let startedAt else { return nil }
        let seconds = max(0, (finishedAt ?? now).timeIntervalSince(startedAt))
        return ResearchTrail.duration(seconds)
    }

    static func duration(_ seconds: TimeInterval) -> String {
        if seconds < 10 { return String(format: "%.1fs", seconds) }
        return "\(Int(seconds.rounded()))s"
    }

    var tally: ResearchTally {
        var value = ResearchTally(steps: steps.count)
        for step in steps {
            switch step.kind {
            case "source": value.searches += 1
            case "file": value.files += 1
            case "history": value.history += 1
            case "live": value.live += 1
            case "community": value.community += 1
            case "math": value.calculations += 1
            default: break
            }
            if step.missed { value.misses += 1 }
        }
        if let startedAt {
            value.seconds = Int(((finishedAt ?? Date()).timeIntervalSince(startedAt)).rounded())
        }
        return value
    }

    /// Consecutive steps with the same phase, in the order the phases happened.
    var groups: [ResearchGroup] {
        var result: [ResearchGroup] = []
        for step in steps {
            if let last = result.last, last.phase == step.phase {
                result[result.count - 1] = ResearchGroup(phase: last.phase, steps: last.steps + [step])
            } else {
                result.append(ResearchGroup(phase: step.phase, steps: [step]))
            }
        }
        return result
    }

    static func phaseTitle(_ key: String) -> String {
        switch key {
        case "think": "Thinking"
        case "search": "Searching"
        case "read": "Reading"
        case "history": "Change history"
        case "live": "Live game data"
        case "community": "Community"
        case "write": "Writing"
        case "check": "Checking"
        default: "Researching"
        }
    }
}

struct ResearchGroup: Identifiable, Equatable {
    let phase: String
    let steps: [ResearchStep]
    var id: String { "\(phase)-\(steps.first?.id ?? "")" }
}

struct ResearchTally: Equatable {
    var steps = 0
    var searches = 0
    var files = 0
    var history = 0
    var live = 0
    var community = 0
    var calculations = 0
    var misses = 0
    var seconds = 0

    var line: String {
        var parts: [String] = []
        if searches > 0 { parts.append("\(searches) search\(searches == 1 ? "" : "es")") }
        if files > 0 { parts.append("\(files) file\(files == 1 ? "" : "s") read") }
        if history > 0 { parts.append("\(history) history check\(history == 1 ? "" : "s")") }
        if live > 0 { parts.append("\(live) live read\(live == 1 ? "" : "s")") }
        if community > 0 { parts.append("\(community) community search\(community == 1 ? "" : "es")") }
        if calculations > 0 { parts.append("\(calculations) calculation\(calculations == 1 ? "" : "s")") }
        return parts.joined(separator: " · ")
    }
}

enum AskRoute: Hashable {
    case conversation(id: String, prompt: String, live: Bool)
    case watches
    case reports
    case settings
}

/// One failure, shaped for display.
struct AskProblem: Equatable {
    var title: String
    var message: String
    var kind: FailureKind?

    init(_ error: Error) {
        kind = error.failureKind
        title = kind?.title ?? "Something went wrong"
        message = error.displayMessage
    }

    init(title: String, message: String) {
        self.title = title
        self.message = message
        kind = nil
    }

    var symbol: String {
        switch kind {
        case .some(.network): return "wifi.exclamationmark"
        case .some(.quotaExhausted), .some(.rateLimited): return "hourglass"
        case .some(.signedOut): return "person.crop.circle.badge.exclamationmark"
        default: return "exclamationmark.triangle"
        }
    }
}

struct ProblemBanner: View {
    let problem: AskProblem
    var retry: (() -> Void)?
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: problem.symbol).foregroundStyle(.orange).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(problem.title).font(.subheadline.weight(.semibold))
                Text(problem.message).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if let retry {
                    Button("Try again", action: retry).font(.footnote.weight(.semibold)).padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.orange.opacity(0.35), lineWidth: 1))
    }
}

/// Small uppercase monospaced label used for section and metadata headings.
struct AskLabel: View {
    let text: String
    var color: Color = .secondary
    var body: some View {
        Text(text.uppercased()).font(.caption2.monospaced().weight(.semibold)).tracking(0.8).foregroundStyle(color)
    }
}

enum AskAnnouncer {
    static func say(_ text: String) {
        UIAccessibility.post(notification: .announcement, argument: text)
    }
}
