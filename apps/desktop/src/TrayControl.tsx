import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "./i18n.js";

interface TraySettings { available: boolean; keepInTray: boolean }

/** "Keep running in the tray when I close the window". Off by default; needs a working tray icon. */
export function TrayControl(): JSX.Element {
  const t = useT();
  const [settings, setSettings] = useState<TraySettings | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    invoke<TraySettings>("get_tray_settings")
      .then((next) => { if (active) setSettings(next); })
      .catch(() => { if (active) setError(t("tray.readError")); });
    return () => { active = false; };
  }, []);
  async function change(enabled: boolean) {
    setError("");
    try { setSettings(await invoke<TraySettings>("set_keep_in_tray", { enabled })); }
    catch { setError(t("tray.changeError")); }
  }
  const unavailable = settings !== null && !settings.available;
  return <label className="client-settings-row">
    <span>
      <strong>{t("tray.label")}</strong>
      <small>{error || (unavailable ? t("tray.unavailable") : t("tray.detail"))}</small>
    </span>
    <input type="checkbox" role="switch" checked={settings?.keepInTray ?? false}
      disabled={!settings || unavailable} onChange={(event) => void change(event.target.checked)} />
  </label>;
}
