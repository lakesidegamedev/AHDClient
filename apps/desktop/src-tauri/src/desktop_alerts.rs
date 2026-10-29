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
#[serde(rename_all = "camelCase")]
struct Saved {
  /// Missing on first run: desktop alerts default on, with no OS prompt to pass.
  enabled: Option<bool>,
  /// Newest notification already seen, for the account below.
  cursor: Option<String>,
  /// SHA-256 of the session cookies the cursor belongs to.
  account: String,
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
fn fingerprint(header: &str) -> String {
  Sha256::digest(header.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn set_message(app: &AppHandle, registered: bool, message: &str) {
  let state = app.state::<AlertState>();
  if let Ok(mut slot) = state.message.lock() { *slot = message.into(); }
  if let Ok(mut slot) = state.registered.lock() { *slot = registered; };
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
      if !first && !watching_game(app) {
        for (title, body) in notifications_for(&feed) {
          let _ = app.notification().builder().title(title).body(body).show();
        }
      }
      // A player with an empty inbox starts before everything, so their first alert still shows.
      saved.cursor = feed.cursor.or(saved.cursor).or_else(|| Some("0".repeat(24)));
      saved.enabled = latest.enabled;
      let _ = save(app, &saved);
      set_message(app, true, "Desktop alerts are on. New inbox alerts appear while AHDClient is open.");
    }
    Outcome::SignedOut => set_message(app, false, "Sign in to multiplayer to receive alerts."),
    Outcome::Unsupported => set_message(app, false, "The game server does not offer desktop alerts yet. We will keep checking."),
    Outcome::Offline => set_message(app, false, "Could not reach the game. We will retry when online."),
  }
}

/// Starts the once-a-minute check. Runs for the life of the app.
pub(crate) fn start(app: &AppHandle) {
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(Duration::from_secs(10)).await;
    loop {
      poll(&app).await;
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
  Ok(status(&app))
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
  use super::{clean, notifications_for, Feed, FeedItem};

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
}
