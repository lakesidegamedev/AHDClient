import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "./i18n.js";

interface Quiet { enabled: boolean; start: number; end: number }
interface ReminderSettings { turnReminder: boolean; quiet: Quiet }

function toTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
function fromTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes < 24 * 60 ? minutes : null;
}

/** "Remind me when a new turn starts" (off by default) and quiet hours (off by default). Desktop only. */
export function TurnReminderControl(): JSX.Element {
  const t = useT();
  const [settings, setSettings] = useState<ReminderSettings | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    invoke<ReminderSettings>("get_reminder_settings")
      .then((next) => { if (active) setSettings(next); })
      .catch(() => { if (active) setError(t("reminder.readError")); });
    return () => { active = false; };
  }, []);
  async function save(next: ReminderSettings) {
    setError("");
    try { setSettings(await invoke<ReminderSettings>("set_reminder_settings", { turnReminder: next.turnReminder, quiet: next.quiet })); }
    catch { setError(t("reminder.changeError")); }
  }
  const quiet = settings?.quiet ?? { enabled: false, start: 22 * 60, end: 7 * 60 };
  const change = (patch: Partial<Quiet>) => settings && void save({ ...settings, quiet: { ...quiet, ...patch } });
  return <>
    <label className="client-settings-row">
      <span>
        <strong>{t("reminder.label")}</strong>
        <small>{error || t("reminder.detail")}</small>
      </span>
      <input type="checkbox" role="switch" checked={settings?.turnReminder ?? false} disabled={!settings}
        onChange={(event) => settings && void save({ ...settings, turnReminder: event.target.checked })} />
    </label>
    <label className="client-settings-row">
      <span>
        <strong>{t("reminder.quietLabel")}</strong>
        <small>{t("reminder.quietDetail")}</small>
      </span>
      <input type="checkbox" role="switch" checked={quiet.enabled} disabled={!settings}
        onChange={(event) => change({ enabled: event.target.checked })} />
    </label>
    {quiet.enabled && <div className="client-settings-row">
      <label><small>{t("reminder.from")}</small>{" "}
        <input type="time" value={toTime(quiet.start)} onChange={(event) => { const v = fromTime(event.target.value); if (v !== null) change({ start: v }); }} /></label>
      <label><small>{t("reminder.to")}</small>{" "}
        <input type="time" value={toTime(quiet.end)} onChange={(event) => { const v = fromTime(event.target.value); if (v !== null) change({ end: v }); }} /></label>
    </div>}
  </>;
}
