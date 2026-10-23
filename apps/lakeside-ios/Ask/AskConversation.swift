import SwiftUI
import UIKit
import LakesideCore

struct AskConversation: View {
    @StateObject private var attachments = ChatAttachments()
    let initialID: String
    var initialQuestion: String = ""
    var initialLive: Bool? = nil
    @EnvironmentObject private var session: AppSession
    @Environment(\.scenePhase) private var scenePhase
    @State private var conversationID = ""
    @State private var requestID = ""
    @State private var clientRequestID = ""
    @State private var activeIsLocal = false
    @State private var activeTurnID = ""
    @State private var pendingQuestion: String?
    @State private var turns: [ChatTurn] = []
    @State private var draft = ""
    @State private var status = ""
    @State private var problem: AskProblem?
    @State private var notice: String?
    @State private var loading = true
    @State private var streamTask: Task<Void, Never>?
    @State private var streaming = false
    @State private var stopping = false
    @State private var games: [JSONValue] = []
    @AppStorage("ask.game") private var game = "ahd"
    @AppStorage("ask.live") private var live = false
    @AppStorage("ask.length") private var length = "standard"
    @AppStorage("ask.style") private var style = "standard"
    @AppStorage("ask.effort") private var effort = "auto"
    @AppStorage("ask.visualizations") private var visualizations = true
    @AppStorage("ask.provider") private var providerSetting = AskProvider.server.rawValue
    @State private var mode: AskMode = .auto
    @State private var options = false
    @State private var sharing = false
    @State private var nextCost: JSONValue = .null
    @State private var followups: [String] = []
    @State private var reportReason = ""
    @State private var feedbackTurn: ChatTurn?
    @State private var consentShown = false
    @State private var pendingSend: (() -> Void)?
    @State private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    @State private var backgroundedDuringStream = false
    @State private var needsRecovery = false
    @State private var recovering = false
    @State private var canCheckAgain = false
    @FocusState private var focused: Bool
    @ScaledMetric(relativeTo: .title2) private var sendSize: CGFloat = 30

    private var provider: AskProvider {
        let chosen = AskProvider(rawValue: providerSetting) ?? .server
        return chosen == .appleOnDevice && !AppleFoundationModelProvider.isAvailable ? .server : chosen
    }
    private var cost: NextCost { NextCost(nextCost) }
    private var questionCount: Int { QuestionLimit.count(draft) }
    private var canSend: Bool {
        !loading && !attachments.uploading && !streaming
            && (questionCount >= QuestionLimit.minimum || !attachments.items.isEmpty) && questionCount <= QuestionLimit.maximum
    }
    private var title: String { turns.first?.question ?? "Lakeside Ask conversation" }
    /// The price of re-asking an on-device question on the server. A new
    /// server thread costs one question.
    private var liveUpgradeCost: String {
        guard let value = cost.cost, value != 1, let label = cost.costLabel else { return "1 question" }
        return label
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 26) {
                    if provider == .appleOnDevice {
                        Label("On-device mode. Ask finds matching documentation for your question, then this device writes the answer. Nothing goes to outside AI services and nothing is saved.", systemImage: "iphone")
                            .font(.footnote).foregroundStyle(.secondary)
                            .accessibilityIdentifier("ask-on-device-banner")
                    }
                    if turns.isEmpty && !loading { emptyState }
                    ForEach(turns) { turn in
                        AskTurnView(
                            turn: turn,
                            streaming: streaming && turn.id == activeTurnID,
                            status: status,
                            base: session.surface.base,
                            liveUpgradeCost: liveUpgradeCost,
                            onCopy: { UIPasteboard.general.string = turn.answer; notice = "Answer copied." },
                            onHelpful: { feedback(turn, rating: "up") },
                            onReport: { feedbackTurn = turn },
                            onAskWithLiveData: { send(turn.question, forceServer: true, liveOverride: true) }
                        ).id(turn.id)
                    }
                    if recovering {
                        HStack(spacing: 8) { ProgressView(); Text("Checking the server for your answer…").font(.footnote).foregroundStyle(.secondary) }
                    }
                    if let notice {
                        Label(notice, systemImage: "info.circle").font(.footnote).foregroundStyle(.secondary)
                            .accessibilityIdentifier("ask-notice")
                    }
                    if canCheckAgain && !recovering {
                        Button("Check again") { Task { await recover() } }.font(.footnote.weight(.semibold))
                    }
                    if let problem {
                        if problem.kind == .some(.network) && !conversationID.isEmpty && !streaming {
                            ProblemBanner(problem: problem) { _ = Task { await loadTurns() } }
                        } else {
                            ProblemBanner(problem: problem)
                        }
                    }
                    if !streaming && !followups.isEmpty { followupChips }
                    Color.clear.frame(height: 1).id("bottom")
                }.padding(.horizontal, 16).padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: turns.count) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: streaming) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: focused) { _, active in if active { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } } }
            .safeAreaInset(edge: .bottom) { composer }
        }
        .lakesideScreen().navigationTitle("Ask").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { BrandHeader(surface: .ask, compact: true) }
            ToolbarItem(placement: .topBarTrailing) { UsageButton() }
            ToolbarItem(placement: .topBarTrailing) {
                Button { options = true } label: { Image(systemName: "slider.horizontal.3") }.disabled(streaming).accessibilityLabel("Answer options")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { sharing = true } label: { Image(systemName: "square.and.arrow.up") }.disabled(turns.isEmpty || streaming).accessibilityLabel("Share conversation")
            }
        }
        .sheet(isPresented: $options) {
            NavigationStack { AskOptionsView(game: $game, live: $live, visualizations: $visualizations, style: $style, length: $length, effort: $effort, provider: $providerSetting, games: games, hasAttachments: !attachments.items.isEmpty) }
        }
        .sheet(isPresented: $sharing) {
            NavigationStack {
                ConversationSharing(id: conversationID, title: title, markdown: ConversationExport.markdown(title: title, turns: turns.filter { !$0.answer.isEmpty }.map(\.exportTurn)),
                                    serverBacked: turns.contains { !$0.local && $0.answerID != .null })
            }
        }
        .sheet(isPresented: $consentShown, onDismiss: { pendingSend = nil }) {
            NavigationStack {
                AIConsentSheet { allowed in
                    let next = pendingSend
                    pendingSend = nil
                    if allowed, let next { DispatchQueue.main.async { next() } }
                }
            }
        }
        .task {
            conversationID = initialID
            if draft.isEmpty { draft = initialQuestion }
            if let initialLive { live = initialLive }
            await loadTurns()
            if let list = try? await session.get("/api/games") { games = list["games"].array }
            await refreshCost()
        }
        .onDisappear { leave() }
        .onChange(of: attachments.items.count) { _, count in
            if count > 0 && provider == .appleOnDevice {
                providerSetting = AskProvider.server.rawValue
                notice = "On-device answers do not support attachments, so Ask server is selected."
            }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: if streaming { beginBackgroundGrace() }
            case .active:
                endBackgroundGrace()
                if needsRecovery { Task { await recover() } }
            default: break
            }
        }
        .alert("Report this answer", isPresented: Binding(get: { feedbackTurn != nil }, set: { if !$0 { feedbackTurn = nil } })) {
            TextField("What was wrong?", text: $reportReason)
            Button("Cancel", role: .cancel) { feedbackTurn = nil; reportReason = "" }
            Button("Submit report") { if let turn = feedbackTurn { feedback(turn, rating: "down", reason: reportReason) }; feedbackTurn = nil; reportReason = "" }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 10) {
            AskLabel(text: games.first(where: { $0["id"].string == game })?["name"].string ?? "A House Divided", color: Brand.sky)
            Text("Ask about mechanics, current game state, or how systems connect.").font(.title3.weight(.semibold))
            Text("Answers cite the code and documentation they used. Turn on live data for questions about the current world.")
                .font(.callout).foregroundStyle(.secondary)
        }.padding(.vertical, 12)
    }

    private var followupChips: some View {
        VStack(alignment: .leading, spacing: 8) {
            AskLabel(text: "Follow up")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(followups, id: \.self) { suggestion in
                        Button { draft = suggestion; focused = true } label: {
                            Text(suggestion).font(.footnote).lineLimit(2).multilineTextAlignment(.leading)
                                .padding(.horizontal, 12).padding(.vertical, 8).frame(maxWidth: 260, alignment: .leading)
                                .background(Brand.raised, in: RoundedRectangle(cornerRadius: 8))
                        }.buttonStyle(.plain).accessibilityHint("Puts this follow-up in the question field")
                    }
                }
            }
            if let label = cost.followupLabel { Text(label).font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
        }
    }

    // MARK: Composer

    private var composer: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Menu {
                    Picker("Answer mode", selection: $mode) {
                        ForEach(AskMode.allCases, id: \.self) { choice in Label(choice.title, systemImage: choice.symbol).tag(choice) }
                    }
                } label: {
                    chip(mode.title, symbol: mode.symbol, active: mode != .auto, color: Brand.sky)
                }.accessibilityLabel("Answer mode").accessibilityValue(mode.title).accessibilityIdentifier("ask-mode-menu")
                if provider == .server {
                    Button { live.toggle() } label: { chip("Live", symbol: live ? "bolt.fill" : "bolt", active: live, color: Brand.mint) }
                        .accessibilityLabel("Live game data").accessibilityValue(live ? "On" : "Off").accessibilityIdentifier("ask-live-toggle")
                } else {
                    Button { options = true } label: { chip("On device", symbol: "iphone", active: true, color: Brand.mint) }
                        .accessibilityLabel("Answer engine").accessibilityValue("Apple on-device")
                }
                Menu {
                    Picker("Length", selection: $length) {
                        Text("Concise").tag("concise"); Text("Standard").tag("standard"); Text("Deep").tag("deep")
                    }
                } label: { chip(length.capitalized, symbol: "text.alignleft", active: length != "standard", color: Brand.sky) }
                    .accessibilityLabel("Answer length").accessibilityValue(length.capitalized)
                Spacer(minLength: 0)
                if provider == .server, let label = cost.costLabel {
                    Text(label).font(.caption2.monospacedDigit()).foregroundStyle(.secondary).lineLimit(1)
                        .accessibilityLabel("Next question costs \(label)")
                }
            }.disabled(streaming)
            AttachmentTray(attachments: attachments).disabled(streaming)
            HStack(alignment: .bottom, spacing: 10) {
                if provider == .server { AttachmentPicker(attachments: attachments).labelStyle(.iconOnly).disabled(streaming) }
                TextField(mode == .report ? "What should the report cover?" : "Ask a question…", text: $draft, axis: .vertical)
                    .lineLimit(1...6).focused($focused)
                    .accessibilityIdentifier("ask-composer")
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(Brand.surface, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(questionCount > QuestionLimit.maximum ? Color.red.opacity(0.7) : Brand.ink.opacity(0.12)))
                    .disabled(streaming)
                    .onSubmit { if canSend { send() } }
                if streaming {
                    Button { Task { await stop() } } label: { Image(systemName: "stop.circle.fill").font(.system(size: sendSize)) }
                        .disabled(stopping).accessibilityLabel("Stop answer").accessibilityIdentifier("ask-stop")
                } else {
                    Button { send() } label: { Image(systemName: "arrow.up.circle.fill").font(.system(size: sendSize)) }
                        .disabled(!canSend).accessibilityLabel("Send question")
                }
            }
            HStack(alignment: .firstTextBaseline) {
                Text(mode == .auto ? "" : mode.hint).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                Spacer(minLength: 8)
                if !draft.isEmpty {
                    Text("\(questionCount)/\(QuestionLimit.maximum)").font(.caption2.monospacedDigit())
                        .foregroundStyle(questionCount > QuestionLimit.maximum ? Color.red : Color.secondary)
                        .accessibilityLabel("\(questionCount) of \(QuestionLimit.maximum) characters")
                        .accessibilityIdentifier("ask-counter")
                }
            }
        }
        .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 8)
        .background(Brand.background)
        .overlay(alignment: .top) { Rectangle().fill(Brand.ink.opacity(0.08)).frame(height: 1) }
    }

    private func chip(_ text: String, symbol: String, active: Bool, color: Color) -> some View {
        Label(text, systemImage: symbol).font(.caption.weight(.semibold)).lineLimit(1)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .foregroundStyle(active ? color : Brand.ink.opacity(0.8))
            .background(active ? color.opacity(0.14) : Brand.raised, in: RoundedRectangle(cornerRadius: 6))
    }

    // MARK: Data

    private func refreshCost() async {
        guard provider == .server || !turns.isEmpty else { return }
        do { nextCost = try await session.get("/api/nextcost", query: ["convId": conversationID]) }
        catch { if !Task.isCancelled { nextCost = .null } }
    }

    private func loadTurns() async {
        loading = true; defer { loading = false }
        guard !conversationID.isEmpty else { return }
        do {
            let data = try await session.get("/api/conversation", query: ["id": conversationID])
            turns = data["turns"].array.map(ChatTurn.init(saved:))
            problem = nil
        } catch { if !Task.isCancelled { problem = AskProblem(error) } }
    }

    /// Builds the question exactly as the server will measure it.
    private func prepared(_ text: String) -> String {
        var question = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if QuestionLimit.count(question) < QuestionLimit.minimum && !attachments.items.isEmpty {
            question = question.isEmpty ? "Please examine the attached files." : question + "\nPlease examine the attached files."
        }
        if mode == .report && question.range(of: #"\breport\b"#, options: [.regularExpression, .caseInsensitive]) == nil {
            question = "Write a report on " + question
        }
        return question
    }

    private func send(_ override: String? = nil, forceServer: Bool = false, liveOverride: Bool? = nil) {
        let question = prepared(override ?? draft)
        guard !streaming, !attachments.uploading else { return }
        guard QuestionLimit.fits(question) else {
            problem = AskProblem(title: "Question length", message: "Questions must be \(QuestionLimit.minimum) to \(QuestionLimit.maximum) characters. This one is \(QuestionLimit.count(question)).")
            return
        }
        // Reports are built by Ask server with live data, never on the device.
        let route: AskProvider = forceServer || mode == .report ? .server : provider
        if route == .server && !AskConsentStore.granted(AIConsent.recipients(from: session.profile)) {
            pendingSend = { send(override, forceServer: forceServer, liveOverride: liveOverride) }
            consentShown = true
            return
        }
        if route == .appleOnDevice && !attachments.items.isEmpty {
            problem = AskProblem(title: "Attachments", message: "On-device answers do not support attachments. Remove them or choose Ask server.")
            return
        }
        if override == nil { draft = "" }
        problem = nil; notice = nil; canCheckAgain = false; followups = []; focused = false
        streaming = true; requestID = ""; status = "Thinking…"; backgroundedDuringStream = false
        let turnID = UUID().uuidString
        activeTurnID = turnID
        activeIsLocal = route == .appleOnDevice
        clientRequestID = ""
        turns.append(ChatTurn(id: turnID, question: question, answer: "", attachments: route == .server ? attachments.payload.array : []))
        if route == .appleOnDevice { answerOnDevice(question, turnID: turnID) }
        else { answerOnServer(question, turnID: turnID, useLive: liveOverride ?? live) }
    }

    private func answerOnDevice(_ question: String, turnID: String) {
        let history = turns.dropLast().suffix(OnDeviceBudget.historyTurns).map { "User: \($0.question)\nAssistant: \(String($0.answer.prefix(1200)))" }
        let selectedGame = game, selectedLength = length, selectedStyle = style, selectedMode = mode.serverMode, charts = visualizations
        streamTask = Task {
            defer { finishStream(turnID) }
            do {
                status = "Finding documentation…"
                let context = try await session.post("/api/ask/context", ["question": .string(question), "game": .string(selectedGame)])
                let evidence = context["context"].string
                guard !evidence.isEmpty else { throw AppFailure(message: "Ask could not load game documentation. Try again or choose Ask server.") }
                status = "Generating on device…"
                let response = try await AppleFoundationModelProvider.respond(
                    question: question, history: Array(history),
                    gameName: context["game"]["name"].string.nonempty ?? selectedGame,
                    gameSubject: context["game"]["subject"].string.nonempty ?? "the selected game",
                    gameEvidence: evidence, length: selectedLength, style: selectedStyle, mode: selectedMode,
                    allowVisualizations: charts)
                guard let index = turns.firstIndex(where: { $0.id == turnID }) else { return }
                turns[index].answer = response.text
                turns[index].model = response.modelName
                // `files` lists document paths as plain strings.
                turns[index].citations = context["files"].array.map { file -> JSONValue in
                    file.object.isEmpty ? .object(["label": file, "path": file]) : file
                }
                turns[index].local = true
                AskAnnouncer.say("Answer ready")
            } catch {
                guard !Task.isCancelled, !(error is CancellationError) else {
                    if let index = turns.firstIndex(where: { $0.id == turnID }), turns[index].answer.isEmpty { turns.remove(at: index) }
                    return
                }
                problem = AskProblem(error)
                if let index = turns.firstIndex(where: { $0.id == turnID }), turns[index].answer.isEmpty {
                    turns.remove(at: index); if draft.isEmpty { draft = question }
                }
            }
        }
    }

    private func answerOnServer(_ question: String, turnID: String, useLive: Bool) {
        if conversationID.isEmpty { conversationID = ClientID.make() }
        let requestKey = ClientID.make(length: 24)
        clientRequestID = requestKey
        let asReport = mode == .report
        pendingQuestion = question
        let body: [String: JSONValue] = [
            "question": .string(question), "convId": .string(conversationID), "game": .string(game), "useMcp": .bool(useLive),
            "length": .string(length), "style": .string(style), "effort": .string(effort), "visualizations": .bool(visualizations),
            "mode": .string(mode.serverMode), "tz": .string(TimeZone.current.identifier), "attachments": attachments.payload,
            // Ask 3.0.0 lets Stop work before `meta` arrives. Older servers
            // ignore the field and still accept the `reqId` from `meta`.
            "clientReqId": .string(requestKey),
            "report": .bool(asReport),
        ]
        streamTask = Task {
            defer { finishStream(turnID) }
            do {
                try await session.stream(body) { event in
                    let data = try JSONValue.parse(event.data)
                    guard let index = turns.firstIndex(where: { $0.id == turnID }) else { return }
                    switch event.name {
                    case "meta":
                        if !data["convId"].string.isEmpty { conversationID = data["convId"].string }
                        requestID = data["reqId"].string
                        status = data["status"].string.nonempty ?? status
                        let model = ChatTurn.modelLabel(data)
                        if !model.isEmpty { turns[index].model = model }
                    case "status":
                        status = data["label"].string.nonempty ?? status
                        let model = ChatTurn.modelLabel(data)
                        if !model.isEmpty { turns[index].model = model }
                        if let phase = data["phase"].string.nonempty { turns[index].research.phase = phase }
                        if let label = data["label"].string.nonempty, turns[index].trail.count < 80 { turns[index].trail.append(label) }
                    case "action":
                        // Start and completion arrive under one id. The model
                        // correlates them, so the view never has to guess which
                        // row a late result belongs to. The narration line stays
                        // the server's phase sentence, not a raw tool label.
                        turns[index].research.apply(data)
                    case "delta":
                        if turns[index].research.finishedAt == nil { turns[index].research.finishedAt = Date() }
                        turns[index].answer += data.string
                    case "done":
                        // Research ends when writing began; if the server never
                        // sent a delta (cached or short answers) the done event
                        // closes it instead.
                        if turns[index].research.finishedAt == nil { turns[index].research.finishedAt = Date() }
                        attachments.items.removeAll()
                        session.updateUsage(data["usage"])
                        if !data["convId"].string.isEmpty { conversationID = data["convId"].string }
                        turns[index].metadata = data
                        turns[index].answer = data["answer"].string.nonempty ?? turns[index].answer
                        turns[index].citations = data["citations"].array
                        turns[index].liveSources = data["liveSources"].array
                        turns[index].conflicts = data["conflicts"].array
                        turns[index].answerID = data["answerId"]
                        turns[index].reportURL = data["reportUrl"].string
                        let model = ChatTurn.modelLabel(data)
                        if !model.isEmpty { turns[index].model = model }
                        followups = data["followups"].array.map { $0.string.nonempty ?? $0["question"].string }.filter { !$0.isEmpty }
                        pendingQuestion = nil
                        AskAnnouncer.say("Answer ready")
                    case "stopped":
                        session.updateUsage(data["usage"])
                        turns[index].stopped = .confirmed
                        pendingQuestion = nil
                        AskAnnouncer.say("Answer stopped")
                    case "error":
                        session.updateUsage(data["usage"])
                        let kind: FailureKind = data["quota"].bool ? .quotaExhausted
                            : (data["busy"].bool || data["inFlight"].bool) ? .rateLimited : .server(500)
                        let message = data.string.nonempty ?? data.first("error", "message").nonempty
                        throw AppFailure(message: message ?? kind.defaultMessage, kind: kind)
                    default: break
                    }
                }
                await refreshCost()
            } catch {
                guard !Task.isCancelled else { return }
                if backgroundedDuringStream && error.failureKind == .some(.network) {
                    needsRecovery = true
                    if scenePhase == .active { Task { await recover() } }
                    return
                }
                problem = AskProblem(error)
                if let index = turns.firstIndex(where: { $0.id == turnID }), turns[index].answer.isEmpty {
                    turns.remove(at: index); if draft.isEmpty { draft = question }
                    pendingQuestion = nil
                }
            }
        }
    }

    /// Clears the streaming state for one answer. A cancelled stream that
    /// finishes late must not end a newer one.
    private func finishStream(_ turnID: String) {
        guard turnID == activeTurnID, streaming else { return }
        streaming = false; streamTask = nil; requestID = ""
        endBackgroundGrace()
    }

    /// Stop must reach the server before the connection closes, or the server
    /// loses track of the request and finishes the answer anyway.
    private func stop() async {
        guard streaming else { return }
        if activeIsLocal {
            // Nothing left the device, so there is nothing to stop on a server.
            streamTask?.cancel()
            finishStream(activeTurnID)
            AskAnnouncer.say("Stopped")
            return
        }
        stopping = true; defer { stopping = false }
        // The `meta` reqId works on every server. Before `meta` arrives, only
        // Ask 3.0.0 knows the client id; older servers answer ok: false.
        let key = requestID.nonempty ?? clientRequestID
        let turnID = activeTurnID
        var result = StopResult.unconfirmed
        if ClientID.isValidRequest(key) || !requestID.isEmpty {
            do { result = StopResult(try await session.post("/api/ask/stop", ["reqId": .string(key)])) } catch { result = .unconfirmed }
        }
        let confirmed = result.discarded
        streamTask?.cancel()
        finishStream(turnID)
        pendingQuestion = confirmed ? nil : pendingQuestion
        if let index = turns.firstIndex(where: { $0.id == turnID }) { turns[index].stopped = confirmed ? .confirmed : .localOnly }
        AskAnnouncer.say(confirmed ? "Answer stopped" : "Stopped on this device")
    }

    /// Leaving the screen does not stop the server. It finishes and saves the
    /// answer, which appears when the conversation is opened again.
    private func leave() {
        guard streaming else { return }
        streamTask?.cancel()
        finishStream(activeTurnID)
    }

    private func beginBackgroundGrace() {
        backgroundedDuringStream = true
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Finish Ask answer") {
            // Out of time: drop the local stream. The server keeps going and the
            // answer is fetched from the saved conversation on return.
            if streaming { streamTask?.cancel(); needsRecovery = true }
            endBackgroundGrace()
        }
    }

    private func endBackgroundGrace() {
        guard backgroundTask != .invalid else { return }
        let task = backgroundTask
        backgroundTask = .invalid
        UIApplication.shared.endBackgroundTask(task)
    }

    /// Re-reads the saved conversation after the stream was interrupted in the
    /// background, instead of reporting a failure for an answer that exists.
    private func recover() async {
        needsRecovery = false
        guard !conversationID.isEmpty, let pending = pendingQuestion else { return }
        recovering = true; canCheckAgain = false; defer { recovering = false }
        for attempt in 0..<6 {
            if attempt > 0 {
                do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
            }
            guard let data = try? await session.get("/api/conversation", query: ["id": conversationID]) else { continue }
            let saved = data["turns"].array.map(ChatTurn.init(saved:))
            if saved.contains(where: { $0.question.trimmingCharacters(in: .whitespacesAndNewlines) == pending }) {
                turns = saved
                pendingQuestion = nil; problem = nil; notice = nil
                AskAnnouncer.say("Answer ready")
                await refreshCost()
                return
            }
        }
        notice = "The answer is still being prepared on the server."
        canCheckAgain = true
    }

    private func feedback(_ turn: ChatTurn, rating: String, reason: String = "") {
        Task {
            do {
                _ = try await session.post("/api/answer/feedback", ["answerId": turn.answerID, "rating": .string(rating), "reason": .string(reason)])
                notice = rating == "up" ? "Marked helpful." : "Report sent for review."
                AskAnnouncer.say(notice ?? "")
            } catch { problem = AskProblem(error) }
        }
    }
}
