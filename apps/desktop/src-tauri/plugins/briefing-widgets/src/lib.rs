use serde::Deserialize;
use tauri::{plugin::PluginHandle, webview::Cookie, Manager, Runtime, Url};

// Jar matching for iOS, which hands over the whole jar. Android's
// CookieManager already answers per URL.
#[cfg(not(target_os = "android"))]
mod cookies;
#[cfg(not(target_os = "android"))]
use cookies::{sent_to, JarCookie};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_briefing_widgets);

#[derive(Deserialize)]
struct JarReply {
  cookies: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireCookie {
  name: String,
  value: String,
  domain: String,
  path: String,
  #[serde(default)]
  secure: bool,
}

pub struct NativeCompanion<R: Runtime>(PluginHandle<R>);
impl<R: Runtime> NativeCompanion<R> {
  pub fn status<T: for<'de> Deserialize<'de>>(&self) -> Result<T, String> {
    self.0.run_mobile_plugin("pushStatus", ()).map_err(|_| "Could not read push settings".to_string())
  }
  /// Ask the game to send this phone one test alert now.
  pub fn send_test<T: for<'de> Deserialize<'de>>(&self) -> Result<T, String> {
    self.0.run_mobile_plugin("sendTestPush", ()).map_err(|_| "Could not send a test alert".to_string())
  }
  pub fn configure<T: for<'de> Deserialize<'de>>(&self, enabled: bool) -> Result<T, String> {
    self.0.run_mobile_plugin("configurePush", serde_json::json!({ "enabled": enabled }))
      .map_err(|_| "Could not update push settings".to_string())
  }
  /// Every cookie in the WebView jar, read by native code. wry's own cookie
  /// reader spins the main run loop from inside tao's event handler, which
  /// aborts the app on iOS ("panic in a function that cannot unwind"). The
  /// native read waits on the calling thread instead, so this must never be
  /// called from the main thread.
  pub fn all_cookies(&self) -> Result<Vec<Cookie<'static>>, String> {
    let reply: JarReply = self.0.run_mobile_plugin("cookies", ()).map_err(|_| "Could not read the app session".to_string())?;
    let wire: Vec<WireCookie> = serde_json::from_str(&reply.cookies).map_err(|_| "Could not read the app session".to_string())?;
    Ok(wire.into_iter().map(|c| Cookie::build((c.name, c.value)).domain(c.domain).path(c.path).secure(c.secure).build()).collect())
  }
  /// The cookies the WebView would send to `url`, from Android's
  /// CookieManager. wry's Android reader gives up after ten seconds and then
  /// panics when the main thread answers late; this waits instead, so it too
  /// must never run on the main thread. Android reports names and values only.
  #[cfg(target_os = "android")]
  pub fn cookies_for_url(&self, url: &Url) -> Result<Vec<Cookie<'static>>, String> {
    let reply: JarReply = self.0.run_mobile_plugin("cookiesForUrl", serde_json::json!({ "url": url.as_str() }))
      .map_err(|_| "Could not read the app session".to_string())?;
    Ok(reply.cookies.split("; ").filter_map(|pair| Cookie::parse(pair.to_string()).ok()).collect())
  }
  /// The cookies the WebView would send to `url`.
  #[cfg(not(target_os = "android"))]
  pub fn cookies_for_url(&self, url: &Url) -> Result<Vec<Cookie<'static>>, String> {
    let host = url.host_str().unwrap_or_default();
    let https = url.scheme() == "https";
    Ok(self.all_cookies()?.into_iter().filter(|cookie| {
      let jar = JarCookie {
        name: cookie.name().to_string(),
        value: cookie.value().to_string(),
        domain: cookie.domain().unwrap_or_default().to_string(),
        path: cookie.path().unwrap_or("/").to_string(),
        secure: cookie.secure().unwrap_or(false),
      };
      sent_to(&jar, https, host, url.path())
    }).collect())
  }
  pub fn delete_cookie(&self, cookie: &Cookie<'_>) -> Result<(), String> {
    self.0.run_mobile_plugin::<serde_json::Value>("deleteCookie", serde_json::json!({
      "name": cookie.name(),
      "domain": cookie.domain().unwrap_or_default(),
      "path": cookie.path().unwrap_or("/"),
    })).map(|_| ()).map_err(|_| "Could not clear the app session".to_string())
  }
  pub fn show_ask(&self) -> Result<serde_json::Value, String> {
    self.0.run_mobile_plugin("showAsk", ())
      .map_err(|_| "Could not open native Ask".to_string())
  }
}

/// The launcher calls narrow app commands. No remote page gets plugin IPC.
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
  tauri::plugin::Builder::new("briefing-widgets")
    .setup(|app, api| {
      #[cfg(target_os = "ios")]
      let handle = api.register_ios_plugin(init_plugin_briefing_widgets)?;
      #[cfg(target_os = "android")]
      let handle = api.register_android_plugin("net.lakesidegames.briefing", "BriefingPlugin")?;
      app.manage(NativeCompanion(handle));
      Ok(())
    })
    .build()
}
