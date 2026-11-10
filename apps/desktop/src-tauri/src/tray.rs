//! System tray icon and the "keep running in the tray" choice.
//!
//! The tray is optional at runtime: on Linux it needs libayatana-appindicator,
//! and a machine without it must still start the app. Building the icon is
//! therefore fenced off (errors and panics both), and when it fails the close
//! button behaves exactly as it always has, whatever the saved choice says.
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

const SHOW: &str = "tray-show";
const BRIEFING: &str = "tray-briefing";
const ALERTS: &str = "tray-alerts";
const QUIT: &str = "tray-quit";

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
  /// Missing means off: closing the window quits, as it always has.
  keep_in_tray: Option<bool>,
}

#[derive(Default)]
pub(crate) struct TrayState {
  available: AtomicBool,
  alerts_item: Mutex<Option<MenuItem<Wry>>>,
}

fn file(app: &AppHandle) -> Option<PathBuf> {
  app.path().app_config_dir().ok().map(|dir| dir.join("desktop-tray.json"))
}

fn read(app: &AppHandle) -> Saved {
  file(app).and_then(|path| std::fs::read(path).ok())
    .and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

fn save(app: &AppHandle, saved: &Saved) -> Result<(), String> {
  let failed = || "Cannot save this setting.".to_string();
  let path = file(app).ok_or_else(failed)?;
  if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|_| failed())?; }
  let temporary = path.with_extension("tmp");
  std::fs::write(&temporary, serde_json::to_vec(saved).map_err(|_| failed())?)
    .and_then(|_| std::fs::rename(&temporary, &path)).map_err(|_| failed())
}

fn available(app: &AppHandle) -> bool {
  app.try_state::<TrayState>().map(|s| s.available.load(Ordering::Relaxed)).unwrap_or(false)
}

/// The close button hides the window only when the player asked for it AND a
/// tray icon really exists to bring it back.
pub(crate) fn hides_on_close(keep: bool, tray_available: bool) -> bool { keep && tray_available }

pub(crate) fn keep_running(app: &AppHandle) -> bool {
  hides_on_close(read(app).keep_in_tray == Some(true), available(app))
}

pub(crate) fn alerts_label(enabled: bool) -> &'static str {
  if enabled { "Turn alerts off" } else { "Turn alerts on" }
}

/// Keeps the tray's alerts entry in step with the Settings switch.
pub(crate) fn refresh_alerts_label(app: &AppHandle) {
  let Some(state) = app.try_state::<TrayState>() else { return };
  let enabled = crate::desktop_alerts::alerts_enabled(app);
  if let Ok(slot) = state.alerts_item.lock() {
    if let Some(item) = slot.as_ref() { let _ = item.set_text(alerts_label(enabled)); }
  };
}

fn build(app: &AppHandle) -> tauri::Result<()> {
  let show = MenuItem::with_id(app, SHOW, "Show AHDClient", true, None::<&str>)?;
  let briefing = MenuItem::with_id(app, BRIEFING, "Briefing", true, None::<&str>)?;
  let alerts = MenuItem::with_id(app, ALERTS, alerts_label(crate::desktop_alerts::alerts_enabled(app)), true, None::<&str>)?;
  let quit = MenuItem::with_id(app, QUIT, "Quit", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[&show, &briefing, &alerts, &PredefinedMenuItem::separator(app)?, &quit])?;
  let mut builder = TrayIconBuilder::with_id("main")
    .tooltip("A House Divided")
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id().as_ref() {
      SHOW => crate::desktop::show_main_window(app),
      BRIEFING => {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { let _ = crate::briefing::open_briefing_window(app).await; });
      }
      ALERTS => {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
          let on = crate::desktop_alerts::alerts_enabled(&app);
          let _ = crate::desktop_alerts::configure_push(app.clone(), !on).await;
          refresh_alerts_label(&app);
        });
      }
      QUIT => app.exit(0),
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
        crate::desktop::show_main_window(tray.app_handle());
      }
    });
  if let Some(icon) = app.default_window_icon() { builder = builder.icon(icon.clone()); }
  builder.build(app)?;
  if let Some(state) = app.try_state::<TrayState>() {
    if let Ok(mut slot) = state.alerts_item.lock() { *slot = Some(alerts); };
    state.available.store(true, Ordering::Relaxed);
  }
  Ok(())
}

/// Creates the tray icon. A missing system library or tray host is not an
/// error the player needs to see: the app simply runs without a tray.
pub(crate) fn setup(app: &AppHandle) {
  let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| build(app)));
  match attempt {
    Ok(Ok(())) => {}
    Ok(Err(error)) => eprintln!("tray unavailable: {error}"),
    Err(_) => eprintln!("tray unavailable: system tray library missing"),
  }
}

#[tauri::command]
pub(crate) fn get_tray_settings(app: AppHandle) -> serde_json::Value {
  serde_json::json!({ "available": available(&app), "keepInTray": read(&app).keep_in_tray == Some(true) })
}

#[tauri::command]
pub(crate) fn set_keep_in_tray(app: AppHandle, enabled: bool) -> Result<serde_json::Value, String> {
  save(&app, &Saved { keep_in_tray: Some(enabled) })?;
  Ok(get_tray_settings(app))
}

#[cfg(test)]
mod tests {
  use super::{alerts_label, hides_on_close, Saved};

  #[test]
  fn closing_hides_only_with_the_choice_and_a_working_tray() {
    assert!(hides_on_close(true, true));
    assert!(!hides_on_close(true, false));
    assert!(!hides_on_close(false, true));
    assert!(!hides_on_close(false, false));
  }

  #[test]
  fn the_choice_defaults_to_off() {
    let empty: Saved = serde_json::from_str("{}").unwrap();
    assert_eq!(empty.keep_in_tray, None);
    let on: Saved = serde_json::from_str(r#"{"keepInTray":true}"#).unwrap();
    assert_eq!(on.keep_in_tray, Some(true));
  }

  #[test]
  fn the_alerts_entry_names_what_a_click_does() {
    assert_eq!(alerts_label(true), "Turn alerts off");
    assert_eq!(alerts_label(false), "Turn alerts on");
  }
}
