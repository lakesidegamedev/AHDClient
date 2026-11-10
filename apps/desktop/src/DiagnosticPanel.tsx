import { useEffect, useMemo, useRef, useState } from "react";
import { useDialog } from "./useDialog.js";
import {
  clearDiagnostics,
  diagnosticEntries,
  diagnosticLines,
  diagnosticRuntime,
  formatDiagnosticBundle,
  submitDiagnostics,
  subscribeDiagnostics,
} from "./diagnostics.js";

interface Props {
  open: boolean;
  screen: string;
  game: string;
  onClose: () => void;
}

export function DiagnosticPanel(props: Props): JSX.Element | null {
  return props.open ? <DiagnosticDialog {...props} /> : null;
}

function DiagnosticDialog({ screen, game, onClose }: Props): JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);
  useDialog(dialogRef, onClose);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => subscribeDiagnostics(() => setRevision((value) => value + 1)), []);
  const runtime = useMemo(() => diagnosticRuntime(screen, game), [screen, game, revision]);
  const logs = diagnosticEntries();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatDiagnosticBundle(runtime));
      setStatus("Copied redacted diagnostics.");
    } catch {
      setStatus("Copy is unavailable here. You can select the log text below.");
    }
  };
  const send = async () => {
    if (sending) return;
    setSending(true);
    setStatus("");
    try {
      await submitDiagnostics("manual", "Manual diagnostics from Settings.", diagnosticLines(), runtime);
      setStatus("Diagnostics sent.");
    } catch {
      setStatus("Diagnostics could not be sent. Copy them and attach them to a report instead.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="client-settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} className="client-settings-dialog client-diagnostics-panel" role="dialog" aria-modal="true" aria-labelledby="developer-diagnostics-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span className="client-settings-kicker">AHDClient</span><h2 id="developer-diagnostics-title">Developer diagnostics</h2></div>
          <button className="client-settings-close" type="button" aria-label="Close diagnostics" onClick={onClose}>×</button>
        </header>
        <p className="client-diagnostics-privacy">Crash, setup and update failures send a small redacted report automatically. Manual logs are sent only when you tap Send. User paths, world names, email addresses, credentials, and tokens are redacted.</p>
        <dl className="client-runtime-grid">
          <div><dt>Version</dt><dd>{runtime.clientVersion}</dd></div>
          <div><dt>Platform</dt><dd>{runtime.platform}</dd></div>
          <div><dt>Screen</dt><dd>{runtime.screen}</dd></div>
          <div><dt>Game</dt><dd>{runtime.game}</dd></div>
          <div><dt>Network</dt><dd>{runtime.online ? "online" : "offline"}</dd></div>
          <div><dt>Viewport</dt><dd>{runtime.viewport}</dd></div>
          <div className="wide"><dt>Language</dt><dd>{runtime.language}</dd></div>
          <div className="wide"><dt>User agent</dt><dd>{runtime.userAgent}</dd></div>
        </dl>
        <div className="client-console-heading"><strong>Recent console output</strong><small>{logs.length} of 200 entries</small></div>
        <pre className="client-console-output" aria-label="Recent console output">{logs.length ? logs.map((entry) => `${entry.at.slice(11, 23)} ${entry.level.toUpperCase().padEnd(6)} ${entry.message}`).join("\n") : "No console output captured yet."}</pre>
        {status && <p className="client-diagnostics-status" role="status">{status}</p>}
        <footer className="client-diagnostics-actions">
          <button className="secondary" type="button" onClick={() => { clearDiagnostics(); setStatus("Console cleared."); }}>Clear</button>
          <span />
          <button className="secondary" type="button" onClick={() => void copy()}>Copy</button>
          <button type="button" disabled={sending} onClick={() => void send()}>{sending ? "Sending…" : "Send"}</button>
        </footer>
      </section>
    </div>
  );
}
