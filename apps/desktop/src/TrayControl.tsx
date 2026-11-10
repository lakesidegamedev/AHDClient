import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface TraySettings { available: boolean; keepInTray: boolean }

/** "Keep running in the tray when I close the window". Off by default; needs a working tray icon. */
export function TrayControl(): JSX.Element {
  const [settings, setSettings] = useState<TraySettings | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    invoke<TraySettings>("get_tray_settings")
      .then((next) => { if (active) setSettings(next); })
      .catch(() => { if (active) setError("Could not read this setting."); });
    return () => { active = false; };
  }, []);
  async function change(enabled: boolean) {
    setError("");
    try { setSettings(await invoke<TraySettings>("set_keep_in_tray", { enabled })); }
    catch { setError("Could not change this setting. Please try again."); }
  }
  const unavailable = settings !== null && !settings.available;
  return <label className="client-settings-row">
    <span>
      <strong>Keep running in the tray when I close the window</strong>
      <small>{error || (unavailable
        ? "Your system has no tray available, so closing the window quits the app."
        : "Closing the window hides it instead of quitting, so alerts keep coming. Use the tray icon to bring it back or quit.")}</small>
    </span>
    <input type="checkbox" role="switch" checked={settings?.keepInTray ?? false}
      disabled={!settings || unavailable} onChange={(event) => void change(event.target.checked)} />
  </label>;
}
