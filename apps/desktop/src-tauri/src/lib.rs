//! AHDClient core.
//!
//! The client is a shell around the real game. On desktop, singleplayer runs
//! the A House Divided server (a Next.js standalone build shipped as a
//! resource) under a bundled Node, against a MongoDB the launcher script
//! finds or fetches, all on loopback; that half lives in `desktop.rs`. On
//! Android and iOS there is no local game: the app is the launcher plus the
//! live multiplayer site in the same webview; see `mobile.rs`.
//!
//! This file holds what both halves share: the online origin policy, Help
//! routing, account linking (read from the platform cookie jar, never
//! crossing IPC) and diagnostics delivery.
//!
//! Security shape, unchanged in spirit from 1.x: the launcher webview talks
//! only to these commands; remote content gets no Tauri IPC at all and is a
//! plain webview pointed at an origin we chose.

#[cfg(desktop)]
mod ask;
#[cfg(desktop)]
mod desktop;
#[cfg(desktop)]
mod desktop_alerts;
#[cfg(desktop)]
mod game_versions;
#[cfg(mobile)]
mod mobile;
#[cfg(desktop)]
mod node_path;
mod briefing;
#[cfg_attr(desktop, allow(dead_code))]
mod launch;
mod links;
mod native_auth;
mod webview_cookies;

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Url};

const ONLINE_URL: &str = "https://ahousedividedgame.com";
const SANDBOX_URL: &str = "https://sandbox.ahousedividedgame.com";
const ONLINE_HOST: &str = "ahousedividedgame.com";
const SANDBOX_HOST: &str = "sandbox.ahousedividedgame.com";
const AUXILIARY_ONLINE_HOSTS: &[&str] = &[
  "www.ahousedividedgame.com",
  // Cloudflare Turnstile on sign-up and password reset runs in an iframe.
  "challenges.cloudflare.com",
  "auth.ahousedividedgame.com",
  "auth.lakesidegames.net",
  "discord.com",
  "accounts.google.com",
  "www.google.com",
  "appleid.apple.com",
];

/// Player Q&A service. Desktop opens it in its own dedicated zero-capability
/// window so a question can sit beside the game; mobile presents a native
/// sheet. Sign-in is automatic for players already signed in anywhere in the
/// app: the Ask broker bounce reads the existing game session without another
/// password prompt.
#[cfg_attr(mobile, allow(dead_code))]
const ASK_URL: &str = "https://ask.lakesidegames.net/";
/// Hosts the Ask sign-in bounce may legitimately touch: the Ask service
/// itself, the Lakeside auth broker, the game origins it reads the session
/// from, and the OAuth hosts the game sign-in uses.
const ASK_NAVIGATION_HOSTS: &[&str] = &[
  "ask.lakesidegames.net",
  "auth.ahousedividedgame.com",
  "auth.lakesidegames.net",
  "ahousedividedgame.com",
  "www.ahousedividedgame.com",
  "sandbox.ahousedividedgame.com",
  "discord.com",
  "accounts.google.com",
  "www.google.com",
  "appleid.apple.com",
];

// ---------------------------------------------------------------------------
// Help routing (kept from 1.x)
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
enum HelpDestination {
  Online(&'static str),
  External(&'static str),
}

fn help_destination(route_id: &str) -> Option<HelpDestination> {
  match route_id {
    "help.era-photo-1953" => Some(HelpDestination::External("https://commons.wikimedia.org/wiki/File:Eisenhower_inauguration.gif")),
    "help.era-photo-1979" => Some(HelpDestination::External("https://commons.wikimedia.org/wiki/File:Portrait_of_Jimmy_Carter_by_Ansel_Adams_(1979)_(cropped).jpg")),
    "help.era-photo-1991" => Some(HelpDestination::External("https://commons.wikimedia.org/wiki/File:President_George_H._W._Bush_poses_for_a_photograph_with_four_of_his_predecessors.jpg")),
    "help.era-photo-1999" => Some(HelpDestination::External("https://commons.wikimedia.org/wiki/File:Bill_Clinton_1999.jpg")),
    "help.era-photo-2007" => Some(HelpDestination::External("https://commons.wikimedia.org/wiki/File:George_Bush_visit_Kansas_City_Assembly.jpg")),
    "help.era-photo-2019" => Some(HelpDestination::External("https://commons.wikimedia.org/wiki/File:President_Trump_Meets_with_the_Prime_Minister_of_Pakistan_(48350243921).jpg")),
    "help.era-photo-2023" => Some(HelpDestination::External("https://commons.wikimedia.org/wiki/File:P20230106AS-0338_(52644827761).jpg")),
    "help.wiki" => Some(HelpDestination::External("https://wiki.ahousedividedgame.com")),
    "help.download-client" => Some(HelpDestination::External("https://github.com/lakesidegamedev/AHDClient/releases/latest")),
    "help.about" => Some(HelpDestination::Online("/about")),
    "help.profile" => Some(HelpDestination::Online("/profile")),
    "help.account" => Some(HelpDestination::Online("/settings")),
    "help.report-issue" => Some(HelpDestination::External(concat!("https://github.com/lakesidegamedev/AHDClient/issues/new?labels=bug&title=%5B", env!("CARGO_PKG_VERSION"), "%5D%20&body=What%20happened%3F%0A%0ASteps%20to%20reproduce%3A%0A1.%20"))),
    "help.suggestions" => Some(HelpDestination::Online("/feedback")),
    "help.discord" => Some(HelpDestination::External("https://discord.gg/DmF8zJJuqN")),
    "help.patreon" => Some(HelpDestination::External(
      "https://www.patreon.com/cw/AHouseDividedGame/membership",
    )),
    "help.supporter-wall" => Some(HelpDestination::External("https://lakesidegames.net/supporters")),
    "help.email-support" => Some(HelpDestination::External("mailto:admin@ahousedividedgame.com")),
    "help.server-status" => Some(HelpDestination::External("https://ops.ahousedividedgame.com/status")),
    "help.privacy" => Some(HelpDestination::Online("/privacy")),
    "help.terms" => Some(HelpDestination::Online("/terms")),
    _ => None,
  }
}

fn is_online_origin(url: &Url) -> bool {
  url.scheme() == "https"
    && matches!(url.host_str(), Some(ONLINE_HOST) | Some(SANDBOX_HOST))
    && url.port_or_known_default() == Some(443)
}

/// Hosts that only ever appear as embedded frames: video players, ad and
/// consent frames. WKWebView (iOS and macOS) reports iframe loads to the
/// navigation policy with no main-frame flag (wry 0.55), so these must never
/// be treated as a page the player asked to open elsewhere.
const EMBED_ONLY_HOSTS: &[&str] = &[
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
  "googleads.g.doubleclick.net",
  "td.doubleclick.net",
  "pagead2.googlesyndication.com",
  "tpc.googlesyndication.com",
  "fundingchoicesmessages.google.com",
  "www.googletagmanager.com",
];

fn is_embed_only(url: &Url) -> bool {
  let Some(host) = url.host_str() else { return false };
  EMBED_ONLY_HOSTS.contains(&host)
    || (matches!(host, "www.youtube.com" | "youtube.com" | "m.youtube.com") && url.path().starts_with("/embed/"))
}

/// Schemes that only back frames and in-page resources, never a page to open.
fn is_frame_scheme(url: &Url) -> bool {
  matches!(url.scheme(), "about" | "blob" | "data")
}

/// Desktop keeps frame resources inside the webview: a campaign song embed
/// plays in place and a blank frame is not bounced to the browser.
#[cfg_attr(mobile, allow(dead_code))]
fn is_frame_resource(url: &Url) -> bool {
  is_frame_scheme(url) || is_embed_only(url)
}

fn is_online_navigation_allowed(url: &Url) -> bool {
  let secure_default_port = url.scheme() == "https" && url.port_or_known_default() == Some(443);
  is_online_origin(url)
    || (secure_default_port && url.host_str().is_some_and(|host| AUXILIARY_ONLINE_HOSTS.contains(&host)))
}

/// The Ask window may stay inside the Ask service, the auth broker and game
/// origins the sign-in bounce touches, and the OAuth hosts the game sign-in
/// uses. Anything else opens in the system browser.
fn is_ask_navigation_allowed(url: &Url) -> bool {
  url.scheme() == "https"
    && url.port_or_known_default() == Some(443)
    && url
      .host_str()
      .is_some_and(|host| ASK_NAVIGATION_HOSTS.contains(&host))
}


#[tauri::command]
async fn submit_diagnostics(report: serde_json::Value) -> Result<(), String> {
  let body = serde_json::to_string(&report).map_err(|_| "invalid diagnostic report")?;
  if body.len() > 40_000 { return Err("diagnostic report is too large".into()); }
  tauri::async_runtime::spawn_blocking(move || {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(10)).redirects(0).build();
    let response = agent.post("https://ahousedividedgame.com/api/client/diagnostics")
      .set("Content-Type", "application/json")
      .set("User-Agent", "AHDClient/2")
      .send_string(&body).map_err(|_| "diagnostic delivery unavailable")?;
    if response.status() == 202 { Ok(()) } else { Err("diagnostic delivery unavailable".into()) }
  }).await.map_err(|_| "diagnostic delivery failed")?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkedAccount {
  linked: bool,
  display_name: String,
  supporter: bool,
  /// Player picture from the game account API (`avatarUrl`, shipped by the game).
  #[serde(default)]
  avatar_url: Option<String>,
  #[serde(default)]
  singleplayer: SingleplayerEntitlement,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SingleplayerEntitlement {
  entitled: bool,
  expires_at: Option<String>,
}

fn is_account_session_cookie(name: &str) -> bool {
  matches!(name, "auth-token" | "authjs.session-token" | "__Secure-authjs.session-token" | "next-auth.session-token" | "__Secure-next-auth.session-token")
    || name.strip_prefix("auth-token-").is_some_and(|suffix| !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
    || ["authjs.session-token.", "__Secure-authjs.session-token.", "next-auth.session-token.", "__Secure-next-auth.session-token."].iter().any(|prefix| name.strip_prefix(prefix).is_some_and(|suffix| !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit())))
}

#[tauri::command]
async fn linked_account(app: AppHandle) -> Result<Option<LinkedAccount>, String> {
  // Read the platform WebView cookie store. Credentials never cross IPC or
  // enter launcher storage, telemetry, URLs or log messages.
  // A new link is completed inside the online child WebView. Reading only the
  // launcher cookie jar made a successful sign-in invisible until restart.
  let view = app
    .get_webview("online-embedded")
    .or_else(|| app.get_webview("online"))
    .or_else(|| app.get_webview("main"))
    .ok_or("launcher is missing")?;
  let url: Url = format!("{ONLINE_URL}/api/client/account").parse().map_err(|_| "invalid account URL")?;
  let cookies = webview_cookies::cookies_for_url(&app, &view, url).map_err(|_| "cannot access the app session")?;
  let header = cookies.iter()
    .filter(|cookie| is_account_session_cookie(cookie.name()))
    .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
    .collect::<Vec<_>>().join("; ");
  if header.is_empty() { return Ok(None); }
  tauri::async_runtime::spawn_blocking(move || {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).redirects(0).build();
    match agent.get(&format!("{ONLINE_URL}/api/client/account")).set("Cookie", &header).call() {
      Ok(response) => response.into_json::<LinkedAccount>().map(Some).map_err(|_| "invalid account response".into()),
      Err(ureq::Error::Status(401, _)) => Ok(None),
      Err(_) => Err("Cannot check the linked account. Connect to the internet and try again.".into()),
    }
  }).await.map_err(|_| "account check failed")?
}

/// Hosts whose cookies make up a signed-in identity inside the app: the game
/// origins, both auth brokers (including the Lakeside issuer's SSO cookies,
/// which would otherwise sign the player straight back in), and Ask.
const SIGN_OUT_HOSTS: &[&str] = &[
  ONLINE_HOST,
  "www.ahousedividedgame.com",
  SANDBOX_HOST,
  "auth.ahousedividedgame.com",
  "auth.lakesidegames.net",
  "ask.lakesidegames.net",
];

/// URLs probed for cookies when the platform cannot list the whole jar
/// (Android). The issuer keeps its SSO cookies under the realm path.
const SIGN_OUT_PROBE_URLS: &[&str] = &[
  "https://ahousedividedgame.com/",
  "https://www.ahousedividedgame.com/",
  "https://sandbox.ahousedividedgame.com/",
  "https://auth.ahousedividedgame.com/",
  "https://auth.lakesidegames.net/",
  "https://auth.lakesidegames.net/realms/accounts/",
  "https://ask.lakesidegames.net/",
];

fn is_sign_out_cookie_domain(domain: &str) -> bool {
  let domain = domain.trim_start_matches('.').to_ascii_lowercase();
  SIGN_OUT_HOSTS.contains(&domain.as_str()) || domain == "lakesidegames.net"
}

/// Identity cookies only. Display preferences and consent choices survive a
/// sign-out; every session, SSO, and login-flow cookie does not.
fn is_sign_out_cookie(name: &str, domain: &str) -> bool {
  let domain = domain.trim_start_matches('.').to_ascii_lowercase();
  if domain == "auth.lakesidegames.net" || domain == "auth.ahousedividedgame.com" {
    // Broker and issuer hosts hold nothing but auth state.
    return true;
  }
  is_account_session_cookie(name)
    || matches!(
      name,
      "ask_session" | "__Host-ask_session" | "__Host-ask_login" | "__Host-lakeside_session" | "__Host-lakeside_login"
    )
}

/// Sign the player out everywhere in the app: revoke the game session on the
/// server, then drop every identity cookie from the shared webview jar so
/// neither the site, the issuer's SSO, nor Ask can resume it silently.
#[tauri::command]
async fn sign_out(app: AppHandle) -> Result<(), String> {
  let views: Vec<tauri::Webview> = ["main", "online", "online-embedded", "ask", "ask-auth"]
    .iter()
    .filter_map(|label| app.get_webview(label))
    .collect();
  let Some(primary) = views.first().cloned() else { return Err("launcher is missing".into()) };

  // Server-side revocation first, with the cookies the site would send.
  for base in [ONLINE_URL, SANDBOX_URL] {
    let Ok(url) = format!("{base}/").parse::<Url>() else { continue };
    let header = webview_cookies::cookies_for_url(&app, &primary, url)
      .unwrap_or_default()
      .iter()
      .filter(|cookie| is_account_session_cookie(cookie.name()))
      .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
      .collect::<Vec<_>>()
      .join("; ");
    if header.is_empty() { continue; }
    let endpoint = format!("{base}/api/auth/logout");
    let origin = base.to_string();
    // Best effort: a failed revocation must not leave the player stuck signed
    // in on this device, so local cookies are cleared regardless.
    let _ = tauri::async_runtime::spawn_blocking(move || {
      let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).redirects(0).build();
      agent.post(&endpoint)
        .set("Cookie", &header)
        .set("Origin", &origin)
        .set("User-Agent", "AHDClient/2")
        .call()
    }).await;
  }

  // The full jar where the platform can list it, plus per-URL probes for
  // Android. A probed cookie with no reported domain belongs to the probe host.
  let mut cookies: Vec<(tauri::webview::Cookie<'static>, String)> = webview_cookies::all_cookies(&app, &primary)
    .unwrap_or_default()
    .into_iter()
    .filter_map(|cookie| {
      let domain = cookie.domain()?.to_string();
      Some((cookie, domain))
    })
    .collect();
  for probe in SIGN_OUT_PROBE_URLS {
    let Ok(url) = probe.parse::<Url>() else { continue };
    let host = url.host_str().unwrap_or_default().to_string();
    for cookie in webview_cookies::cookies_for_url(&app, &primary, url).unwrap_or_default() {
      let domain = cookie.domain().map(str::to_string).unwrap_or_else(|| host.clone());
      cookies.push((cookie, domain));
    }
  }
  let mut seen = std::collections::HashSet::new();
  for (cookie, domain) in cookies {
    if !is_sign_out_cookie_domain(&domain) || !is_sign_out_cookie(cookie.name(), &domain) {
      continue;
    }
    let key = (cookie.name().to_string(), domain.clone(), cookie.path().unwrap_or("/").to_string());
    if !seen.insert(key) { continue; }
    for view in &views {
      let _ = webview_cookies::delete_cookie(&app, view, cookie.clone());
    }
  }

  match linked_account(app).await {
    Ok(Some(account)) if account.linked => Err("Sign out did not finish. Try again.".into()),
    _ => Ok(()),
  }
}


// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .plugin({
      #[cfg(desktop)]
      { tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build() }
      #[cfg(mobile)]
      { tauri_plugin_opener::init() }
    })
    .manage(briefing::BriefingState::default());
  #[cfg(mobile)]
  let builder = builder.plugin(tauri_plugin_briefing_widgets::init());
  #[cfg(desktop)]
  let builder = desktop::configure(builder);
  #[cfg(mobile)]
  let builder = mobile::configure(builder);
  builder
    .build(tauri::generate_context!())
    .expect("error while building AHDClient")
    .run(|app, event| {
      #[cfg(desktop)]
      if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
        desktop::on_exit(app);
      }
      #[cfg(mobile)]
      if let tauri::RunEvent::Opened { urls } = event {
        for url in urls { mobile::open_widget_link(app, &url); }
      }
    });
}

#[cfg(test)]
mod tests {
  use super::{
    help_destination, is_account_session_cookie, is_sign_out_cookie, is_sign_out_cookie_domain, is_ask_navigation_allowed, is_frame_resource, is_online_navigation_allowed,
    is_online_origin, HelpDestination, LinkedAccount, ASK_URL,
  };
  use tauri::Url;

  #[test]
  fn sign_out_drops_identity_cookies_and_keeps_preferences() {
    assert!(is_sign_out_cookie("auth-token", "ahousedividedgame.com"));
    assert!(is_sign_out_cookie("__Secure-authjs.session-token.0", ".ahousedividedgame.com"));
    assert!(is_sign_out_cookie("__Host-ask_session", "ask.lakesidegames.net"));
    assert!(is_sign_out_cookie("KEYCLOAK_IDENTITY", "auth.lakesidegames.net"));
    assert!(is_sign_out_cookie("AUTH_SESSION_ID", ".auth.lakesidegames.net"));
    assert!(is_sign_out_cookie("anything", "auth.ahousedividedgame.com"));
    assert!(!is_sign_out_cookie("ahd-display-mode", "ahousedividedgame.com"));
    assert!(!is_sign_out_cookie("NEXT_LOCALE", "ahousedividedgame.com"));
    assert!(is_sign_out_cookie_domain(".ahousedividedgame.com"));
    assert!(is_sign_out_cookie_domain("SANDBOX.ahousedividedgame.com"));
    assert!(is_sign_out_cookie_domain("lakesidegames.net"));
    assert!(!is_sign_out_cookie_domain("appleid.apple.com"));
    assert!(!is_sign_out_cookie_domain("ahousedividedgame.com.evil.example"));
  }

  #[test]
  fn ask_target_is_the_https_service_root() {
    let url: Url = ASK_URL.parse().unwrap();
    assert_eq!(url.scheme(), "https");
    assert_eq!(url.host_str(), Some("ask.lakesidegames.net"));
  }

  #[test]
  fn ask_navigation_stays_in_app_only_for_ask_and_sign_in_hosts() {
    let service: Url = "https://ask.lakesidegames.net/".parse().unwrap();
    let broker: Url = "https://auth.ahousedividedgame.com/auth/ahd?return=x"
      .parse()
      .unwrap();
    let game: Url = "https://ahousedividedgame.com/play".parse().unwrap();
    let discord: Url = "https://discord.com/oauth2/authorize".parse().unwrap();
    let google: Url = "https://accounts.google.com/o/oauth2/v2/auth"
      .parse()
      .unwrap();

    assert!(is_ask_navigation_allowed(&service));
    assert!(is_ask_navigation_allowed(&broker));
    assert!(is_ask_navigation_allowed(&game));
    assert!(is_ask_navigation_allowed(&discord));
    assert!(is_ask_navigation_allowed(&google));

    let http: Url = "http://ask.lakesidegames.net/".parse().unwrap();
    let custom_port: Url = "https://ask.lakesidegames.net:444/".parse().unwrap();
    let lookalike: Url = "https://ask.lakesidegames.net.evil.example/".parse().unwrap();
    let subdomain: Url = "https://accounts.ask.lakesidegames.net/".parse().unwrap();
    let unrelated: Url = "https://example.com/".parse().unwrap();
    let insecure_auth: Url = "http://discord.com/oauth2/authorize".parse().unwrap();

    assert!(!is_ask_navigation_allowed(&http));
    assert!(!is_ask_navigation_allowed(&custom_port));
    assert!(!is_ask_navigation_allowed(&lookalike));
    assert!(!is_ask_navigation_allowed(&subdomain));
    assert!(!is_ask_navigation_allowed(&unrelated));
    assert!(!is_ask_navigation_allowed(&insecure_auth));
  }

  #[test]
  fn linked_account_parses_with_and_without_avatar_url() {
    let without: LinkedAccount = serde_json::from_value(serde_json::json!({
      "linked": true, "displayName": "Ada", "supporter": false,
      "singleplayer": { "entitled": true, "expiresAt": null },
    }))
    .expect("account without avatarUrl parses");
    assert_eq!(without.avatar_url, None);
    let with: LinkedAccount = serde_json::from_value(serde_json::json!({
      "linked": true, "displayName": "Ada", "supporter": true,
      "avatarUrl": "https://cdn.discordapp.com/avatars/1/a.png",
      "singleplayer": { "entitled": true, "expiresAt": null },
    }))
    .expect("account with avatarUrl parses");
    assert_eq!(
      with.avatar_url.as_deref(),
      Some("https://cdn.discordapp.com/avatars/1/a.png")
    );
  }

  #[test]
  fn help_routes_resolve_only_to_allowlisted_targets() {
    assert_eq!(
      help_destination("help.wiki"),
      Some(HelpDestination::External("https://wiki.ahousedividedgame.com")),
    );
    assert_eq!(help_destination("help.about"), Some(HelpDestination::Online("/about")));
    assert_eq!(help_destination("help.profile"), Some(HelpDestination::Online("/profile")));
    assert!(matches!(
      help_destination("help.report-issue"),
      Some(HelpDestination::External(url)) if url.contains(env!("CARGO_PKG_VERSION"))
    ));
    assert_eq!(
      help_destination("help.discord"),
      Some(HelpDestination::External("https://discord.gg/DmF8zJJuqN")),
    );
    assert_eq!(help_destination("help.not-real"), None);
  }

  #[test]
  fn account_cookie_filter_accepts_environment_scoped_game_sessions() {
    assert!(is_account_session_cookie("auth-token-production"));
    assert!(is_account_session_cookie("auth-token-sandbox-staging"));
    assert!(!is_account_session_cookie("auth-token-"));
    assert!(!is_account_session_cookie("auth-token-production.copy"));
  }

  #[test]
  fn online_navigation_stays_in_app_only_for_the_exact_https_origin() {
    let allowed: Url = "https://ahousedividedgame.com/play".parse().unwrap();
    let http: Url = "http://ahousedividedgame.com/play".parse().unwrap();
    let custom_port: Url = "https://ahousedividedgame.com:444/play".parse().unwrap();
    let redirector: Url = "https://www.ahousedividedgame.com/play".parse().unwrap();
    let subdomain: Url = "https://accounts.ahousedividedgame.com/".parse().unwrap();
    let unrelated: Url = "https://example.com/".parse().unwrap();
    let sandbox: Url = "https://sandbox.ahousedividedgame.com/play".parse().unwrap();

    assert!(is_online_origin(&allowed));
    assert!(is_online_origin(&sandbox));
    assert!(!is_online_origin(&http));
    assert!(!is_online_origin(&custom_port));
    assert!(!is_online_origin(&redirector));
    assert!(!is_online_origin(&subdomain));
    assert!(!is_online_origin(&unrelated));
  }

  #[test]
  fn frame_resources_are_recognised_without_swallowing_real_links() {
    let blank: Url = "about:blank".parse().unwrap();
    let nocookie: Url = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ".parse().unwrap();
    let embed: Url = "https://www.youtube.com/embed/dQw4w9WgXcQ".parse().unwrap();
    let ad: Url = "https://googleads.g.doubleclick.net/pagead/ads".parse().unwrap();
    let watch: Url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ".parse().unwrap();
    let lookalike: Url = "https://www.youtube-nocookie.com.evil.example/embed/x".parse().unwrap();
    let turnstile: Url = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/".parse().unwrap();

    assert!(is_frame_resource(&blank));
    assert!(is_frame_resource(&nocookie));
    assert!(is_frame_resource(&embed));
    assert!(is_frame_resource(&ad));
    assert!(!is_frame_resource(&watch));
    assert!(!is_frame_resource(&lookalike));
    assert!(is_online_navigation_allowed(&turnstile));
  }

  #[test]
  fn online_navigation_keeps_only_required_auth_hosts_in_the_webview() {
    let callback_redirector: Url = "https://www.ahousedividedgame.com/api/auth/callback/discord".parse().unwrap();
    let discord: Url = "https://discord.com/oauth2/authorize".parse().unwrap();
    let google_accounts: Url = "https://accounts.google.com/o/oauth2/v2/auth".parse().unwrap();
    let google_callback: Url = "https://www.google.com/".parse().unwrap();
    let insecure_auth: Url = "http://discord.com/oauth2/authorize".parse().unwrap();
    let fake_auth: Url = "https://login.discord.com/".parse().unwrap();
    let custom_port: Url = "https://accounts.google.com:444/".parse().unwrap();
    let apple: Url = "https://appleid.apple.com/auth/authorize".parse().unwrap();
    let fake_apple: Url = "https://apple.com.evil.example/auth/authorize".parse().unwrap();

    assert!(is_online_navigation_allowed(&apple));
    assert!(!is_online_navigation_allowed(&fake_apple));
    assert!(is_online_navigation_allowed(&callback_redirector));
    assert!(is_online_navigation_allowed(&discord));
    assert!(is_online_navigation_allowed(&google_accounts));
    assert!(is_online_navigation_allowed(&google_callback));
    assert!(!is_online_navigation_allowed(&insecure_auth));
    assert!(!is_online_navigation_allowed(&fake_auth));
    assert!(!is_online_navigation_allowed(&custom_port));
  }
}
