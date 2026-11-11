//! Desktop inbox alerts. Phones get FCM or APNs pushes; a desktop install has
//! no push channel, so while the client is open it polls the game's alert
//! feed (AHDGame `/api/push/feed`, the same policy as phone pushes) and shows
//! each new alert as a system notification. The session cookie stays in
//! native code, exactly like the briefing.
use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

const FEED_PATH: &str = "/api/push/feed";
const POLL: Duration = Duration::from_secs(60);
const MAX_BODY: u64 = 32 * 1024;

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Saved {
  /// Missing on first run: desktop alerts default on, with no OS prompt to pass.
  enabled: Option<bool>,
  /// Newest notification already seen, for the account below.
  cursor: Option<String>,
  /// SHA-256 of the session cookies the cursor belongs to.
  account: String,
  /// "Remind me when a new turn starts". Missing means off.
  turn_reminder: Option<bool>,
  /// Hours when nothing is shown. Missing means off.
  quiet: Option<Quiet>,
  /// Newest turn already seen, and the account it was seen for.
  last_turn: Option<u64>,
  turn_account: String,
}

/// Quiet hours as minutes after local midnight.
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Quiet {
  enabled: bool,
  start: u32,
  end: u32,
}

impl Default for Quiet {
  fn default() -> Self { Self { enabled: false, start: 22 * 60, end: 7 * 60 } }
}

#[derive(Default)]
pub(crate) struct AlertState {
  message: Mutex<String>,
  registered: Mutex<bool>,
  poll: tokio::sync::Mutex<()>,
}

#[derive(Debug, Deserialize, PartialEq)]
pub(crate) struct FeedItem {
  pub title: String,
  pub subtitle: String,
  pub body: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Feed {
  pub cursor: Option<String>,
  #[serde(default)]
  pub items: Vec<FeedItem>,
  #[serde(default)]
  pub more: u32,
}

/// What one poll asks the OS to show: the alerts oldest first so the newest
/// lands on top, then a count for anything beyond them.
pub(crate) fn notifications_for(feed: &Feed) -> Vec<(String, String)> {
  let mut shown: Vec<(String, String)> = feed.items.iter().rev().map(|item| {
    let body = match (clean(&item.subtitle, 120), clean(&item.body, 400)) {
      (subtitle, body) if subtitle.is_empty() => body,
      (subtitle, body) if body.is_empty() => subtitle,
      (subtitle, body) => format!("{subtitle} \u{00b7} {body}"),
    };
    let title = clean(&item.title, 120);
    (if title.is_empty() { "A House Divided".into() } else { title }, body)
  }).collect();
  if feed.more > 0 {
    let noun = if feed.more == 1 { "alert" } else { "alerts" };
    shown.push(("A House Divided".into(), format!("{} more {noun} in your inbox.", feed.more)));
  }
  shown
}

/// True when `now` (minutes after local midnight) falls inside the quiet
/// window. A window that ends before it starts runs overnight.
pub(crate) fn in_quiet_hours(quiet: &Quiet, now: u32) -> bool {
  if !quiet.enabled || quiet.start == quiet.end { return false; }
  if quiet.start < quiet.end { now >= quiet.start && now < quiet.end } else { now >= quiet.start || now < quiet.end }
}

fn quiet_now(app: &AppHandle) -> bool {
  use chrono::Timelike;
  let now = chrono::Local::now();
  in_quiet_hours(&read(app).quiet.unwrap_or_default(), now.hour() * 60 + now.minute())
}

/// A reminder goes out once per turn: only when the turn number moved up
/// since the last one this player's client saw. The first sighting is a
/// baseline, never a reminder.
pub(crate) fn reminder_due(last: Option<u64>, current: u64) -> bool {
  last.is_some_and(|seen| current > seen)
}

fn turn_number(value: f64) -> Option<u64> {
  if value.is_finite() && (0.0..1e9).contains(&value) { Some(value as u64) } else { None }
}

fn clean(text: &str, limit: usize) -> String {
  let flat: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
  let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
  if flat.chars().count() <= limit { return flat; }
  let mut cut: String = flat.chars().take(limit - 1).collect();
  cut.truncate(cut.trim_end().len());
  cut.push('\u{2026}');
  cut
}

fn file(app: &AppHandle) -> Option<PathBuf> {
  app.path().app_config_dir().ok().map(|dir| dir.join("desktop-alerts.json"))
}
fn read(app: &AppHandle) -> Saved {
  file(app).and_then(|path| std::fs::read(path).ok())
    .and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}
fn save(app: &AppHandle, saved: &Saved) -> Result<(), String> {
  let path = file(app).ok_or("Cannot save alert settings.")?;
  if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|_| "Cannot save alert settings.")?; }
  let temporary = path.with_extension("tmp");
  std::fs::write(&temporary, serde_json::to_vec(saved).map_err(|_| "Cannot save alert settings.")?)
    .and_then(|_| std::fs::rename(&temporary, &path)).map_err(|_| "Cannot save alert settings.".into())
}
pub(crate) fn alerts_enabled(app: &AppHandle) -> bool { read(app).enabled != Some(false) }
fn fingerprint(header: &str) -> String {
  Sha256::digest(header.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn set_message(app: &AppHandle, registered: bool, message: &str) {
  let state = app.state::<AlertState>();
  if let Ok(mut slot) = state.message.lock() { *slot = message.into(); }
  if let Ok(mut slot) = state.registered.lock() { *slot = registered; };
}

/// A singleplayer world is open: the online game is not what is being played.
fn playing_singleplayer(app: &AppHandle) -> bool {
  app.get_webview_window("game").is_some() || app.get_webview("game-embedded").is_some()
}

/// The player is already looking at the live site, which shows the alert itself.
fn watching_game(app: &AppHandle) -> bool {
  let focused = |label: &str| app.get_webview_window(label).and_then(|w| w.is_focused().ok()).unwrap_or(false);
  focused("online") || (focused("main") && app.get_webview("online-embedded").is_some())
}

enum Outcome { Feed(Feed), SignedOut, Unsupported, Offline }

fn fetch(header: String, cursor: Option<String>) -> Outcome {
  let mut url = format!("{}{FEED_PATH}", crate::ONLINE_URL);
  if let Some(cursor) = cursor.filter(|c| c.len() == 24 && c.chars().all(|ch| ch.is_ascii_hexdigit())) {
    url.push_str("?after=");
    url.push_str(&cursor);
  }
  let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(12)).redirects(0).build();
  match agent.get(&url).set("Cookie", &header).set("Cache-Control", "no-cache")
    .set("X-AHD-Client-Version", env!("CARGO_PKG_VERSION")).call() {
    Ok(response) => {
      let mut body = Vec::new();
      if response.into_reader().take(MAX_BODY + 1).read_to_end(&mut body).is_err() || body.len() as u64 > MAX_BODY {
        return Outcome::Offline;
      }
      serde_json::from_slice(&body).map(Outcome::Feed).unwrap_or(Outcome::Offline)
    }
    Err(ureq::Error::Status(401 | 403, _)) => Outcome::SignedOut,
    Err(ureq::Error::Status(404, _)) => Outcome::Unsupported,
    Err(_) => Outcome::Offline,
  }
}

async fn poll(app: &AppHandle) {
  let state = app.state::<AlertState>();
  let Ok(_poll) = state.poll.try_lock() else { return };
  let mut saved = read(app);
  if saved.enabled == Some(false) {
    return set_message(app, false, "Desktop alerts are off.");
  }
  let header = crate::briefing::session_header(app).unwrap_or_default();
  if header.is_empty() {
    return set_message(app, false, "Sign in to multiplayer to receive alerts.");
  }
  let account = fingerprint(&header);
  if saved.account != account {
    // A different player signed in: start from their current inbox.
    saved.account = account.clone();
    saved.cursor = None;
  }
  let first = saved.cursor.is_none();
  let request_header = header.clone();
  let cursor = saved.cursor.clone();
  let Ok(outcome) = tauri::async_runtime::spawn_blocking(move || fetch(request_header, cursor)).await else { return };
  // Sign-out, account switch or opt-out while the request was in flight.
  let latest = read(app);
  if latest.enabled == Some(false) || crate::briefing::session_header(app).unwrap_or_default() != header { return; }
  match outcome {
    Outcome::Feed(feed) => {
      if !first && quiet_now(app) {
        // Hold alerts back, cursor included, so they show once quiet hours end.
        return set_message(app, true, "Quiet hours are on. Alerts will show afterwards.");
      }
      if !first && !watching_game(app) {
        for (title, body) in notifications_for(&feed) {
          let _ = app.notification().builder().title(title).body(body).show();
        }
      }
      // A player with an empty inbox starts before everything, so their first alert still shows.
      saved.cursor = feed.cursor.or(saved.cursor).or_else(|| Some("0".repeat(24)));
      saved.enabled = latest.enabled;
      saved.turn_reminder = latest.turn_reminder;
      saved.quiet = latest.quiet;
      saved.last_turn = latest.last_turn;
      saved.turn_account = latest.turn_account;
      let _ = save(app, &saved);
      set_message(app, true, "Desktop alerts are on. New inbox alerts appear while AHDClient is open.");
    }
    Outcome::SignedOut => set_message(app, false, "Sign in to multiplayer to receive alerts."),
    Outcome::Unsupported => set_message(app, false, "The game server does not offer desktop alerts yet. We will keep checking."),
    Outcome::Offline => set_message(app, false, "Could not reach the game. We will retry when online."),
  }
}

/// Runs after each alert check, from the same briefing the launcher shows:
/// keeps the unread badge current and sends the turn reminder.
async fn turn_step(app: &AppHandle) {
  let Ok(briefing) = crate::briefing::get_briefing(app.clone()).await else { return };
  let unread = briefing.inbox.as_ref().map(|i| i.unread).filter(|n| n.is_finite() && *n > 0.0).map(|n| n as i64);
  if let Some(window) = app.get_webview_window("main") { let _ = window.set_badge_count(unread); }
  let Some(current) = briefing.turn.as_ref().and_then(|t| turn_number(t.current)) else { return };
  let Ok(header) = crate::briefing::session_header(app) else { return };
  if header.is_empty() { return; }
  let account = fingerprint(&header);
  let mut saved = read(app);
  if saved.turn_account != account {
    saved.turn_account = account;
    saved.last_turn = None;
  }
  let due = reminder_due(saved.last_turn, current);
  if due || saved.last_turn.is_none() {
    saved.last_turn = Some(current);
    let _ = save(app, &saved);
  }
  if due && saved.turn_reminder == Some(true) && !quiet_now(app) && !playing_singleplayer(app) && !watching_game(app) {
    let _ = app.notification().builder().title(format!("Turn {current} is in")).body("A new turn has started in A House Divided.").show();
  }
}

/// Starts the once-a-minute check. Runs for the life of the app.
pub(crate) fn start(app: &AppHandle) {
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(Duration::from_secs(10)).await;
    loop {
      poll(&app).await;
      turn_step(&app).await;
      tokio::time::sleep(POLL).await;
    }
  });
}

fn status(app: &AppHandle) -> serde_json::Value {
  let state = app.state::<AlertState>();
  let enabled = read(app).enabled != Some(false);
  let message = state.message.lock().map(|m| m.clone()).unwrap_or_default();
  let registered = state.registered.lock().map(|r| *r).unwrap_or(false);
  let permission = !matches!(app.notification().permission_state(), Ok(tauri::plugin::PermissionState::Denied));
  serde_json::json!({
    "enabled": enabled,
    "available": true,
    "permissionGranted": permission,
    "registered": enabled && permission && registered,
    "message": if !enabled { "Desktop alerts are off.".to_string() }
      else if !permission { "Allow notifications for AHDClient in your system settings.".to_string() }
      else if message.is_empty() { "Checking for alerts...".to_string() } else { message },
  })
}

/// Same command names and shape as the phone builds, so one settings control serves both.
#[tauri::command]
pub(crate) fn get_push_status(app: AppHandle) -> serde_json::Value { status(&app) }

#[tauri::command]
pub(crate) async fn configure_push(app: AppHandle, enabled: bool) -> Result<serde_json::Value, String> {
  let mut saved = read(&app);
  saved.enabled = Some(enabled);
  // Turning alerts back on starts from the current inbox, not the gap.
  if enabled { saved.cursor = None; }
  save(&app, &saved)?;
  if enabled {
    if !matches!(app.notification().permission_state(), Ok(tauri::plugin::PermissionState::Granted)) {
      let _ = app.notification().request_permission();
    }
    set_message(&app, false, "Checking for alerts...");
    let poller = app.clone();
    tauri::async_runtime::spawn(async move { poll(&poller).await });
  } else {
    set_message(&app, false, "Desktop alerts are off.");
  }
  #[cfg(desktop)]
  crate::tray::refresh_alerts_label(&app);
  Ok(status(&app))
}

#[tauri::command]
pub(crate) fn get_reminder_settings(app: AppHandle) -> serde_json::Value {
  let saved = read(&app);
  serde_json::json!({ "turnReminder": saved.turn_reminder == Some(true), "quiet": saved.quiet.unwrap_or_default() })
}

#[tauri::command]
pub(crate) fn set_reminder_settings(app: AppHandle, turn_reminder: bool, quiet: Quiet) -> Result<serde_json::Value, String> {
  if quiet.start >= 24 * 60 || quiet.end >= 24 * 60 { return Err("Choose a time of day.".into()); }
  let mut saved = read(&app);
  saved.turn_reminder = Some(turn_reminder);
  saved.quiet = Some(quiet);
  save(&app, &saved)?;
  Ok(get_reminder_settings(app))
}

/// Back to the defaults: reminder off, quiet hours off.
pub(crate) fn reset_reminder(app: &AppHandle) {
  let mut saved = read(app);
  saved.turn_reminder = None;
  saved.quiet = None;
  let _ = save(app, &saved);
}

/// Desktop alerts are local system notifications, so the test is too: it
/// shows one straight away and says whether the system allowed it.
#[tauri::command]
pub(crate) fn send_test_push(app: AppHandle) -> serde_json::Value {
  if matches!(app.notification().permission_state(), Ok(tauri::plugin::PermissionState::Denied)) {
    return serde_json::json!({ "result": "permission_denied" });
  }
  let shown = app
    .notification()
    .builder()
    .title("Test alert")
    .body("Alerts from your inbox will appear like this while AHDClient is open.")
    .show();
  serde_json::json!({ "result": if shown.is_ok() { "sent" } else { "error" } })
}

#[cfg(test)]
mod tests {
  use super::{clean, in_quiet_hours, notifications_for, reminder_due, Feed, FeedItem, Quiet, Saved};

  fn item(title: &str, subtitle: &str, body: &str) -> FeedItem {
    FeedItem { title: title.into(), subtitle: subtitle.into(), body: body.into() }
  }

  #[test]
  fn alerts_show_oldest_first_with_category_and_a_count_for_the_rest() {
    let feed = Feed {
      cursor: Some("507f1f77bcf86cd799439011".into()),
      items: vec![item("Newest", "Election", "You won."), item("Older", "Treasury", "Budget passed.")],
      more: 2,
    };
    assert_eq!(notifications_for(&feed), vec![
      ("Older".to_string(), "Treasury \u{00b7} Budget passed.".to_string()),
      ("Newest".to_string(), "Election \u{00b7} You won.".to_string()),
      ("A House Divided".to_string(), "2 more alerts in your inbox.".to_string()),
    ]);
  }

  #[test]
  fn empty_fields_fall_back_to_readable_text() {
    let feed = Feed { cursor: None, items: vec![item("  ", "", "Body only")], more: 1 };
    assert_eq!(notifications_for(&feed), vec![
      ("A House Divided".to_string(), "Body only".to_string()),
      ("A House Divided".to_string(), "1 more alert in your inbox.".to_string()),
    ]);
  }

  #[test]
  fn server_text_is_flattened_and_bounded() {
    assert_eq!(clean("a\n\tb\u{7}  c", 50), "a b c");
    let long = "word ".repeat(100);
    let cut = clean(&long, 20);
    assert_eq!(cut.chars().count(), 20);
    assert!(cut.ends_with('\u{2026}'));
  }

  #[test]
  fn feed_parses_the_game_response() {
    let feed: Feed = serde_json::from_value(serde_json::json!({
      "cursor": "507f1f77bcf86cd799439011", "more": 0,
      "items": [{ "id": "x", "title": "T", "subtitle": "Party", "body": "B", "href": "/parties/1", "thread": "party" }],
    })).unwrap();
    assert_eq!(feed.items, vec![item("T", "Party", "B")]);
    let baseline: Feed = serde_json::from_value(serde_json::json!({ "cursor": null, "items": [], "more": 0 })).unwrap();
    assert!(notifications_for(&baseline).is_empty());
  }

  #[test]
  fn quiet_hours_cover_overnight_windows_and_default_to_off() {
    let night = Quiet { enabled: true, start: 22 * 60, end: 7 * 60 };
    assert!(in_quiet_hours(&night, 23 * 60));
    assert!(in_quiet_hours(&night, 3 * 60));
    assert!(!in_quiet_hours(&night, 7 * 60));
    assert!(!in_quiet_hours(&night, 12 * 60));
    let day = Quiet { enabled: true, start: 9 * 60, end: 17 * 60 };
    assert!(in_quiet_hours(&day, 10 * 60));
    assert!(!in_quiet_hours(&day, 18 * 60));
    assert!(!in_quiet_hours(&Quiet { enabled: false, ..night }, 23 * 60));
    assert!(!in_quiet_hours(&Quiet { enabled: true, start: 60, end: 60 }, 60));
    let saved: Saved = serde_json::from_str("{}").unwrap();
    // A file written before these settings existed still keeps its alert choice.
    let old: Saved = serde_json::from_str(r#"{"enabled":false,"cursor":"x","account":"a"}"#).unwrap();
    assert_eq!(old.enabled, Some(false));
    assert_eq!(old.turn_reminder, None);
    assert_eq!(saved.turn_reminder, None);
    assert_eq!(saved.quiet, None);
  }

  #[test]
  fn the_reminder_fires_once_per_new_turn_and_never_on_first_sight() {
    assert!(!reminder_due(None, 215));
    assert!(!reminder_due(Some(215), 215));
    assert!(reminder_due(Some(214), 215));
    assert!(!reminder_due(Some(216), 215));
  }
}
