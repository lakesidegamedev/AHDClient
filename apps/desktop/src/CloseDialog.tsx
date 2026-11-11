import { useRef } from "react";
import { useT } from "./i18n.js";
import { useDialog } from "./useDialog.js";

interface Props {
  /** "confirm" asks first because a run of turns is still playing; "saving" is the wait. */
  mode: "confirm" | "saving";
  onKeepPlaying: () => void;
  onSaveAndClose: () => void;
}

/** Shown when the window is closed while a world is running. */
export function CloseDialog({ mode, onKeepPlaying, onSaveAndClose }: Props): JSX.Element {
  const t = useT();
  const dialogRef = useRef<HTMLElement>(null);
  useDialog(dialogRef, mode === "confirm" ? onKeepPlaying : () => {});
  return (
    <div className="client-settings-backdrop" role="presentation">
      <section ref={dialogRef} className="client-diagnostic-dialog" role="alertdialog" aria-modal="true" aria-labelledby="close-title">
        <span className="client-settings-kicker">{t("close.kicker")}</span>
        {mode === "confirm" ? (
          <>
            <h2 id="close-title">{t("close.playingTitle")}</h2>
            <p>{t("close.playingText")}</p>
            <div>
              <button className="secondary" type="button" onClick={onKeepPlaying}>{t("close.keepPlaying")}</button>
              <button type="button" onClick={onSaveAndClose}>{t("close.saveClose")}</button>
            </div>
          </>
        ) : (
          <>
            <h2 id="close-title" role="status">{t("close.savingTitle")}</h2>
            <p>{t("close.savingText")}</p>
          </>
        )}
      </section>
    </div>
  );
}
