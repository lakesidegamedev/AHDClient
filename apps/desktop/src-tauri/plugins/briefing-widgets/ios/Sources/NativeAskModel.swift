import Foundation
import Network
import SwiftUI
import UIKit
import WebKit

/// State for the native Ask sheet. One instance lives for the whole app
/// session (NativeAskController keeps it), so the draft, the open
/// conversation and any answer still being written survive closing the sheet.
@MainActor final class NativeAskModel: ObservableObject {
  // Account and access
  @Published var provider: NativeAskProvider = .server
  @Published var signedIn = false
  @Published var accountName = ""
  @Published var connecting = true
  @Published var connected = false
  @Published var offline = false
  @Published var usage: NativeAskUsage?
  @Published var appleAvailable = false
  @Published var appleMessage = "Checking on-device answers..."
  @Published var recipients: [NativeAskRecipient] = []
  @Published var consented = false
  @Published var reviewingConsent = false

  // Conversation
  @Published var turns: [NativeAskTurn] = []
  @Published var conversationID = ""
  @Published var followupsLeft: Int?
  @Published var loadingConversation = false
  @Published var draft = ""
  @Published var draftAttachments: [NativeAskDraftAttachment] = []
  @Published var sending = false

  // History
  @Published var conversations: [NativeAskConversation] = []
  @Published var historyLoaded = false
  @Published var historyLoading = false
  @Published var historyError: String?
  @Published var showingHistory = false

  // Feedback to the player
  @Published var notice: String?
  @Published var toast: String?

  // Settings, kept between launches
  @Published var useLive: Bool {
    didSet { UserDefaults.standard.set(useLive, forKey: Self.liveKey) }
  }
  @Published var visualizations: Bool {
    didSet { UserDefaults.standard.set(visualizations, forKey: Self.chartsKey) }
  }

  // Wired by NativeAskController for each presentation.
  var onClose: (() -> Void)?
  var onLinkAccount: (() -> Void)?
  var onOpenURL: ((URL) -> Void)?
  var onShare: (([Any]) -> Void)?

  private(set) weak var webView: WKWebView?
  let isPreview: Bool
  private var api: NativeAskAPI?
  /// Cookieless client for public calls (map rendering) before sign-in.
  private var publicAPI: NativeAskAPI?
  private var connectTask: Task<Void, Never>?
  private var sendTask: Task<Void, Never>?
  private var toastTask: Task<Void, Never>?
  private var requestID: String?
  /// The turn whose answer is streaming; late events for any other turn drop.
  private var streamingTurnID: String?
  private var sheetVisible = false
  private var pendingText: [String: String] = [:]
  private var flushScheduled = false
  private var mapCache: [String: String] = [:]
  private var thumbnailCache: [String: Data] = [:]
  private let pathMonitor = NWPathMonitor()
  private var monitoring = false

  private static let liveKey = "ahdclient.ask.useLive"
  private static let chartsKey = "ahdclient.ask.visualizations"
  static let maxQuestion = 500
  static let maxAttachments = 4

  init(webView: WKWebView) {
    self.webView = webView
    self.isPreview = false
    let defaults = UserDefaults.standard
    useLive = defaults.object(forKey: Self.liveKey) as? Bool ?? true
    visualizations = defaults.object(forKey: Self.chartsKey) as? Bool ?? true
    refreshAppleStatus()
  }

  /// Canned state for screenshots. Nothing here talks to the network except
  /// map rendering, which is public on the service.
  init(preview state: String) {
    self.webView = nil
    self.isPreview = true
    useLive = true
    visualizations = true
    connecting = false
    NativeAskPreview.load(state, into: self)
  }

  deinit {
    connectTask?.cancel()
    sendTask?.cancel()
    pathMonitor.cancel()
  }

  // MARK: Lifecycle

  func start() {
    sheetVisible = true
    guard !isPreview else { return }
    refreshAppleStatus()
    startMonitoring()
    if connectTask == nil {
      connectTask = Task { [weak self] in await self?.connect() }
      return
    }
    guard connected else {
      if !connecting { reconnect() }
      return
    }
    Task { [weak self] in
      await self?.refreshProfile()
      await self?.refreshHistory()
    }
  }

  /// Presentation and generation have independent lifetimes. The retained
  /// model keeps the draft and receives the rest of the answer off-screen.
  func sheetClosed() {
    sheetVisible = false
    showingHistory = false
    reviewingConsent = false
  }

  func reconnect() {
    connectTask?.cancel()
    connectTask = Task { [weak self] in await self?.connect() }
  }

  private func startMonitoring() {
    guard !monitoring else { return }
    monitoring = true
    pathMonitor.pathUpdateHandler = Self.pathHandler(for: self)
    pathMonitor.start(queue: DispatchQueue(label: "net.lakesidegames.ahdclient.ask.network"))
  }

  /// Built outside the main actor: NWPathMonitor calls it on its own queue.
  nonisolated private static func pathHandler(for model: NativeAskModel) -> (NWPath) -> Void {
    return { [weak model] path in
      let online = path.status == .satisfied
      guard let model else { return }
      Task { @MainActor in model.networkChanged(online: online) }
    }
  }

  private func networkChanged(online: Bool) {
    let wasOffline = offline
    offline = !online
    guard online, wasOffline else { return }
    notice = nil
    if !connected && !connecting { reconnect() } else if connected { Task { await refreshHistory() } }
  }

  func refreshAppleStatus() {
    let status = AppleFoundationModelBridge.status()
    appleAvailable = status["available"] as? Bool ?? false
    appleMessage = status["message"] as? String ?? "On-device answers are unavailable."
  }

  func connect() async {
    connecting = true
    defer { connecting = false }
    let cookies = await allCookies()
    let client = NativeAskAPI(gameCookies: cookies)
    var attempt = 0
    while true {
      do {
        let profile = try await client.connect()
        api = client
        applyProfile(profile)
        signedIn = true
        connected = true
        notice = nil
        break
      } catch let failure where NativeAskError.isTransient(failure) && attempt < 2 {
        attempt += 1
        try? await Task.sleep(nanoseconds: UInt64(attempt) * 900_000_000)
        if Task.isCancelled { return }
      } catch let failure {
        api = client
        connected = false
        if case NativeAskError.signedOut? = failure as? NativeAskError {
          signedIn = false
        } else if case NativeAskError.loginFailed? = failure as? NativeAskError {
          signedIn = false
        } else {
          // Offline or the service is down. Keep any linked state; say why.
          offline = NativeAskMessages.isOffline(failure)
          notice = NativeAskMessages.text(for: failure)
        }
        return
      }
    }
    await refreshHistory()
  }

  private func applyProfile(_ profile: [String: Any]) {
    recipients = NativeAskConsent.recipients(from: profile)
    consented = NativeAskConsent.granted(recipients)
    accountName = Self.name(from: profile) ?? "your linked game account"
    if let fresh = NativeAskUsage(profile["usage"]) { usage = fresh }
  }

  func refreshProfile() async {
    guard let api, connected else { return }
    do {
      applyProfile(try await api.profile())
      signedIn = true
    } catch {
      handleBackgroundFailure(error)
    }
  }

  private func handleBackgroundFailure(_ error: Error) {
    if case NativeAskError.signedOut? = error as? NativeAskError {
      signedIn = false
      connected = false
    } else if case NativeAskError.loginFailed? = error as? NativeAskError {
      signedIn = false
      connected = false
    } else if NativeAskMessages.isOffline(error) {
      offline = true
    }
  }

  // MARK: Consent

  func grantConsent() {
    if !isPreview { NativeAskConsent.grant(recipients) }
    consented = true
    reviewingConsent = false
  }

  func withdrawConsent() {
    if !isPreview { NativeAskConsent.withdraw() }
    consented = false
    reviewingConsent = false
  }

  /// The server path is waiting on the player's permission.
  var needsConsent: Bool {
    provider == .server && signedIn && (!consented || reviewingConsent)
  }

  // MARK: History

  func refreshHistory() async {
    if isPreview { return }
    guard let api, signedIn else { return }
    historyLoading = true
    defer { historyLoading = false }
    do {
      let payload = try await api.conversations()
      conversations = NativeAskConversation.list(payload["conversations"])
      if let fresh = NativeAskUsage(payload["usage"]) { usage = fresh }
      historyLoaded = true
      historyError = nil
    } catch {
      handleBackgroundFailure(error)
      historyError = NativeAskMessages.text(for: error)
    }
  }

  func openConversation(_ conversation: NativeAskConversation) {
    showingHistory = false
    guard conversation.id != conversationID || turns.isEmpty else { return }
    guard !sending else {
      notice = "Wait for this answer to finish, or stop it, before opening another conversation."
      return
    }
    if isPreview {
      NativeAskPreview.open(conversation, into: self)
      return
    }
    guard let api else { return }
    loadingConversation = true
    let previous = (turns, conversationID)
    conversationID = conversation.id
    turns = []
    followupsLeft = nil
    Task { [weak self] in
      guard let self else { return }
      defer { self.loadingConversation = false }
      do {
        let payload = try await api.conversation(id: conversation.id)
        guard self.conversationID == conversation.id else { return }
        self.turns = (payload["turns"] as? [Any] ?? []).compactMap { NativeAskTurn.saved($0) }
        self.notice = nil
        await self.refreshCost()
      } catch {
        guard self.conversationID == conversation.id else { return }
        self.turns = previous.0
        self.conversationID = previous.1
        self.handleBackgroundFailure(error)
        self.notice = "That conversation could not be opened. " + NativeAskMessages.text(for: error)
      }
    }
  }

  private func refreshCost() async {
    guard let api, !conversationID.isEmpty else { return }
    if let payload = try? await api.nextCost(conversationID: conversationID),
       let left = (payload["followupsLeft"] as? NSNumber)?.intValue {
      followupsLeft = left
    }
  }

  func newConversation() {
    guard !sending else { return }
    showingHistory = false
    turns = []
    conversationID = ""
    followupsLeft = nil
    notice = nil
  }

  func deleteConversation(_ conversation: NativeAskConversation) {
    guard let index = conversations.firstIndex(of: conversation) else { return }
    conversations.remove(at: index)
    if conversation.id == conversationID && !sending { newConversation() }
    if isPreview { return }
    guard let api else { return }
    Task { [weak self] in
      do {
        try await api.deleteConversation(id: conversation.id)
        self?.showToast("Conversation deleted")
      } catch {
        guard let self else { return }
        self.conversations.insert(conversation, at: min(index, self.conversations.count))
        self.notice = "That conversation could not be deleted. " + NativeAskMessages.text(for: error)
      }
    }
  }

  var currentTitle: String {
    if let match = conversations.first(where: { $0.id == conversationID }), !conversationID.isEmpty { return match.title }
    if let first = turns.first?.question, !first.isEmpty { return first }
    return "New chat"
  }

  var canShareConversation: Bool {
    provider == .server && !conversationID.isEmpty && !sending && turns.contains { !$0.local && $0.state == .done }
  }

  // MARK: Sending

  var trimmedDraft: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

  var uploadsInFlight: Bool {
    draftAttachments.contains { $0.upload == .uploading }
  }

  var canSend: Bool {
    guard !sending, !uploadsInFlight, !loadingConversation else { return false }
    let length = trimmedDraft.utf16.count
    let hasPhotos = draftAttachments.contains { $0.ready != nil }
    guard length <= Self.maxQuestion, length >= 5 || (hasPhotos && provider == .server) else { return false }
    if provider == .appleOnDevice { return appleAvailable }
    return signedIn && consented && !(usage?.exhausted ?? false)
  }

  func send(_ text: String? = nil) {
    let question = (text ?? draft).trimmingCharacters(in: .whitespacesAndNewlines)
    let photos = provider == .server ? draftAttachments.compactMap(\.ready) : []
    guard !sending, question.utf16.count <= Self.maxQuestion else { return }
    guard question.utf16.count >= 5 || !photos.isEmpty else { return }
    if uploadsInFlight {
      notice = "Wait for the photo to finish uploading."
      return
    }
    // Nothing reaches an outside AI service before the player allows it.
    if provider == .server && (!consented || !signedIn) { return }
    if provider == .server, let usage, usage.exhausted {
      notice = quotaMessage
      haptic(.warning)
      return
    }
    var turn = NativeAskTurn(id: UUID().uuidString, question: question.isEmpty ? "Please review the attached photo." : question)
    turn.state = .streaming
    turn.status = provider == .appleOnDevice ? "Writing on this \(Self.deviceName)" : "Thinking"
    turn.attachments = photos
    turn.local = provider == .appleOnDevice
    turns.append(turn)
    if text == nil { draft = "" }
    if provider == .server { draftAttachments.removeAll() }
    notice = nil
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    run(turnID: turn.id)
  }

  /// Ask again for a turn that failed outright.
  func retry(_ turnID: String) {
    guard !sending, let index = turns.firstIndex(where: { $0.id == turnID }) else { return }
    if case .interrupted = turns[index].state {
      recover(turnID)
      return
    }
    reset(index)
    run(turnID: turnID)
  }

  private func reset(_ index: Int) {
    turns[index].answer = ""
    turns[index].state = .streaming
    turns[index].status = turns[index].local ? "Writing on this \(Self.deviceName)" : "Thinking"
    turns[index].lookups = 0
    turns[index].sentAt = Date()
  }

  /// A dropped stream may still have finished on the service. Look for the
  /// saved answer first; ask again only if it is not there.
  private func recover(_ turnID: String) {
    guard let index = turns.firstIndex(where: { $0.id == turnID }) else { return }
    let question = turns[index].question
    let since = turns[index].sentAt
    turns[index].state = .streaming
    turns[index].status = "Checking for the finished answer"
    sending = true
    Task { [weak self] in
      guard let self else { return }
      let saved = await self.savedAnswer(question: question, since: since)
      self.sending = false
      guard let position = self.turns.firstIndex(where: { $0.id == turnID }) else { return }
      if let saved {
        self.turns[position] = saved
        self.haptic(.success)
        Task { await self.refreshHistory() }
      } else {
        self.reset(position)
        self.run(turnID: turnID)
      }
    }
  }

  private func savedAnswer(question: String, since: Date) async -> NativeAskTurn? {
    guard let api, !conversationID.isEmpty,
          let payload = try? await api.conversation(id: conversationID) else { return nil }
    let saved = (payload["turns"] as? [Any] ?? []).compactMap { NativeAskTurn.saved($0) }
    return saved.last { $0.question == question && $0.sentAt >= since.addingTimeInterval(-10) && !$0.answer.isEmpty }
  }

  private func run(turnID: String) {
    guard let index = turns.firstIndex(where: { $0.id == turnID }) else { return }
    let turn = turns[index]
    sending = true
    requestID = nil
    streamingTurnID = turnID
    let local = turn.local
    let history = turns.prefix(index).suffix(8).map { "User: \($0.question)\nAssistant: \(String($0.answer.prefix(1200)))" }
    sendTask = Task { [weak self] in
      guard let self else { return }
      defer {
        self.sending = false
        self.requestID = nil
        self.streamingTurnID = nil
        self.flushPending()
      }
      do {
        if local {
          try await self.answerOnDevice(turnID: turnID, question: turn.question, history: Array(history))
        } else {
          try await self.answerOnline(turnID: turnID, turn: turn)
        }
      } catch _ where Task.isCancelled {
        self.cancelled(turnID: turnID)
      } catch is CancellationError {
        self.cancelled(turnID: turnID)
      } catch {
        self.failed(turnID: turnID, error: error)
      }
    }
  }

  private func answerOnline(turnID: String, turn: NativeAskTurn) async throws {
    guard let api, signedIn else { throw NativeAskError.signedOut }
    let payload = try await api.ask(
      question: turn.question,
      conversationID: conversationID,
      useLive: useLive,
      visualizations: visualizations,
      attachments: turn.attachments.map(\.url)
    ) { [weak self] event in
      self?.handle(event, turnID: turnID)
    }
    flushPending()
    guard let index = turns.firstIndex(where: { $0.id == turnID }) else { return }
    turns[index].apply(answerPayload: payload)
    turns[index].state = .done
    turns[index].status = ""
    if let id = payload["convId"] as? String, !id.isEmpty { conversationID = id }
    if let fresh = NativeAskUsage(payload["usage"]) { usage = fresh }
    if let left = (payload["followupsLeft"] as? NSNumber)?.intValue { followupsLeft = left }
    if sheetVisible {
      haptic(.success)
      UIAccessibility.post(notification: .announcement, argument: "Answer ready")
    }
    Task { [weak self] in await self?.refreshHistory() }
  }

  private func answerOnDevice(turnID: String, question: String, history: [String]) async throws {
    guard appleAvailable else { throw FoundationModelBridgeError.unavailable(appleMessage) }
    var evidence: (text: String, files: [String]) = ("", [])
    if signedIn, let api {
      do {
        evidence = try await api.context(question: question)
      } catch {
        // On-device answers still work without the game's guides. Say so.
        setStatus("Answering on this \(Self.deviceName) without the game guides", turnID: turnID)
      }
    }
    let options = FoundationModelOptions(question: question, history: history, length: "standard", style: "standard", mode: "ask", gameContext: evidence.text)
    let payload = try await AppleFoundationModelBridge.respond(options)
    try Task.checkCancellation()
    let text = payload["text"] as? String ?? ""
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw FoundationModelBridgeError.empty }
    guard let index = turns.firstIndex(where: { $0.id == turnID }) else { return }
    turns[index].answer = text
    turns[index].model = payload["model"] as? String ?? "Apple Foundation Models"
    turns[index].citations = evidence.files.map { NativeAskCitation(label: $0, path: "", url: nil) }
    turns[index].state = .done
    turns[index].status = ""
    if sheetVisible {
      haptic(.success)
      UIAccessibility.post(notification: .announcement, argument: "Answer ready")
    }
  }

  private func handle(_ event: NativeAskStreamEvent, turnID: String) {
    guard streamingTurnID == turnID else { return }
    switch event {
    case .meta(let conversation, let request, let left, let usagePayload):
      if let conversation, !conversation.isEmpty { conversationID = conversation }
      if let request, !request.isEmpty { requestID = request }
      if let left { followupsLeft = left }
      if let fresh = NativeAskUsage(usagePayload) { usage = fresh }
    case .status(let label):
      setStatus(label, turnID: turnID)
    case .lookup:
      if let index = turns.firstIndex(where: { $0.id == turnID }) { turns[index].lookups += 1 }
    case .delta(let text):
      pendingText[turnID, default: ""] += text
      scheduleFlush()
    }
  }

  /// Streaming deltas arrive per token. Publishing them in small batches keeps
  /// the markdown re-render off the hot path.
  private func scheduleFlush() {
    guard !flushScheduled else { return }
    flushScheduled = true
    Task { [weak self] in
      try? await Task.sleep(nanoseconds: 60_000_000)
      self?.flushPending()
    }
  }

  private func flushPending() {
    flushScheduled = false
    guard !pendingText.isEmpty else { return }
    for (turnID, text) in pendingText {
      if let index = turns.firstIndex(where: { $0.id == turnID }) { turns[index].answer += text }
    }
    pendingText.removeAll()
  }

  private func setStatus(_ label: String, turnID: String) {
    guard let index = turns.firstIndex(where: { $0.id == turnID }) else { return }
    turns[index].status = label.trimmingCharacters(in: CharacterSet(charactersIn: ".… ")).isEmpty ? turns[index].status
      : label.replacingOccurrences(of: "…", with: "").replacingOccurrences(of: "...", with: "")
  }

  private func cancelled(turnID: String) {
    flushPending()
    guard let index = turns.firstIndex(where: { $0.id == turnID }) else { return }
    if turns[index].answer.isEmpty {
      // Stopped before anything arrived: put the question back.
      let question = turns[index].question
      let photos = turns[index].attachments
      turns.remove(at: index)
      if trimmedDraft.isEmpty { draft = question }
      if draftAttachments.isEmpty {
        draftAttachments = photos.map { NativeAskDraftAttachment(id: $0.url, thumbnail: $0.thumbnail ?? Data(), upload: .ready($0)) }
      }
    } else {
      turns[index].state = .stopped
      turns[index].status = ""
    }
  }

  private func failed(turnID: String, error: Error) {
    flushPending()
    guard let index = turns.firstIndex(where: { $0.id == turnID }) else { return }
    if sheetVisible { haptic(.error) }
    let message = NativeAskMessages.text(for: error)
    if case NativeAskError.quota(let text, let usagePayload)? = error as? NativeAskError {
      if let fresh = NativeAskUsage(usagePayload) { usage = fresh }
      restoreDraft(from: index)
      notice = text + (usage?.resetLabel.map { " Your questions come back in \($0)." } ?? "")
      return
    }
    if case NativeAskError.signedOut? = error as? NativeAskError {
      signedIn = false
      connected = false
      restoreDraft(from: index)
      notice = "Your Ask session ended. Link your game account again to keep asking."
      return
    }
    if NativeAskMessages.isOffline(error) { offline = true }
    if case NativeAskError.streamDropped? = error as? NativeAskError, !conversationID.isEmpty {
      turns[index].state = .interrupted(message)
    } else if !turns[index].answer.isEmpty {
      turns[index].state = .interrupted(message)
    } else {
      turns[index].state = .failed(message)
    }
    turns[index].status = ""
  }

  private func restoreDraft(from index: Int) {
    let question = turns[index].question
    let photos = turns[index].attachments
    turns.remove(at: index)
    if trimmedDraft.isEmpty { draft = question }
    if draftAttachments.isEmpty && !photos.isEmpty {
      draftAttachments = photos.map { NativeAskDraftAttachment(id: $0.url, thumbnail: $0.thumbnail ?? Data(), upload: .ready($0)) }
    }
  }

  /// Stop the answer in flight. A server generation is aborted too, so a
  /// stopped question records nothing and costs no quota.
  func stop() {
    guard sending else { return }
    if let requestID, let api {
      Task { await api.stop(requestID: requestID) }
    }
    sendTask?.cancel()
  }

  // MARK: Answer actions

  func copy(_ turn: NativeAskTurn) {
    UIPasteboard.general.string = turn.answer
    showToast("Copied")
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
  }

  func shareConversation() {
    guard canShareConversation else { return }
    if isPreview {
      onShare?([URL(string: "https://ask.lakesidegames.net/s/preview")!])
      return
    }
    guard let api else { return }
    let id = conversationID
    let title = currentTitle
    Task { [weak self] in
      do {
        let url = try await api.share(conversationID: id)
        self?.onShare?([title, url])
      } catch {
        guard let self else { return }
        if case NativeAskError.server(let message)? = error as? NativeAskError, message.lowercased().contains("private") {
          self.notice = "Conversations with photos or private game details stay private and can't be shared."
        } else {
          self.notice = "This conversation could not be shared. " + NativeAskMessages.text(for: error)
        }
      }
    }
  }

  func rate(_ turnID: String, rating: String, reason: String = "") {
    guard let index = turns.firstIndex(where: { $0.id == turnID }), let answerID = turns[index].answerID else { return }
    let previous = turns[index].feedback
    turns[index].feedback = rating
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    if isPreview {
      showToast(rating == "up" ? "Thanks for the feedback" : "Thanks. This answer will be reviewed.")
      return
    }
    guard let api else { return }
    Task { [weak self] in
      do {
        try await api.feedback(answerID: answerID, rating: rating, reason: reason)
        self?.showToast(rating == "up" ? "Thanks for the feedback" : "Thanks. This answer will be reviewed.")
      } catch {
        guard let self, let position = self.turns.firstIndex(where: { $0.id == turnID }) else { return }
        self.turns[position].feedback = previous
        self.notice = "Your feedback could not be sent. " + NativeAskMessages.text(for: error)
      }
    }
  }

  func open(_ url: URL) {
    onOpenURL?(url)
  }

  func showToast(_ message: String) {
    toast = message
    UIAccessibility.post(notification: .announcement, argument: message)
    toastTask?.cancel()
    toastTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 2_200_000_000)
      guard !Task.isCancelled else { return }
      self?.toast = nil
    }
  }

  private func haptic(_ type: UINotificationFeedbackGenerator.FeedbackType) {
    UINotificationFeedbackGenerator().notificationOccurred(type)
  }

  var quotaMessage: String {
    var text = "You've used today's questions."
    if let reset = usage?.resetLabel { text += " They come back in \(reset)." }
    return text
  }

  // MARK: Photos

  var canAttach: Bool {
    provider == .server && signedIn && consented && !sending && draftAttachments.count < Self.maxAttachments
  }

  /// Downscale, upload, and show progress for one picked photo.
  func addPhoto(_ image: UIImage) {
    guard draftAttachments.count < Self.maxAttachments else { return }
    let scaled = Self.scaled(image, maxSide: 2048)
    guard let data = scaled.jpegData(compressionQuality: 0.82) else {
      notice = "That photo could not be read."
      return
    }
    let thumb = Self.scaled(image, maxSide: 240).jpegData(compressionQuality: 0.7) ?? Data()
    let id = UUID().uuidString
    draftAttachments.append(NativeAskDraftAttachment(id: id, thumbnail: thumb, upload: .uploading))
    if isPreview {
      let attachment = NativeAskAttachment(url: "/api/uploads/preview.jpg", name: "Photo.jpg", mimeType: "image/jpeg", size: data.count, thumbnail: thumb)
      updateDraft(id, .ready(attachment))
      return
    }
    guard let api else { return }
    Task { [weak self] in
      do {
        let payload = try await api.upload(data, filename: "Photo.jpg", mimeType: "image/jpeg")
        guard var attachment = NativeAskAttachment(payload) else { throw NativeAskError.server("The photo could not be uploaded.") }
        attachment.thumbnail = thumb
        self?.updateDraft(id, .ready(attachment))
      } catch {
        let message = NativeAskMessages.text(for: error)
        self?.updateDraft(id, .failed(message))
        self?.notice = "A photo could not be uploaded. " + message + " Remove it to send without it."
      }
    }
  }

  private func updateDraft(_ id: String, _ upload: NativeAskDraftAttachment.Upload) {
    guard let index = draftAttachments.firstIndex(where: { $0.id == id }) else { return }
    draftAttachments[index].upload = upload
  }

  func removeAttachment(_ id: String) {
    draftAttachments.removeAll { $0.id == id }
  }

  private static func scaled(_ image: UIImage, maxSide: CGFloat) -> UIImage {
    let size = image.size
    let longest = max(size.width, size.height)
    guard longest > maxSide, longest > 0 else { return image }
    let factor = maxSide / longest
    let target = CGSize(width: (size.width * factor).rounded(), height: (size.height * factor).rounded())
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    return UIGraphicsImageRenderer(size: target, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
  }

  /// Thumbnail bytes for an attachment in a saved conversation.
  func thumbnail(for attachment: NativeAskAttachment) async -> Data? {
    if let data = attachment.thumbnail { return data }
    if let cached = thumbnailCache[attachment.url] { return cached }
    guard let api, attachment.isImage, let data = try? await api.attachment(path: attachment.url),
          let image = UIImage(data: data) else { return nil }
    let thumb = Self.scaled(image, maxSide: 240).jpegData(compressionQuality: 0.7)
    if let thumb { thumbnailCache[attachment.url] = thumb }
    return thumb
  }

  // MARK: Maps

  func renderMap(_ spec: String) async throws -> String {
    if let cached = mapCache[spec] { return cached }
    guard let data = spec.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data), object is [String: Any] else {
      throw NativeAskError.server("This map could not be shown.")
    }
    let client: NativeAskAPI
    if let api {
      client = api
    } else if let publicAPI {
      client = publicAPI
    } else {
      client = NativeAskAPI(gameCookies: [])
      publicAPI = client
    }
    let svg = try await client.renderMap(data)
    mapCache[spec] = svg
    return svg
  }

  // MARK: Helpers

  static var deviceName: String {
    UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
  }

  private func allCookies() async -> [HTTPCookie] {
    guard let webView else { return [] }
    return await withCheckedContinuation { continuation in
      webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
        continuation.resume(returning: cookies)
      }
    }
  }

  private static func name(from profile: [String: Any]) -> String? {
    let identity = profile["identity"] as? [String: Any]
    let context = profile["context"] as? [String: Any]
    let character = context?["character"] as? [String: Any]
    return identity?["name"] as? String ?? identity?["displayName"] as? String
      ?? character?["name"] as? String ?? context?["displayName"] as? String
  }

  // Preview hooks: NativeAskPreview fills state through these.
  func previewSetAPI(_ value: NativeAskAPI?) { api = value }
}
