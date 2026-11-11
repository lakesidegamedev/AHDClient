//! Native Ask panel backend (desktop only).
//!
//! The Ask service (ask.lakesidegames.net) has no CORS headers and its
//! session cookie is SameSite=Lax, so the launcher webview cannot call it
//! with fetch. All Ask traffic therefore goes through these Rust commands,
//! which read the session cookie out of the shared platform cookie jar (the
//! same jar the sign-in webview writes) and attach it as a plain Cookie
//! header — browsers enforce CORS and SameSite, ureq does not.
//!
//! Two windows:
//! - "ask": the native chat UI, a local view (`index.html?view=ask`) with
//!   the same invoke surface as the launcher. Resumed in place, never
//!   re-navigated.
//! - "ask-auth": a transient zero-capability webview for the one-time
//!   sign-in bounce. A watcher closes it the moment the session cookie
//!   lands and opens the native UI instead, so returning players never see
//!   it at all.

use std::collections::HashMap;
use std::io::BufRead;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;

/// Ask session cookie names. Production has used both the historic
/// `ask_session` name and the host-prefixed `__Host-ask_session` name.
const ASK_SESSION_COOKIES: &[&str] = &["ask_session", "__Host-ask_session"];
const ASK_SESSION_COOKIE: &str = "ask_session";
const ASK_LOGIN_PATH: &str = "auth/login?next=%2F";

/// Ask panel size in logical pixels: a narrow panel that sits beside the
/// game rather than covering it.
const ASK_WINDOW_WIDTH: f64 = 440.0;
const ASK_WINDOW_HEIGHT: f64 = 800.0;

/// How long the sign-in watcher waits for the session cookie. Fast at first
/// so an already-signed-in game account is picked up without a retry click.
const AUTH_WATCH_FAST_POLLS: u32 = 40;
const AUTH_WATCH_FAST_INTERVAL: Duration = Duration::from_millis(250);
const AUTH_WATCH_SLOW_POLLS: u32 = 120;
const AUTH_WATCH_SLOW_INTERVAL: Duration = Duration::from_secs(1);

fn is_ask_session_cookie_name(name: &str) -> bool {
  ASK_SESSION_COOKIES.contains(&name)
}

fn ask_login_url() -> Result<Url, String> {
  format!("{}{ASK_LOGIN_PATH}", crate::ASK_URL)
    .parse()
    .map_err(|e| format!("bad ASK login URL: {e}"))
}

/// Read the Ask session out of the shared platform cookie jar. Any webview
/// will do — they all share the one jar — so try the freshest first.
fn ask_session_cookie(app: &AppHandle) -> Option<String> {
  let url: Url = crate::ASK_URL.parse().ok()?;
  for label in ["ask-auth", "main", "online", "online-embedded", "ask"] {
    let Some(view) = app.get_webview(label) else {
      continue;
    };
    let Ok(cookies) = crate::webview_cookies::cookies_for_url(app, &view, url.clone()) else {
      continue;
    };
    let mut host_prefixed = None;
    let mut legacy = None;
    for cookie in cookies {
      if cookie.value().is_empty() || !is_ask_session_cookie_name(cookie.name()) {
        continue;
      }
      if cookie.name() == "__Host-ask_session" {
        host_prefixed = Some(cookie.value().to_string());
      } else {
        legacy = Some(cookie.value().to_string());
      }
    }
    if host_prefixed.is_some() {
      return host_prefixed;
    }
    if legacy.is_some() {
      return legacy;
    }
  }
  None
}

fn emit_ask_session(app: &AppHandle, ready: bool) {
  let _ = app.emit("ask-session", serde_json::json!({ "ready": ready }));
}

/// Exact routes the native UI may call, with their methods. Everything else
/// is refused client-side; the question stream has its own command.
fn ask_api_allowed(method: &str, path: &str) -> bool {
  let route = path.split(['?', '#']).next().unwrap_or("");
  matches!(
    (method, route),
    ("GET", "/api/me")
      | ("GET", "/api/conversations")
      | ("GET", "/api/conversation")
      | ("POST", "/api/ask/stop")
      | ("POST", "/api/map/render")
  )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AskApiResult {
  status: u16,
  body: String,
}

/// Proxied Ask API call. HTTP statuses pass through untouched (401 means
/// signed out, 429 means quota spent) so the UI can react exactly like the
/// web client; only transport failures and a missing session are errors.
#[tauri::command]
pub(crate) async fn ask_api(
  app: AppHandle,
  method: String,
  path: String,
  body: Option<String>,
) -> Result<AskApiResult, String> {
  if !ask_api_allowed(&method, &path) {
    return Err("unsupported Ask request".into());
  }
  let session = ask_session_cookie(&app).ok_or("Please sign in to Ask first.")?;
  let url = format!("{}{}", crate::ASK_URL.trim_end_matches('/'), path);
  tauri::async_runtime::spawn_blocking(move || {
    let agent = ureq::AgentBuilder::new()
      .timeout(Duration::from_secs(90))
      .build();
    let mut request = match method.as_str() {
      "GET" => agent.get(&url),
      "POST" => agent.post(&url),
      _ => return Err("unsupported Ask request".to_string()),
    };
    request = request
      .set("Cookie", &format!("{ASK_SESSION_COOKIE}={session}; __Host-ask_session={session}"))
      .set("Content-Type", "application/json")
      .set("User-Agent", "AHDClient/2");
    let response = match body {
      Some(payload) => request.send_string(&payload),
      None => request.call(),
    };
    match response {
      Ok(ok) => {
        let status = ok.status();
        let text = ok.into_string().map_err(|_| "cannot read Ask response".to_string())?;
        Ok(AskApiResult { status, body: text })
      }
      Err(ureq::Error::Status(code, failed)) => {
        let text = failed.into_string().unwrap_or_default();
        Ok(AskApiResult { status: code, body: text })
      }
      Err(_) => Err("Cannot reach Ask. Connect to the internet and try again.".into()),
    }
  })
  .await
  .map_err(|_| "Ask request failed".to_string())?
}

/// One entry per in-flight question so Stop can kill the pump thread. The
/// server-side generation is cancelled separately through /api/ask/stop.
#[derive(Default)]
pub(crate) struct AskStreamState(Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AskStreamEvent {
  req_id: String,
  kind: String,
  data: serde_json::Value,
}

fn emit_stream(app: &AppHandle, req_id: &str, kind: &str, data: serde_json::Value) {
  // Global broadcast: only the ask window listens for this event.
  let _ = app.emit(
    "ask-stream",
    AskStreamEvent {
      req_id: req_id.to_string(),
      kind: kind.to_string(),
      data,
    },
  );
}

fn forget_stream(app: &AppHandle, req_id: &str) {
  if let Ok(mut inflight) = app.state::<AskStreamState>().0.lock() {
    inflight.remove(req_id);
  }
}

/// Start a question. Returns a client request id immediately; answer events
/// arrive on the `ask-stream` window event: `meta`, `status`, `action`,
/// `delta`, `done`, `final` (non-streaming JSON reply: cache hit, quota
/// refusal), `error`, `stopped`.
#[tauri::command]
pub(crate) async fn ask_send(
  app: AppHandle,
  state: State<'_, AskStreamState>,
  question: String,
  conv_id: Option<String>,
  use_mcp: bool,
) -> Result<String, String> {
  if question.trim().len() < 5 {
    return Err("Please ask a slightly longer question.".into());
  }
  let session = ask_session_cookie(&app).ok_or("Please sign in to Ask first.")?;
  let mut entropy = [0_u8; 9];
  getrandom::getrandom(&mut entropy).map_err(|_| "secure random source unavailable".to_string())?;
  let req_id = entropy.iter().map(|b| format!("{b:02x}")).collect::<String>();
  let stop = Arc::new(AtomicBool::new(false));
  state
    .0
    .lock()
    .map_err(|_| "Ask state poisoned".to_string())?
    .insert(req_id.clone(), stop.clone());
  let pump_app = app.clone();
  let pump_req_id = req_id.clone();
  tauri::async_runtime::spawn_blocking(move || {
    pump_ask_stream(&pump_app, &pump_req_id, stop, session, question, conv_id, use_mcp);
  });
  Ok(req_id)
}

/// Stop a question: halt the local pump and tell the server to abort the
/// generation, which records nothing and costs no quota.
#[tauri::command]
pub(crate) async fn ask_stop(
  app: AppHandle,
  state: State<'_, AskStreamState>,
  req_id: String,
) -> Result<(), String> {
  if let Ok(guard) = state.0.lock() {
    if let Some(stop) = guard.get(&req_id) {
      stop.store(true, Ordering::SeqCst);
    }
  }
  if let Some(session) = ask_session_cookie(&app) {
    let url = format!("{}/api/ask/stop", crate::ASK_URL.trim_end_matches('/'));
    let payload = serde_json::json!({ "reqId": req_id }).to_string();
    tauri::async_runtime::spawn_blocking(move || {
      let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(15))
        .build();
      let _ = agent
        .post(&url)
        .set("Cookie", &format!("{ASK_SESSION_COOKIE}={session}; __Host-ask_session={session}"))
        .set("Content-Type", "application/json")
        .send_string(&payload);
    });
  }
  Ok(())
}

#[allow(clippy::too_many_arguments)]
fn pump_ask_stream(
  app: &AppHandle,
  req_id: &str,
  stop: Arc<AtomicBool>,
  session: String,
  question: String,
  conv_id: Option<String>,
  use_mcp: bool,
) {
  let finish = |kind: &str, data: serde_json::Value| {
    emit_stream(app, req_id, kind, data);
  };
  let url = format!("{}/api/ask", crate::ASK_URL.trim_end_matches('/'));
  let payload = serde_json::json!({
    "question": question,
    "convId": conv_id,
    "useMcp": use_mcp,
    // The service validates this against its zone database and drops anything
    // else, so an empty value simply falls back to UTC.
    "tz": "",
  })
  .to_string();

  let agent = ureq::AgentBuilder::new()
    .timeout(Duration::from_secs(600))
    .build();
  let response = agent
    .post(&url)
    .set("Cookie", &format!("{ASK_SESSION_COOKIE}={session}; __Host-ask_session={session}"))
    .set("Content-Type", "application/json")
    .set("User-Agent", "AHDClient/2")
    .send_string(&payload);
  let response = match response {
    Ok(ok) => ok,
    Err(ureq::Error::Status(code, failed)) => {
      let text = failed.into_string().unwrap_or_default();
      finish(
        "final",
        serde_json::json!({ "status": code, "body": text }),
      );
      forget_stream(app, req_id);
      return;
    }
    Err(_) => {
      finish(
        "error",
        serde_json::json!({ "error": "Cannot reach Ask. Connect to the internet and try again." }),
      );
      forget_stream(app, req_id);
      return;
    }
  };

  let streaming = response
    .header("Content-Type")
    .is_some_and(|content| content.contains("text/event-stream"));
  if !streaming {
    let status = response.status();
    let text = response.into_string().unwrap_or_default();
    finish("final", serde_json::json!({ "status": status, "body": text }));
    forget_stream(app, req_id);
    return;
  }

  let reader = std::io::BufReader::new(response.into_reader());
  let mut parser = SseParser::default();
  let mut terminal = false;
  for line in reader.lines() {
    if stop.load(Ordering::SeqCst) {
      finish("stopped", serde_json::Value::Null);
      terminal = true;
      break;
    }
    let line = match line {
      Ok(text) => text,
      Err(_) => break,
    };
    if let Some((kind, data)) = parser.push_line(&line) {
      if kind == "done" || kind == "error" {
        terminal = true;
      }
      finish(&kind, data);
      if terminal {
        break;
      }
    }
  }
  if !terminal && !stop.load(Ordering::SeqCst) {
    finish(
      "error",
      serde_json::json!({ "error": "The answer stream ended before completion. It may still be saved. Check your history in a moment, or try again." }),
    );
  }
  forget_stream(app, req_id);
}

/// Top-left origin that docks the Ask panel against the right edge of the
/// primary monitor, vertically centered. Pure so it can be unit-tested;
/// inputs are physical pixels except `scale`.
pub(crate) fn ask_dock_origin(monitor_width: u32, monitor_height: u32, scale: f64) -> (i32, i32) {
  let width = (ASK_WINDOW_WIDTH * scale) as u32;
  let height = (ASK_WINDOW_HEIGHT * scale) as u32;
  let margin = (12.0 * scale) as u32;
  let x = monitor_width.saturating_sub(width).saturating_sub(margin) as i32;
  let y = monitor_height.saturating_sub(height) as i32 / 2;
  (x.max(0), y.max(0))
}

/// Logical-pixel form of [`ask_dock_origin`] for
/// `WebviewWindowBuilder::position`, which takes logical coordinates. The
/// monitor's own top-left (physical pixels, can be negative on a second
/// screen) is added so the panel lands on that monitor, not the primary one.
pub(crate) fn ask_dock_logical_on(
  monitor_x: i32,
  monitor_y: i32,
  monitor_width: u32,
  monitor_height: u32,
  scale: f64,
) -> (f64, f64) {
  let (x, y) = ask_dock_origin(monitor_width, monitor_height, scale);
  (
    (f64::from(monitor_x) + f64::from(x)) / scale,
    (f64::from(monitor_y) + f64::from(y)) / scale,
  )
}

/// Open the native Ask panel, or resume it in place. A signed-in player
/// goes straight to the chat UI; anyone else gets the one-time sign-in
/// window, which closes itself the moment the session lands.
/// Focus the native UI, building it first when it does not exist yet.
fn focus_ask_ui(app: &AppHandle) -> Result<(), String> {
  if let Some(existing) = app.get_webview_window("ask") {
    existing.show().map_err(|e| e.to_string())?;
    existing.set_focus().map_err(|e| e.to_string())?;
    return Ok(());
  }
  open_ask_ui(app)
}

fn watch_ask_login(app: AppHandle) {
  std::thread::spawn(move || {
    let intervals = std::iter::repeat(AUTH_WATCH_FAST_INTERVAL)
      .take(AUTH_WATCH_FAST_POLLS as usize)
      .chain(std::iter::repeat(AUTH_WATCH_SLOW_INTERVAL).take(AUTH_WATCH_SLOW_POLLS as usize));
    for interval in intervals {
      std::thread::sleep(interval);
      let auth_open = app.get_webview_window("ask-auth").is_some();
      if ask_session_cookie(&app).is_some() {
        if let Some(auth) = app.get_webview_window("ask-auth") {
          let _ = auth.close();
        }
        let _ = focus_ask_ui(&app);
        emit_ask_session(&app, true);
        break;
      }
      if !auth_open {
        break;
      }
    }
  });
}

/// Open the native Ask panel first. A signed-in player stays there. Anyone
/// else still sees the native shell; a small broker bounce reuses the
/// existing game login instead of loading the Ask website.
#[tauri::command]
pub(crate) async fn open_ask_window(app: AppHandle) -> Result<(), String> {
  focus_ask_ui(&app)?;
  if ask_session_cookie(&app).is_some() {
    emit_ask_session(&app, true);
    return Ok(());
  }
  open_ask_auth(&app)?;
  watch_ask_login(app);
  Ok(())
}

/// The native chat UI: a local view, so it renders instantly, works offline
/// except for the answers themselves, and needs no remote capability.
fn open_ask_ui(app: &AppHandle) -> Result<(), String> {
  let mut builder = WebviewWindowBuilder::new(app, "ask", WebviewUrl::App("index.html?view=ask".into()))
    .title("A House Divided: Ask")
    .inner_size(ASK_WINDOW_WIDTH, ASK_WINDOW_HEIGHT)
    .min_inner_size(320.0, 480.0)
    .resizable(true)
    .background_color(tauri::window::Color(0x14, 0x14, 0x1c, 0xff))
    .on_navigation(|url| {
      (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
    })
    .on_new_window({
      let popup_app = app.clone();
      move |url, _features| {
        // Citation links leave the panel for the system browser; nothing
        // else may open a window from here.
        if matches!(url.scheme(), "https" | "http") {
          let _ = popup_app.opener().open_url(url.to_string(), None::<&str>);
        }
        tauri::webview::NewWindowResponse::Deny
      }
    });

  // Dock on the screen the game is on; fall back to the primary one.
  let monitor = app
    .get_webview_window("main")
    .and_then(|main| main.current_monitor().ok().flatten())
    .or_else(|| app.primary_monitor().ok().flatten());
  if let Some(monitor) = monitor {
    let size = monitor.size();
    let pos = monitor.position();
    let (x, y) = ask_dock_logical_on(pos.x, pos.y, size.width, size.height, monitor.scale_factor());
    builder = builder.position(x, y);
  } else {
    builder = builder.center();
  }

  let window = builder.build().map_err(|e| e.to_string())?;
  let close_app = app.clone();
  window.on_window_event(move |event| {
    if matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
      if let Some(main) = close_app.get_webview_window("main") {
        let _ = main.set_focus();
      }
    }
  });
  Ok(())
}

/// The one-time sign-in bounce. Zero capabilities, the same Ask navigation
/// guard as before, and it never outlives the login: the watcher above
/// closes it as soon as the session cookie lands.
fn open_ask_auth(app: &AppHandle) -> Result<(), String> {
  if let Some(existing) = app.get_webview_window("ask-auth") {
    existing.set_focus().map_err(|e| e.to_string())?;
    return Ok(());
  }
  let url = ask_login_url()?;
  let nav_app = app.clone();
  let new_window_app = app.clone();
  let close_app = app.clone();
  let window = WebviewWindowBuilder::new(app, "ask-auth", WebviewUrl::External(url))
    .title("Sign in to Ask")
    .inner_size(440.0, 640.0)
    .center()
    .resizable(true)
    .on_navigation(move |url| {
      if crate::is_ask_navigation_allowed(url) {
        true
      } else {
        let _ = nav_app.opener().open_url(url.to_string(), None::<&str>);
        false
      }
    })
    .on_new_window(move |url, _features| {
      let _ = new_window_app
        .opener()
        .open_url(url.to_string(), None::<&str>);
      tauri::webview::NewWindowResponse::Deny
    })
    .build()
    .map_err(|e| e.to_string())?;
  window.on_window_event(move |event| {
    if matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
      if let Some(main) = close_app.get_webview_window("main") {
        let _ = main.set_focus();
      }
    }
  });
  Ok(())
}

/// Incremental Server-Sent Events framing for the answer stream: one blank
/// line dispatches the pending event, `data:` lines join with newlines, and
/// `:` comment lines (keepalives) are ignored. Pure so the exact wire shape
/// the service speaks stays covered without a networked test.
struct SseParser {
  event: String,
  data_lines: Vec<String>,
}

impl Default for SseParser {
  /// Unnamed data blocks dispatch as "message", per the SSE specification.
  fn default() -> Self {
    Self {
      event: String::from("message"),
      data_lines: Vec::new(),
    }
  }
}

impl SseParser {
  fn push_line(&mut self, line: &str) -> Option<(String, serde_json::Value)> {
    if line.is_empty() {
      if self.data_lines.is_empty() {
        self.event = String::from("message");
        return None;
      }
      let data = serde_json::from_str::<serde_json::Value>(&self.data_lines.join("\n"))
        .unwrap_or(serde_json::Value::Null);
      let kind = std::mem::replace(&mut self.event, String::from("message"));
      self.data_lines.clear();
      return Some((kind, data));
    }
    if line.starts_with(':') {
      return None;
    }
    if let Some(name) = line.strip_prefix("event:") {
      self.event = name.trim().to_string();
    } else if let Some(chunk) = line.strip_prefix("data:") {
      // SSE strips one leading space after the colon; the payload keeps the rest.
      self.data_lines.push(chunk.strip_prefix(' ').unwrap_or(chunk).to_string());
    }
    None
  }
}

#[cfg(test)]
mod tests {
  use super::{ask_api_allowed, ask_dock_logical_on, ask_dock_origin, ask_login_url, is_ask_session_cookie_name, SseParser};

  #[test]
  fn ask_panel_docks_against_the_right_edge() {
    // 1920x1080 at scale 1: 440-wide panel, 12px margin.
    assert_eq!(ask_dock_origin(1920, 1080, 1.0), (1468, 140));
    // Hidpi scale factor scales the panel and the margin together.
    assert_eq!(ask_dock_origin(3840, 2160, 2.0), (2936, 280));
    // A monitor narrower than the panel clamps to the left edge instead of
    // wrapping around.
    assert_eq!(ask_dock_origin(320, 480, 1.0), (0, 0));
  }

  #[test]
  fn ask_panel_follows_the_monitor_the_game_is_on() {
    // A second screen to the right of a 1920 wide primary.
    assert_eq!(ask_dock_logical_on(1920, 0, 1920, 1080, 1.0), (3388.0, 140.0));
    // A screen to the left has a negative origin.
    assert_eq!(ask_dock_logical_on(-1920, 0, 1920, 1080, 1.0), (-452.0, 140.0));
    // Hidpi: the result is logical, so it divides by the scale.
    assert_eq!(ask_dock_logical_on(3840, 0, 3840, 2160, 2.0), (3388.0, 140.0));
  }

  #[test]
  fn sse_framing_matches_the_answer_stream() {
    // A realistic answer opening: keepalive comment, meta, status, deltas.
    let wire = [
      ": keepalive",
      "event: meta",
      "data: {\"convId\":\"abc123\",\"reqId\":\"r1\"}",
      "",
      "event: status",
      "data: {\"label\":\"Checking map data…\"}",
      "",
      "event: delta",
      "data: \"The North \"",
      "",
      "event: delta",
      "data: \"holds.\"",
      "",
      "event: done",
      "data: {\"answer\":\"The North holds.\",\"usage\":{\"remaining\":4}}",
      "",
    ];
    let mut parser = SseParser::default();
    let events: Vec<(String, serde_json::Value)> =
      wire.iter().filter_map(|line| parser.push_line(line)).collect();
    assert_eq!(events.len(), 5);
    assert_eq!(events[0].0, "meta");
    assert_eq!(events[0].1["convId"], serde_json::json!("abc123"));
    assert_eq!(events[1].0, "status");
    assert_eq!(events[2], ("delta".to_string(), serde_json::json!("The North ")));
    assert_eq!(events[3], ("delta".to_string(), serde_json::json!("holds.")));
    assert_eq!(events[4].0, "done");
    assert_eq!(events[4].1["usage"]["remaining"], serde_json::json!(4));
  }

  #[test]
  fn sse_ignores_stray_blanks_and_joins_split_payloads() {
    let mut parser = SseParser::default();
    assert!(parser.push_line("").is_none());
    assert!(parser.push_line(": ping").is_none());
    assert!(parser.push_line("event: delta").is_none());
    assert!(parser.push_line("data: {\"a\":").is_none());
    let event = parser.push_line("data: 1}");
    assert!(event.is_none());
    let event = parser.push_line("");
    assert_eq!(
      event,
      Some(("delta".to_string(), serde_json::json!({"a": 1})))
    );
    // A data block with no event name dispatches as "message".
    assert!(parser.push_line("data: 7").is_none());
    let event = parser.push_line("");
    assert_eq!(event, Some(("message".to_string(), serde_json::json!(7))));
  }

  #[test]
  fn ask_session_cookie_names_cover_host_prefixed_and_legacy() {
    assert!(is_ask_session_cookie_name("ask_session"));
    assert!(is_ask_session_cookie_name("__Host-ask_session"));
    assert!(!is_ask_session_cookie_name("__Host-lakeside_session"));
    assert!(!is_ask_session_cookie_name("auth-token"));
  }

  #[test]
  fn ask_sign_in_uses_the_login_bounce_not_the_website() {
    let url = ask_login_url().expect("login url");
    assert_eq!(url.host_str(), Some("ask.lakesidegames.net"));
    assert_eq!(url.path(), "/auth/login");
    assert!(url.query().unwrap_or("").contains("next="));
  }

  #[test]
  fn ask_proxy_reaches_only_the_chat_routes() {
    assert!(ask_api_allowed("GET", "/api/me"));
    assert!(ask_api_allowed("GET", "/api/conversations"));
    assert!(ask_api_allowed("GET", "/api/conversation?id=abc123"));
    assert!(ask_api_allowed("POST", "/api/ask/stop"));
    assert!(ask_api_allowed("POST", "/api/map/render"));
    assert!(!ask_api_allowed("GET", "/api/ask"));
    assert!(!ask_api_allowed("POST", "/api/me"));
    assert!(!ask_api_allowed("POST", "/api/conversation/share"));
    assert!(!ask_api_allowed("POST", "/api/answer/feedback"));
    assert!(!ask_api_allowed("GET", "/api/uploads/x"));
    assert!(!ask_api_allowed("GET", "/console"));
    assert!(!ask_api_allowed("DELETE", "/api/upload"));
  }

  #[test]
  fn ask_proxy_matches_routes_exactly_not_by_prefix() {
    // Queries and fragments ride along on allowed routes.
    assert!(ask_api_allowed("GET", "/api/me?fresh=1"));
    assert!(ask_api_allowed("GET", "/api/conversation?id=abc#turn-3"));
    assert!(ask_api_allowed("POST", "/api/map/render?flat=1"));
    // Trailing slashes, case shifts, and sub-paths are different routes.
    assert!(!ask_api_allowed("GET", "/api/me/"));
    assert!(!ask_api_allowed("GET", "/api/ME"));
    assert!(!ask_api_allowed("GET", "/api/conversations/extra"));
    assert!(!ask_api_allowed("GET", "/api/conversation/abc123"));
    assert!(!ask_api_allowed("GET", "/api/map/render/preview"));
    // Methods are case-sensitive and route-bound: the stream entry point
    // and the conversation writer have no proxied form.
    assert!(!ask_api_allowed("get", "/api/me"));
    assert!(!ask_api_allowed("Get", "/api/me"));
    assert!(!ask_api_allowed("GET", "/api/map/render"));
    assert!(!ask_api_allowed("POST", "/api/conversation"));
    assert!(!ask_api_allowed("POST", "/api/conversations"));
    assert!(!ask_api_allowed("", "/api/me"));
    assert!(!ask_api_allowed("GET", ""));
  }

  #[test]
  fn sse_tolerates_spacing_quirks_and_resets_after_dispatch() {
    let mut parser = SseParser::default();
    // No space after the colon and extra space around the event name.
    assert!(parser.push_line("event:  delta").is_none());
    assert!(parser.push_line("data:{\"a\":1}").is_none());
    assert_eq!(
      parser.push_line(""),
      Some(("delta".to_string(), serde_json::json!({"a": 1})))
    );
    // The event name resets: an unnamed block dispatches as "message".
    assert!(parser.push_line("data: 2").is_none());
    assert_eq!(
      parser.push_line(""),
      Some(("message".to_string(), serde_json::json!(2)))
    );
    // Non-JSON payloads surface as Null rather than poisoning the parser.
    assert!(parser.push_line("event: delta").is_none());
    assert!(parser.push_line("data: not json at all").is_none());
    assert_eq!(
      parser.push_line(""),
      Some(("delta".to_string(), serde_json::Value::Null))
    );
    // Multi-line data blocks join with newlines before parsing.
    assert!(parser.push_line("data: {\"a\":").is_none());
    assert!(parser.push_line("data: 1}").is_none());
    assert_eq!(
      parser.push_line(""),
      Some(("message".to_string(), serde_json::json!({"a": 1})))
    );
  }
}
