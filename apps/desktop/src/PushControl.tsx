import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT, type TranslationKey } from "./i18n.js";

const TEST_RESULTS = ["sent", "not_registered", "signed_out", "rate_limited", "permission_denied", "retry", "invalid", "error"];

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

export function PushControl({ mobile = true, onOpenedPage }: Props): JSX.Element {
  const t = useT();
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
      } catch { if (active) setError(t("push.readError")); }
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
    catch { setError(t("push.changeError")); }
    finally { setBusy(false); }
  }
  async function sendTest() {
    setTesting(true); setTestResult("");
    try {
      const { result } = await invoke<{ result: string }>("send_test_push");
      setTestResult(t(`push.test.${TEST_RESULTS.includes(result) ? result : "error"}` as TranslationKey));
    } catch { setTestResult(t("push.test.error")); }
    finally { setTesting(false); }
  }
  async function chooseTypes() {
    setError("");
    try { await invoke("open_game_page", { path: "/settings" }); onOpenedPage?.(); }
    catch { setError(t("push.openError")); }
  }
  const label = t(mobile ? "push.mobileLabel" : "push.desktopLabel");
  const summary = t(mobile ? "push.mobileSummary" : "push.desktopSummary");
  const detail = t(mobile ? "push.mobileDetail" : "push.desktopDetail");
  return <div className="client-push-control">
    <div className="client-support-control">
      <div><strong>{label}</strong><small>{summary}</small></div>
      <button type="button" onClick={() => void toggle()} disabled={busy || !status || (!status.available && !status.enabled)}
        aria-pressed={status?.enabled ?? false}>{busy ? t("push.updating") : status?.enabled ? t("push.turnOff") : t("push.turnOn")}</button>
    </div>
    <p role="status" className="client-push-status">{error || status?.message || t("push.checking")}</p>
    {status?.enabled && (
      <div className="client-support-control">
        <div><strong>{t("push.testTitle")}</strong><small>{testResult || t(mobile ? "push.testMobile" : "push.testDesktop")}</small></div>
        <button type="button" onClick={() => void sendTest()} disabled={testing}>{testing ? t("push.sending") : t("push.sendTest")}</button>
      </div>
    )}
    <p className="client-push-status">{detail}</p>
    <div className="client-support-control">
      <div><strong>{t("push.typesTitle")}</strong><small>{t(mobile ? "push.typesDetailMobile" : "push.typesDetailDesktop")}</small></div>
      <button type="button" onClick={() => void chooseTypes()}>{t("push.choose")}</button>
    </div>
  </div>;
}
