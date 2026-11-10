import { useRef } from "react";
import { useDialog } from "./useDialog.js";

interface Props {
  /** "confirm" asks first because a run of turns is still playing; "saving" is the wait. */
  mode: "confirm" | "saving";
  onKeepPlaying: () => void;
  onSaveAndClose: () => void;
}

/** Shown when the window is closed while a world is running. */
export function CloseDialog({ mode, onKeepPlaying, onSaveAndClose }: Props): JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);
  useDialog(dialogRef, mode === "confirm" ? onKeepPlaying : () => {});
  return (
    <div className="client-settings-backdrop" role="presentation">
      <section ref={dialogRef} className="client-diagnostic-dialog" role="alertdialog" aria-modal="true" aria-labelledby="close-title">
        <span className="client-settings-kicker">Singleplayer</span>
        {mode === "confirm" ? (
          <>
            <h2 id="close-title">Turns are still playing</h2>
            <p>Closing now saves your world and ends the run. Turns already played are kept.</p>
            <div>
              <button className="secondary" type="button" onClick={onKeepPlaying}>Keep playing</button>
              <button type="button" onClick={onSaveAndClose}>Save and close</button>
            </div>
          </>
        ) : (
          <>
            <h2 id="close-title" role="status">Saving and closing</h2>
            <p>Your world is being saved. This can take a few seconds.</p>
          </>
        )}
      </section>
    </div>
  );
}
