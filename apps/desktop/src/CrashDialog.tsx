import { useRef } from "react";
import { useDialog } from "./useDialog.js";

interface Props {
  message: string;
  /** False when the world is gone from the list, so there is nothing to restart. */
  canRestart: boolean;
  onRestart: () => void;
  onReport: () => void;
  onBack: () => void;
}

/** Shown when the local game stops by itself while a world is open. */
export function CrashDialog({ message, canRestart, onRestart, onReport, onBack }: Props): JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);
  useDialog(dialogRef, onBack);
  return (
    <div className="client-settings-backdrop" role="presentation">
      <section ref={dialogRef} className="client-diagnostic-dialog" role="alertdialog" aria-modal="true" aria-labelledby="crash-title">
        <span className="client-settings-kicker">Singleplayer</span>
        <h2 id="crash-title">{message}</h2>
        <p>Your world is saved up to the last autosave or turn. Restarting opens it again.</p>
        <div>
          <button className="secondary" type="button" onClick={onBack}>Back</button>
          <button className="secondary" type="button" onClick={onReport}>Report</button>
          {canRestart && <button type="button" onClick={onRestart}>Restart world</button>}
        </div>
      </section>
    </div>
  );
}
