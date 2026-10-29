//! Mobile half of AHDClient (Android and iOS).
//!
//! One webview and no child processes. The launcher is the app's own page;
//! "Enter multiplayer" and "Link account" navigate that same webview to the
//! live site, which is how the site's cookie-backed session (and its OAuth
//! callbacks) stay inside the app. Remote pages never receive Tauri IPC: the
//! mobile capability is scoped to the app origin and Tauri exposes nothing to
//! other origins. The way back is the native tab bar (NativeNav.kt and
//! NativeNav.swift), which loads the launcher page directly; Android's system
//! back button walks the same history.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use crate::{help_destination, is_ask_navigation_allowed, is_embed_only, is_frame_scheme, is_online_navigation_allowed, linked_account, HelpDestination, ONLINE_URL, SANDBOX_HOST, SANDBOX_URL};

/// Appended to the platform WebView user agent (Android, in MainActivity.kt)
/// or used as the WebKit-shaped custom agent (iOS). The site keys ad slots,
/// consent prompts and the cookie banner off this marker.
pub(crate) const USER_AGENT_MARKER: &str = concat!("AHDClient-Mobile/", env!("CARGO_PKG_VERSION"));

/// Where the launcher lives once the webview is up. Captured at creation so
/// a custom-protocol change never strands the player on the site.
struct LauncherHome(Mutex<Option<Url>>);

/// Generation counter for the account-link watcher so a second Link tap
/// retires the first watcher instead of racing it.
struct LinkWatch(AtomicU64);

const LINK_POLL: Duration = Duration::from_millis(2500);
const LINK_DEADLINE: Duration = Duration::from_secs(10 * 60);

/// Fallback only. The native tab bar replaced this floating AHD button and its
/// menu in 2.7; once the bar attaches it marks every page with
/// `window.__ahdclientNativeTabs` and this script stays silent. It is kept so
/// a phone whose bar failed to attach still has a way back to the launcher.
/// Mounted after `load` (so hydration has finished) and re-mounted if the
/// site's router ever drops it. Nothing on the app's own pages.
const LAUNCHER_CONTROL_SCRIPT: &str = r#"
(function () {
  if (location.protocol === 'tauri:' || location.hostname === 'tauri.localhost') return;
  function mount() {
    if (window.__ahdclientNativeTabs) return;
    if (!document.body || document.getElementById('ahdclient-launcher')) return;
    var bottom = 'max(14px,env(safe-area-inset-bottom))';
    var menu = document.createElement('div');
    var button;
    menu.id = 'ahdclient-game-menu';
    menu.setAttribute('aria-label', 'AHDClient game menu');
    menu.style.cssText = 'position:fixed;left:max(10px,env(safe-area-inset-left));bottom:calc(' + bottom + ' + 58px);z-index:2147483646;display:none;flex-wrap:wrap;max-width:calc(100vw - 20px);gap:8px;padding:9px;border:1px solid rgba(255,255,255,.28);border-radius:14px;background:rgba(20,20,28,.94);box-shadow:0 8px 28px rgba(0,0,0,.35);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);';
    function action(label, destination) {
      var item = document.createElement('button');
      item.type = 'button';
      item.textContent = label;
      item.style.cssText = 'min-width:78px;height:38px;padding:0 12px;border:1px solid rgba(255,255,255,.22);border-radius:9px;background:rgba(255,255,255,.1);color:#fff;font:600 13px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;';
      item.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        menu.style.display = 'none';
        button.setAttribute('aria-expanded', 'false');
        location.href = destination;
      });
      return item;
    }
    menu.appendChild(action('Game home', 'https://ahousedividedgame.com/'));
    menu.appendChild(action('Inbox', 'https://ahousedividedgame.com/notifications'));
    menu.appendChild(action('Briefing', 'ahdclient://launcher/briefing'));
    menu.appendChild(action('Ask', 'ahdclient://ask'));
    menu.appendChild(action('Launcher', 'ahdclient://launcher'));
    document.body.appendChild(menu);
    button = document.createElement('button');
    button.id = 'ahdclient-launcher';
    button.type = 'button';
    button.setAttribute('aria-label', 'Open the AHDClient game menu');
    button.setAttribute('aria-expanded', 'false');
    button.textContent = 'AHD';
    button.style.cssText = 'position:fixed;left:max(10px,env(safe-area-inset-left));bottom:max(14px,env(safe-area-inset-bottom));z-index:2147483647;width:44px;height:44px;padding:0;border-radius:50%;border:1px solid rgba(255,255,255,.35);background:rgba(20,20,28,.74);color:#fff;font:700 12px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.04em;opacity:.6;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);cursor:pointer;';
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      var open = menu.style.display !== 'flex';
      menu.style.display = open ? 'flex' : 'none';
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function (event) {
      if (menu.style.display === 'flex' && event.target !== button && !menu.contains(event.target)) {
        menu.style.display = 'none';
        button.setAttribute('aria-expanded', 'false');
      }
    });
    document.body.appendChild(button);
  }
  // Sit above any fixed or sticky bar at the bottom-left (the game's status
  // bar), instead of covering it. Re-checked as pages change.
  function lift() {
    var button = document.getElementById('ahdclient-launcher');
    var menu = document.getElementById('ahdclient-game-menu');
    if (!button || !menu) return;
    var top = window.innerHeight;
    var probe = document.elementsFromPoint(32, window.innerHeight - 24);
    for (var i = 0; i < probe.length; i++) {
      for (var node = probe[i]; node && node !== document.body; node = node.parentElement) {
        if (node === button || node === menu) break;
        var position = getComputedStyle(node).position;
        if (position === 'fixed' || position === 'sticky') {
          var rect = node.getBoundingClientRect();
          if (rect.bottom >= window.innerHeight - 2 && rect.height < window.innerHeight / 3) top = Math.min(top, rect.top);
          break;
        }
      }
    }
    var gap = window.innerHeight - top;
    var bottom = gap > 0 ? (gap + 10) + 'px' : 'max(14px,env(safe-area-inset-bottom))';
    if (button.style.bottom !== bottom) {
      button.style.bottom = bottom;
      menu.style.bottom = 'calc(' + bottom + ' + 58px)';
    }
  }
  function tick() { mount(); lift(); }
  if (document.readyState === 'complete') tick();
  else window.addEventListener('load', tick);
  window.addEventListener('resize', lift);
  setInterval(tick, 2000);
})();
"#;

/// Pull down from the top of a remote page to reload it. iOS only: Safari has
/// this natively and WKWebView does not. Android's WebView is left as it was.
#[cfg(target_os = "ios")]
const PULL_REFRESH_SCRIPT: &str = include_str!("pull_refresh.js");

/// The app's own origin: `tauri://localhost` on iOS, `http://tauri.localhost`
/// on Android. Anything else is remote.
fn is_app_origin(url: &Url) -> bool {
  url.scheme() == "tauri" || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
}

fn is_launcher_request(url: &Url) -> bool {
  url.scheme() == "ahdclient" && url.host_str() == Some("launcher")
}

fn launcher_home(app: &AppHandle) -> Url {
  app
    .try_state::<LauncherHome>()
    .and_then(|home| home.0.lock().ok().and_then(|url| url.clone()))
    .unwrap_or_else(|| {
      let fallback = if cfg!(target_os = "android") { "http://tauri.localhost/" } else { "tauri://localhost/" };
      fallback.parse().expect("static launcher URL")
    })
}

fn main_webview(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
  app.get_webview_window("main").ok_or_else(|| "the app webview is missing".to_string())
}

pub(crate) fn navigate_main(app: &AppHandle, url: Url) -> Result<(), String> {
  main_webview(app)?.navigate(url).map_err(|e| e.to_string())
}

pub(crate) fn open_widget_link(app: &AppHandle, url: &Url) {
  if url.scheme() != "ahdclient" { return; }
  // `ahdclient://ask` opens the native Ask sheet (iOS delivers it here;
  // Android handles it in MainActivity).
  if url.host_str() == Some("ask") {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
      for _ in 0..50 {
        if app.get_webview("main").is_some() {
          let _ = present_native_ask(app).await;
          return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
      }
    });
    return;
  }
  let page = crate::links::widget_page(url);
  let section = if url.host_str() == Some("briefing") { crate::briefing::Section::from_link(url.path()) } else { None };
  if page.is_none() && section.is_none() { return; }
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    // A cold launch may deliver the URL just before the main view is ready.
    for _ in 0..50 {
      if app.get_webview("main").is_some() {
        let _ = match (page, section) {
          (Some(path), _) => crate::briefing::open_game_page(app, path).await,
          (None, Some(section)) => crate::briefing::open_briefing_page(app, section).await,
          (None, None) => Ok(()),
        };
        return;
      }
      tokio::time::sleep(Duration::from_millis(100)).await;
    }
  });
}

/// Leave the remote page for the launcher. Deferred off the navigation
/// callback so the platform webview finishes cancelling the current request
/// before it is asked to load another.
fn go_home_soon(app: &AppHandle, request: &Url) {
  let app = app.clone();
  let target = crate::links::launcher_target(&launcher_home(&app), request);
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(Duration::from_millis(30)).await;
    let _ = navigate_main(&app, target);
  });
}

/// Hand a URL to the system from a worker thread. The navigation callbacks
/// run on the UI thread, and on Android the opener plugin queues its work for
/// that same thread and then blocks until it answers. Called inline it never
/// returns: the app ignores every tap until Android reports it as not
/// responding (ticket 1450, Continue with Discord on the sign-in page).
fn open_externally(app: &AppHandle, url: &Url) {
  if matches!(url.scheme(), "https" | "http" | "mailto") {
    let app = app.clone();
    let url = url.to_string();
    tauri::async_runtime::spawn_blocking(move || {
      let _ = app.opener().open_url(url, None::<&str>);
    });
  }
}

/// The sandbox is a supporter perk bought outside the App Store, so the
/// iPhone app never shows it (guideline 3.1.1) and a sandbox link opens in
/// the browser there. Android is distributed outside Google Play and keeps
/// the sandbox for linked supporters.
fn is_app_navigation_allowed(url: &Url) -> bool {
  (is_app_origin(url) || is_online_navigation_allowed(url))
    && (SANDBOX_IN_APP || url.host_str() != Some(SANDBOX_HOST))
}

const SANDBOX_IN_APP: bool = cfg!(target_os = "android");

fn is_native_ask_request(url: &Url) -> bool {
  (url.scheme() == "ahdclient" && url.host_str() == Some("ask")) || is_ask_navigation_allowed(url)
}

#[derive(Debug, PartialEq, Eq)]
enum MobileNavigationAction {
  ReturnHome,
  PresentAsk,
  InApp,
  External,
  /// Cancel without handing the URL to another app.
  Ignore,
}

/// WKWebView reports every navigation to this policy, iframes included, with
/// no main-frame flag (wry 0.55 `navigation_policy`). Frame-only schemes stay
/// in the webview; embed hosts are dropped; only real page links leave the app.
/// Discord's OAuth consent page. On Android it is handed to the system so the
/// Discord app (where the player is already signed in) can take it; the
/// callback returns to this app through a verified App Link (see
/// AndroidManifest.xml and the site's /.well-known/assetlinks.json). Inside
/// the WebView the player would have to log in to Discord from scratch.
fn is_discord_authorize(url: &Url) -> bool {
  url.scheme() == "https"
    && matches!(url.host_str(), Some("discord.com") | Some("www.discord.com") | Some("ptb.discord.com") | Some("canary.discord.com"))
    && (url.path().starts_with("/oauth2/authorize") || url.path().starts_with("/api/oauth2/authorize"))
}

fn classify_navigation(url: &Url) -> MobileNavigationAction {
  if is_launcher_request(url) {
    return MobileNavigationAction::ReturnHome;
  }
  if cfg!(target_os = "android") && is_discord_authorize(url) {
    return MobileNavigationAction::External;
  }
  if is_frame_scheme(url) {
    return MobileNavigationAction::InApp;
  }
  if is_app_navigation_allowed(url) {
    return MobileNavigationAction::InApp;
  }
  if is_embed_only(url) {
    return MobileNavigationAction::Ignore;
  }
  if is_native_ask_request(url) {
    return MobileNavigationAction::PresentAsk;
  }
  MobileNavigationAction::External
}

async fn present_native_ask(app: AppHandle) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    app.state::<tauri_plugin_briefing_widgets::NativeCompanion<tauri::Wry>>().show_ask()
  }).await.map_err(|_| "Could not open native Ask".to_string())??;
  Ok(())
}

/// Allowed in the app webview: the launcher itself and the online allowlist.
/// Ask links are converted to the native panel so they never fall through to
/// a browser or a remote Ask webview.
fn navigation_policy(app: &AppHandle, url: &Url) -> bool {
  match classify_navigation(url) {
    MobileNavigationAction::ReturnHome => {
      go_home_soon(app, url);
      false
    }
    MobileNavigationAction::PresentAsk => {
      let app = app.clone();
      tauri::async_runtime::spawn(async move { let _ = present_native_ask(app).await; });
      false
    }
    MobileNavigationAction::InApp => true,
    MobileNavigationAction::External => {
      open_externally(app, url);
      false
    }
    MobileNavigationAction::Ignore => false,
  }
}

fn user_agent() -> Option<String> {
  if cfg!(target_os = "ios") {
    // WKWebView has no "append" hook; this is the shape iOS 17 reports, with
    // the marker the site keys on. Android appends in MainActivity.kt instead.
    Some(format!(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 {USER_AGENT_MARKER}"
    ))
  } else {
    None
  }
}

fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
  let nav_app = app.clone();
  let popup_app = app.clone();
  let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
    .title("A House Divided")
    .background_color(tauri::window::Color(0x14, 0x14, 0x1c, 0xff))
    .initialization_script(LAUNCHER_CONTROL_SCRIPT)
    .on_navigation(move |url| navigation_policy(&nav_app, url))
    .on_new_window(move |url, _features| {
      match classify_navigation(&url) {
        MobileNavigationAction::ReturnHome => go_home_soon(&popup_app, &url),
        MobileNavigationAction::PresentAsk => {
          let app = popup_app.clone();
          tauri::async_runtime::spawn(async move { let _ = present_native_ask(app).await; });
        }
        MobileNavigationAction::InApp => {
          let _ = navigate_main(&popup_app, url.clone());
        }
        MobileNavigationAction::External => open_externally(&popup_app, &url),
        MobileNavigationAction::Ignore => {}
      }
      tauri::webview::NewWindowResponse::Deny
    });
  #[cfg(target_os = "ios")]
  {
    builder = builder.initialization_script(PULL_REFRESH_SCRIPT);
  }
  if let Some(agent) = user_agent() {
    builder = builder.user_agent(&agent);
  }
  let window = builder.build()?;
  // Swipe in from the left edge to go back a page, as in Safari. Tauri does
  // not expose wry's setting, so set it on the WKWebView directly.
  #[cfg(target_os = "ios")]
  let _ = window.with_webview(|webview| unsafe {
    let view = &*(webview.inner() as *mut objc2::runtime::AnyObject);
    let _: () = objc2::msg_send![view, setAllowsBackForwardNavigationGestures: true];
  });
  if let (Ok(url), Some(home)) = (window.url(), app.try_state::<LauncherHome>()) {
    if let Ok(mut slot) = home.0.lock() {
      *slot = Some(url);
    }
  }
  Ok(())
}

/// `target` is "live". The sandbox is desktop-only: it is a supporter perk
/// bought outside the App Store, so the phone app does not unlock it.
#[tauri::command]
pub(crate) async fn open_online_window(app: AppHandle, target: Option<String>) -> Result<(), String> {
  let base = match target.as_deref() {
    None | Some("live") => ONLINE_URL,
    Some("sandbox") if SANDBOX_IN_APP => {
      let account = linked_account(app.clone()).await?;
      if !account.is_some_and(|account| account.linked && account.supporter) {
        return Err("Sandbox requires supporter access. Link your supporter game account in Settings.".into());
      }
      SANDBOX_URL
    }
    Some("sandbox") => return Err("The sandbox is available in the desktop app.".into()),
    Some(other) => return Err(format!("unknown online target {other:?}")),
  };
  let url: Url = base.parse().map_err(|e| format!("bad online URL: {e}"))?;
  navigate_main(&app, url)
}

/// Send the webview to the site's link page and watch the cookie jar. Once
/// the site reports a linked session the webview comes back to the launcher,
/// which re-reads the account on mount. Gives up quietly after ten minutes
/// or as soon as the player returns on their own.
#[tauri::command]
pub(crate) async fn link_account(app: AppHandle) -> Result<(), String> {
  let url: Url = format!("{ONLINE_URL}/client/link").parse().map_err(|_| "invalid account URL")?;
  navigate_main(&app, url)?;
  let generation = app.state::<LinkWatch>().0.fetch_add(1, Ordering::SeqCst) + 1;
  tauri::async_runtime::spawn(async move {
    let started = tokio::time::Instant::now();
    loop {
      tokio::time::sleep(LINK_POLL).await;
      if app.state::<LinkWatch>().0.load(Ordering::SeqCst) != generation || started.elapsed() > LINK_DEADLINE {
        break;
      }
      let Ok(view) = main_webview(&app) else { break };
      if view.url().map(|url| is_app_origin(&url)).unwrap_or(true) {
        break;
      }
      if let Ok(Some(account)) = linked_account(app.clone()).await {
        if account.linked {
          let _ = navigate_main(&app, launcher_home(&app));
          break;
        }
      }
    }
  });
  Ok(())
}

/// iOS and Android present a native Ask sheet from the mobile plugin. The
/// native panel uses the existing WebView cookie jar for silent linked-account
/// sign-in, but the Ask conversation itself never loads in a browser view.
#[tauri::command]
pub(crate) async fn open_ask_window(app: AppHandle) -> Result<(), String> {
  present_native_ask(app).await
}

/// Supporter purchase pages are outside purchases (guideline 3.1.1), so the
/// phone app refuses them even though the shared Help table knows them.
fn is_store_blocked_help(route_id: &str) -> bool {
  matches!(route_id, "help.patreon" | "help.supporter-wall")
}

#[tauri::command]
pub(crate) async fn open_help_destination(app: AppHandle, route_id: String) -> Result<(), String> {
  if is_store_blocked_help(&route_id) {
    return Err("This link is available in the desktop app.".into());
  }
  match help_destination(&route_id) {
    Some(HelpDestination::Online(path)) => {
      let url: Url = format!("{ONLINE_URL}{path}").parse().map_err(|e| format!("bad Help URL: {e}"))?;
      navigate_main(&app, url)
    }
    Some(HelpDestination::External(url)) => app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string()),
    None => Err(format!("unknown Help destination: {route_id}")),
  }
}

#[tauri::command]
pub(crate) async fn get_push_status(app: AppHandle) -> Result<serde_json::Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    app.state::<tauri_plugin_briefing_widgets::NativeCompanion<tauri::Wry>>().status()
  }).await.map_err(|_| "Could not read push settings".to_string())?
}

#[tauri::command]
pub(crate) async fn send_test_push(app: AppHandle) -> Result<serde_json::Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    app.state::<tauri_plugin_briefing_widgets::NativeCompanion<tauri::Wry>>().send_test()
  }).await.map_err(|_| "Could not send a test alert".to_string())?
}

#[tauri::command]
pub(crate) async fn configure_push(app: AppHandle, enabled: bool) -> Result<serde_json::Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    app.state::<tauri_plugin_briefing_widgets::NativeCompanion<tauri::Wry>>().configure(enabled)
  }).await.map_err(|_| "Could not update push settings".to_string())?
}

pub(crate) fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
  builder
    .manage(LauncherHome(Mutex::new(None)))
    .manage(LinkWatch(AtomicU64::new(0)))
    .invoke_handler(tauri::generate_handler![
      get_push_status,
      configure_push,
      send_test_push,
      crate::briefing::get_briefing,
      crate::briefing::open_briefing_page,
      crate::briefing::open_game_page,
      crate::submit_diagnostics,
      crate::linked_account,
      crate::sign_out,
      link_account,
      open_online_window,
      open_help_destination,
      open_ask_window,
    ])
    .setup(|app| {
      create_main_window(app.handle())?;
      Ok(())
    })
}

#[cfg(test)]
mod tests {
  use super::{classify_navigation, is_app_navigation_allowed, is_app_origin, is_launcher_request, MobileNavigationAction, USER_AGENT_MARKER};
  use tauri::Url;

  #[test]
  fn app_origin_matches_both_mobile_custom_protocol_shapes() {
    let ios: Url = "tauri://localhost/index.html".parse().unwrap();
    let android: Url = "http://tauri.localhost/".parse().unwrap();
    let site: Url = "https://ahousedividedgame.com/".parse().unwrap();
    let spoof: Url = "https://tauri.localhost/".parse().unwrap();
    assert!(is_app_origin(&ios));
    assert!(is_app_origin(&android));
    assert!(!is_app_origin(&site));
    assert!(!is_app_origin(&spoof));
  }

  #[test]
  fn only_the_launcher_deep_link_returns_home() {
    let home: Url = "ahdclient://launcher".parse().unwrap();
    let settings: Url = "ahdclient://settings".parse().unwrap();
    let web: Url = "https://ahousedividedgame.com/launcher".parse().unwrap();
    assert!(is_launcher_request(&home));
    assert!(!is_launcher_request(&settings));
    assert!(!is_launcher_request(&web));
  }

  #[test]
  fn mobile_navigation_keeps_ask_auth_inside_the_app() {
    let ask: Url = "https://ask.lakesidegames.net/auth/login?next=%2F".parse().unwrap();
    let broker: Url = "https://auth.ahousedividedgame.com/auth/ahd".parse().unwrap();
    let game: Url = "https://ahousedividedgame.com/api/client/account".parse().unwrap();
    let outside: Url = "https://example.com/".parse().unwrap();
    assert!(is_ask_navigation_allowed(&ask));
    assert!(!is_app_navigation_allowed(&ask));
    assert!(is_app_navigation_allowed(&broker));
    assert!(is_app_navigation_allowed(&game));
    assert!(!is_app_navigation_allowed(&outside));
  }

  #[test]
  fn phone_app_refuses_supporter_purchase_pages() {
    assert!(is_store_blocked_help("help.patreon"));
    assert!(is_store_blocked_help("help.supporter-wall"));
    assert!(!is_store_blocked_help("help.wiki"));
    assert!(!is_store_blocked_help("help.privacy"));
  }

  #[test]
  fn discord_consent_is_recognised_but_other_discord_pages_are_not() {
    let consent: Url = "https://discord.com/oauth2/authorize?client_id=1&response_type=code".parse().unwrap();
    let api_consent: Url = "https://discord.com/api/oauth2/authorize?client_id=1".parse().unwrap();
    let login: Url = "https://discord.com/login".parse().unwrap();
    assert!(is_discord_authorize(&consent));
    assert!(is_discord_authorize(&api_consent));
    assert!(!is_discord_authorize(&login));
  }

  #[test]
  fn game_navigation_is_not_mistaken_for_native_ask() {
    let multiplayer: Url = "https://ahousedividedgame.com/".parse().unwrap();
    let sandbox: Url = "https://sandbox.ahousedividedgame.com/".parse().unwrap();
    let ask: Url = "https://ask.lakesidegames.net/".parse().unwrap();

    assert_eq!(classify_navigation(&multiplayer), MobileNavigationAction::InApp);
    assert_eq!(classify_navigation(&sandbox), MobileNavigationAction::External);
    assert_eq!(classify_navigation(&ask), MobileNavigationAction::PresentAsk);
  }

  #[test]
  fn embedded_frames_never_leave_the_app() {
    let turnstile: Url = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc/0x4AAA/auto/fbE/normal/auto/".parse().unwrap();
    let blank: Url = "about:blank".parse().unwrap();
    let srcdoc: Url = "about:srcdoc".parse().unwrap();
    let nocookie: Url = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1".parse().unwrap();
    let embed: Url = "https://www.youtube.com/embed/dQw4w9WgXcQ".parse().unwrap();
    let ad: Url = "https://googleads.g.doubleclick.net/pagead/ads?client=x".parse().unwrap();
    let watch: Url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ".parse().unwrap();
    let outside: Url = "https://example.com/".parse().unwrap();

    assert_eq!(classify_navigation(&turnstile), MobileNavigationAction::InApp);
    assert_eq!(classify_navigation(&blank), MobileNavigationAction::InApp);
    assert_eq!(classify_navigation(&srcdoc), MobileNavigationAction::InApp);
    assert_eq!(classify_navigation(&nocookie), MobileNavigationAction::Ignore);
    assert_eq!(classify_navigation(&embed), MobileNavigationAction::Ignore);
    assert_eq!(classify_navigation(&ad), MobileNavigationAction::Ignore);
    // A player tapping a real link still leaves the app as before.
    assert_eq!(classify_navigation(&watch), MobileNavigationAction::External);
    assert_eq!(classify_navigation(&outside), MobileNavigationAction::External);
  }

  #[test]
  fn user_agent_marker_carries_the_client_version() {
    assert!(USER_AGENT_MARKER.starts_with("AHDClient-Mobile/"));
    assert_eq!(USER_AGENT_MARKER.trim_start_matches("AHDClient-Mobile/"), env!("CARGO_PKG_VERSION"));
  }
}
