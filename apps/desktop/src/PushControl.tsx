import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface PushStatus {
  enabled: boolean;
  available: boolean;
  registered: boolean;
  permissionGranted: boolean;
  message: string;
}

interface Props {
  /** Phones get pushes even when the app is closed; desktop alerts need the client open. */
  mobile?: boolean;
  /** Called after the alert-type settings page opens, so the dialog can get out of the way. */
  onOpenedPage?: () => void;
}

/** What each test verdict means for the player. */
const TEST_RESULT: Record<string, string> = {
  sent: "Sent. It should appear within a few seconds. If it does not, check that notifications are allowed for the app in your device settings.",
  not_registered: "This device is not connected for alerts yet. Wait a minute after turning them on, then try again.",
  signed_out: "Sign in to multiplayer first, then try again.",
  rate_limited: "Too many tests in a row. Try again in a minute.",
  permission_denied: "Notifications are blocked for AHDClient in your system settings.",
  retry: "The alert service did not answer. Try again shortly.",
  invalid: "This device's alert connection expired. Turn alerts off and on again.",
  error: "Could not send a test alert. Try again shortly.",
};

export function PushControl({ mobile = true, onOpenedPage }: Props): JSX.Element {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");
  useEffect(() => {
    let active = true;
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const next = await invoke<PushStatus>("get_push_status");
        if (active) setStatus(next);
      } catch { if (active) setError("Could not read notification settings."); }
      finally { pending = false; }
    }
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 3000);
    window.addEventListener("focus", refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);
  async function toggle() {
    setBusy(true); setError("");
    try { setStatus(await invoke<PushStatus>("configure_push", { enabled: !status?.enabled })); }
    catch { setError("Could not change notification settings. Please try again."); }
    finally { setBusy(false); }
  }
  async function sendTest() {
    setTesting(true); setTestResult("");
    try {
      const { result } = await invoke<{ result: string }>("send_test_push");
      setTestResult(TEST_RESULT[result] ?? TEST_RESULT.error!);
    } catch { setTestResult(TEST_RESULT.error!); }
    finally { setTesting(false); }
  }
  async function chooseTypes() {
    setError("");
    try { await invoke("open_game_page", { path: "/settings" }); onOpenedPage?.(); }
    catch { setError("Could not open the game settings. Sign in to multiplayer and try again."); }
  }
  const label = mobile ? "Push notifications" : "Desktop alerts";
  const summary = mobile
    ? "Elections, legislation, party, treasury and corporation alerts from your inbox, even when the app is closed."
    : "Elections, legislation, party, treasury and corporation alerts from your inbox, as system notifications while AHDClient is open.";
  const detail = mobile
    ? "Each alert shows its title, category and message, and tapping it opens the page it is about. To hide alert text while your phone is locked, change notification previews in your phone's settings."
    : "Each alert shows its title, category and message. Alerts stay quiet while you are looking at the live game, and routine turn income stays in the inbox.";
  return <div className="client-push-control">
    <div className="client-support-control">
      <div><strong>{label}</strong><small>{summary}</small></div>
      <button type="button" onClick={() => void toggle()} disabled={busy || !status || (!status.available && !status.enabled)}
        aria-pressed={status?.enabled ?? false}>{busy ? "Updating..." : status?.enabled ? "Turn off" : "Turn on"}</button>
    </div>
    <p role="status" className="client-push-status">{error || status?.message || "Checking notification settings..."}</p>
    {status?.enabled && (
      <div className="client-support-control">
        <div><strong>Test alert</strong><small>{testResult || (mobile ? "Send one alert to this phone to check that alerts arrive." : "Show one alert to check how they look on this computer.")}</small></div>
        <button type="button" onClick={() => void sendTest()} disabled={testing}>{testing ? "Sending..." : "Send test"}</button>
      </div>
    )}
    <p className="client-push-status">{detail}</p>
    <div className="client-support-control">
      <div><strong>Alert types</strong><small>Mute the kinds of alerts you do not want under Game in the site settings. Mutes and snoozes apply to {mobile ? "push" : "desktop"} alerts too.</small></div>
      <button type="button" onClick={() => void chooseTypes()}>Choose</button>
    </div>
  </div>;
}
