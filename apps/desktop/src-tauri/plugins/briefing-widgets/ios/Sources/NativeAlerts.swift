import UIKit
import UserNotifications

/// The rules for alerts, with no UIKit so they can be reasoned about alone.
enum AlertsPolicy {
  enum Permission: Equatable { case unknown, notDetermined, denied, granted }
  enum Mode: Equatable { case ask, off, on, denied }

  /// The one-time question. Only after a signed-in status has loaded, only on
  /// a game page, only when the system has never been asked, and never twice.
  static func shouldAsk(asked: Bool, signedIn: Bool, statusLoaded: Bool, onGamePage: Bool,
    enabled: Bool, permission: Permission) -> Bool {
    !asked && signedIn && statusLoaded && onGamePage && !enabled && permission == .notDetermined
  }

  /// What the Alerts row shows.
  static func mode(enabled: Bool, permission: Permission) -> Mode {
    if permission == .denied { return .denied }
    return enabled && permission == .granted ? .on : .off
  }

  static func badge(unread: Double, enabled: Bool, permission: Permission) -> Int {
    guard enabled, permission == .granted, unread.isFinite else { return 0 }
    return Int(min(max(unread, 0), 9_999))
  }

  /// When the turn reminder should fire, or nil when none should be pending.
  /// Off by default; needs the switch on, system permission, a signed-in
  /// player and a next turn that is still ahead.
  static func reminderDate(next: Date?, now: Date, on: Bool, permission: Permission, signedIn: Bool) -> Date? {
    guard on, permission == .granted, signedIn, let next, next.timeIntervalSince(now) > 5 else { return nil }
    return next
  }

  /// "Turn 413 is in": the turn after the current one. No number, no guess.
  static func reminderTitle(current: Double?) -> String {
    guard let current, current.isFinite, current >= 0, current < 1_000_000 else { return "A new turn is in" }
    return "Turn \(Int(current) + 1) is in"
  }

  /// An alert is cleared when the player is on the page it is about, or on the
  /// inbox, which lists them all. `href` is a game path, query allowed.
  static func shouldClear(href: String?, viewing path: String) -> Bool {
    if path == "/notifications" { return true }
    guard let href, href.hasPrefix("/") else { return false }
    let target = href.split(separator: "?", maxSplits: 1).first.map(String.init) ?? href
    return target == path
  }
}

/// Alerts the player actually turns on: the one-time sheet, the Alerts row,
/// the icon badge, tidying delivered alerts and the alert category. The push state
/// itself stays in the push file, which binds in through the two hooks below; with
/// no hooks (the preview harness) nothing is ever asked.
final class NativeAlerts {
  static let shared = NativeAlerts()
  static let category = "ahd-alert"
  static let openInboxAction = "ahd.open-inbox"
  private static let askedKey = "ahd.alerts.asked"

  var isEnabled: (() -> Bool)?
  /// Turns alerts on or off; the system prompt appears on the first "on".
  var setEnabled: ((Bool, @escaping () -> Void) -> Void)?

  private static let reminderKey = "ahd.alerts.turnReminder"
  static let reminderID = "ahd.turn-reminder"

  private(set) var permission = AlertsPolicy.Permission.unknown
  private var presenting = false
  /// The player asked for the reminder before alerts were allowed; finish it
  /// once the pre-prompt succeeds.
  fileprivate var pendingReminder = false
  private var scheduled: (date: Date, title: String)?

  /// The turn reminder switch. Off until the player turns it on.
  var reminderOn: Bool {
    get { UserDefaults.standard.bool(forKey: Self.reminderKey) }
    set { UserDefaults.standard.set(newValue, forKey: Self.reminderKey) }
  }

  var asked: Bool {
    get { UserDefaults.standard.bool(forKey: Self.askedKey) }
    set { UserDefaults.standard.set(newValue, forKey: Self.askedKey) }
  }

  func registerCategories() {
    let open = UNNotificationAction(identifier: Self.openInboxAction, title: "Open inbox", options: [.foreground])
    let category = UNNotificationCategory(identifier: Self.category, actions: [open], intentIdentifiers: [], options: [])
    UNUserNotificationCenter.current().setNotificationCategories([category])
  }

  func refreshPermission(_ done: ((AlertsPolicy.Permission) -> Void)? = nil) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      let value: AlertsPolicy.Permission
      switch settings.authorizationStatus {
      case .notDetermined: value = .notDetermined
      case .denied: value = .denied
      default: value = .granted
      }
      DispatchQueue.main.async {
        self.permission = value
        done?(value)
      }
    }
  }

  // MARK: The sheet

  /// After a signed-in status load. Does nothing unless every rule passes.
  func askOnce(from presenter: UIViewController?, signedIn: Bool, statusLoaded: Bool, onGamePage: Bool) {
    guard let isEnabled, setEnabled != nil, !presenting, !asked else { return }
    refreshPermission { [weak self] permission in
      guard let self, !self.presenting else { return }
      guard AlertsPolicy.shouldAsk(asked: self.asked, signedIn: signedIn, statusLoaded: statusLoaded,
        onGamePage: onGamePage, enabled: isEnabled(), permission: permission) else { return }
      self.asked = true
      self.present(.ask, from: presenter)
    }
  }

  /// The Alerts row on More.
  func showManager(from presenter: UIViewController?) {
    refreshPermission { [weak self] permission in
      guard let self else { return }
      self.present(AlertsPolicy.mode(enabled: self.isEnabled?() ?? false, permission: permission), from: presenter)
    }
  }

  func present(_ mode: AlertsPolicy.Mode, from presenter: UIViewController?, preview: Bool = false) {
    guard var top = presenter, !presenting else { return }
    while let next = top.presentedViewController { top = next }
    presenting = true
    let sheet = AlertsSheetController(mode: mode, preview: preview) { [weak self] in self?.presenting = false }
    top.present(sheet, animated: true)
  }

  fileprivate func turnOn(_ done: @escaping () -> Void) {
    guard let setEnabled else { done(); return }
    setEnabled(true) { [weak self] in
      guard let self else { done(); return }
      self.refreshPermission { permission in
        if self.pendingReminder && permission == .granted { self.setReminder(true) }
        self.pendingReminder = false
        done()
      }
    }
  }

  // MARK: Turn reminder

  func setReminder(_ on: Bool) {
    reminderOn = on
    syncReminder(signedIn: !(BriefingStore.session() ?? "").isEmpty)
  }

  /// Schedules, moves or cancels the one pending "Turn N is in" notification
  /// from the next-turn time the dock already holds. Safe to call often.
  func syncReminder(signedIn: Bool) {
    refreshPermission { [weak self] permission in
      guard let self else { return }
      let data = BriefingStore.read()?.data
      let next = data?.turn?.active == false ? nil : data?.nextTurn
      guard let fire = AlertsPolicy.reminderDate(next: next, now: Date(), on: self.reminderOn,
        permission: permission, signedIn: signedIn) else { self.cancelReminder(); return }
      let title = AlertsPolicy.reminderTitle(current: data?.turn?.current)
      if let scheduled = self.scheduled, scheduled.date == fire, scheduled.title == title { return }
      let content = UNMutableNotificationContent()
      content.title = title
      content.sound = .default
      let parts = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: fire)
      let request = UNNotificationRequest(identifier: Self.reminderID, content: content,
        trigger: UNCalendarNotificationTrigger(dateMatching: parts, repeats: false))
      UNUserNotificationCenter.current().add(request) { error in
        if error == nil { DispatchQueue.main.async { self.scheduled = (fire, title) } }
      }
    }
  }

  /// Sign-out, the switch turned off, or permission gone.
  func cancelReminder() {
    scheduled = nil
    let center = UNUserNotificationCenter.current()
    center.removePendingNotificationRequests(withIdentifiers: [Self.reminderID])
    center.removeDeliveredNotifications(withIdentifiers: [Self.reminderID])
  }

  fileprivate func turnOff(_ done: @escaping () -> Void) {
    guard let setEnabled else { done(); return }
    setEnabled(false, done)
  }

  // MARK: Badge and delivered alerts

  /// The icon shows the unread inbox count while alerts are on, and nothing otherwise.
  func updateBadge(unread: Double) {
    refreshPermission { [weak self] permission in
      guard let self else { return }
      let value = AlertsPolicy.badge(unread: unread, enabled: self.isEnabled?() ?? false, permission: permission)
      if #available(iOS 16.0, *) {
        UNUserNotificationCenter.current().setBadgeCount(value) { _ in }
      } else {
        UIApplication.shared.applicationIconBadgeNumber = value
      }
    }
  }

  /// Takes alerts about the page the player is reading off the lock screen.
  func clearDelivered(viewing path: String) {
    let center = UNUserNotificationCenter.current()
    center.getDeliveredNotifications { delivered in
      let ids = delivered.filter {
        AlertsPolicy.shouldClear(href: $0.request.content.userInfo["href"] as? String, viewing: path)
      }.map { $0.request.identifier }
      if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
    }
  }
}

/// The bottom sheet. Plain words, one clear button, an easy way out.
final class AlertsSheetController: UIViewController {
  // Same colours as the dock; kept here so this file compiles on its own.
  static let background = UIColor(red: 0x14 / 255, green: 0x14 / 255, blue: 0x1c / 255, alpha: 1)
  static let accent = UIColor(red: 0xdc / 255, green: 0x26 / 255, blue: 0x26 / 255, alpha: 1)
  private let mode: AlertsPolicy.Mode
  private let preview: Bool
  private let onEnd: () -> Void

  private var reminderSwitch: UISwitch?

  init(mode: AlertsPolicy.Mode, preview: Bool, onEnd: @escaping () -> Void) {
    self.mode = mode
    self.preview = preview
    self.onEnd = onEnd
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .pageSheet
    if let sheet = sheetPresentationController {
      sheet.detents = [.medium()]
      sheet.prefersGrabberVisible = true
    }
  }

  required init?(coder: NSCoder) { nil }

  private var copy: (title: String, body: String, primary: String?, secondary: String) {
    switch mode {
    case .ask:
      return ("Get alerts for votes, offers and attacks?",
        "We will tell you the moment something needs you, even when the app is closed. You can change this any time under More, Alerts.",
        "Turn on alerts", "Not now")
    case .off:
      return ("Alerts are off", "Turn them on to hear about votes, offers and attacks.", "Turn on alerts", "Close")
    case .on:
      return ("Alerts are on", "You will hear about votes, offers and attacks, even when the app is closed.", "Turn off alerts", "Done")
    case .denied:
      return ("Alerts are blocked in iOS", "Allow notifications for this app in iOS Settings to get alerts.", "Open iOS Settings", "Close")
    }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = AlertsSheetController.background
    let text = copy

    let title = UILabel()
    title.text = text.title
    title.font = UIFontMetrics(forTextStyle: .title2).scaledFont(for: .systemFont(ofSize: 22, weight: .bold))
    title.adjustsFontForContentSizeCategory = true
    title.textColor = .white
    title.textAlignment = .center
    title.numberOfLines = 0
    title.accessibilityTraits = .header

    let body = UILabel()
    body.text = text.body
    body.font = UIFont.preferredFont(forTextStyle: .body)
    body.adjustsFontForContentSizeCategory = true
    body.textColor = UIColor(white: 1, alpha: 0.7)
    body.textAlignment = .center
    body.numberOfLines = 0

    var views: [UIView] = [title, body]
    if mode == .on || mode == .off { views.append(reminderRow()) }
    if let primary = text.primary {
      let button = UIButton(type: .system)
      button.setTitle(primary, for: .normal)
      button.titleLabel?.font = UIFont.preferredFont(forTextStyle: .headline)
      button.titleLabel?.adjustsFontForContentSizeCategory = true
      button.setTitleColor(.white, for: .normal)
      button.backgroundColor = mode == .on ? UIColor(white: 1, alpha: 0.14) : AlertsSheetController.accent
      button.layer.cornerRadius = 12
      button.contentEdgeInsets = UIEdgeInsets(top: 14, left: 28, bottom: 14, right: 28)
      button.accessibilityIdentifier = "alerts-primary"
      button.addTarget(self, action: #selector(primaryTapped), for: .touchUpInside)
      views.append(button)
    }
    let secondary = UIButton(type: .system)
    secondary.setTitle(text.secondary, for: .normal)
    secondary.titleLabel?.font = UIFont.preferredFont(forTextStyle: .body)
    secondary.titleLabel?.adjustsFontForContentSizeCategory = true
    secondary.setTitleColor(UIColor(white: 1, alpha: 0.8), for: .normal)
    secondary.accessibilityIdentifier = "alerts-secondary"
    secondary.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
    views.append(secondary)

    let stack = UIStackView(arrangedSubviews: views)
    stack.axis = .vertical
    stack.alignment = .center
    stack.spacing = 14
    stack.setCustomSpacing(22, after: body)
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 28),
      stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
    ])
  }

  /// "Remind me when a new turn starts", off until the player says so.
  private func reminderRow() -> UIView {
    let label = UILabel()
    label.text = "Remind me when a new turn starts"
    label.font = UIFont.preferredFont(forTextStyle: .body)
    label.adjustsFontForContentSizeCategory = true
    label.textColor = .white
    label.numberOfLines = 0
    let toggle = UISwitch()
    toggle.onTintColor = AlertsSheetController.accent
    toggle.isOn = preview ? true : NativeAlerts.shared.reminderOn && NativeAlerts.shared.permission == .granted
    toggle.accessibilityLabel = label.text
    toggle.accessibilityIdentifier = "alerts-turn-reminder"
    toggle.addTarget(self, action: #selector(reminderChanged(_:)), for: .valueChanged)
    toggle.setContentHuggingPriority(.required, for: .horizontal)
    toggle.setContentCompressionResistancePriority(.required, for: .horizontal)
    reminderSwitch = toggle
    let row = UIStackView(arrangedSubviews: [label, toggle])
    row.axis = .horizontal
    row.alignment = .center
    row.spacing = 12
    return row
  }

  @objc private func reminderChanged(_ sender: UISwitch) {
    if preview { return }
    let shared = NativeAlerts.shared
    guard sender.isOn else { shared.setReminder(false); return }
    if shared.permission == .granted { shared.setReminder(true); return }
    // Not allowed yet: the same pre-prompt as the first-time sheet.
    sender.setOn(false, animated: true)
    shared.pendingReminder = true
    let presenter = presentingViewController
    dismiss(animated: true) { shared.present(.ask, from: presenter) }
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if isBeingDismissed || presentingViewController == nil {
      if mode == .ask { NativeAlerts.shared.pendingReminder = false }
      onEnd()
    }
  }

  @objc private func primaryTapped() {
    if preview { dismiss(animated: true); return }
    switch mode {
    case .ask, .off:
      NativeAlerts.shared.turnOn { [weak self] in DispatchQueue.main.async { self?.dismiss(animated: true) } }
    case .on:
      NativeAlerts.shared.turnOff { [weak self] in DispatchQueue.main.async { self?.dismiss(animated: true) } }
    case .denied:
      if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
      dismiss(animated: true)
    }
  }

  @objc private func closeTapped() { dismiss(animated: true) }
}
