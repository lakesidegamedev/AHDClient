import { useEffect, useState } from "react";
import {
  confirmRestartToUpdate,
  downloadAvailableUpdate,
  formatUpdateSize,
  getUpdaterSnapshot,
  subscribeUpdater,
  type UpdaterSnapshot,
} from "./updater.js";
import { online } from "./worlds.js";
import { useT } from "./i18n.js";
import "./update.css";

interface Props {
  /** App-store builds update through their store and have no updater ACL. */
  enabled?: boolean;
}

function progressPercent(state: Extract<UpdaterSnapshot, { kind: "downloading" }>): number | null {
  if (!state.total || state.total <= 0) return null;
  return Math.min(100, Math.round((state.received / state.total) * 100));
}

function releaseNotes(notes: string): string[] {
  return notes
    .split("\n")
    .map((note) => note.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean);
}

export function UpdateNotice({ enabled = true }: Props): JSX.Element | null {
  const t = useT();
  const [state, setState] = useState<UpdaterSnapshot>(getUpdaterSnapshot);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => subscribeUpdater(() => setState(getUpdaterSnapshot())), []);

  useEffect(() => {
    if (state.kind === "ready" || state.kind === "available" || state.kind === "package") setDismissed(false);
  }, [state.kind]);

  if (!enabled) return null;
  if (dismissed && state.kind !== "installing") return null;
  if (
    state.kind === "idle" ||
    state.kind === "checking" ||
    state.kind === "current"
  ) {
    return null;
  }

  const notes =
    state.kind === "ready" || state.kind === "downloading" || state.kind === "available" || state.kind === "package"
      ? releaseNotes(state.notes)
      : [];
  const size = state.kind === "available" ? formatUpdateSize(state.size) : null;

  return (
    <aside className="client-update-notice" role="status" aria-live="polite">
      {state.kind === "error" ? (
        <>
          <div className="client-update-heading">
            <span className="client-update-mark" aria-hidden="true">
              !
            </span>
            <div>
              <strong>{t("update.stopped")}</strong>
              <p>{state.message}</p>
            </div>
          </div>
          <button
            className="client-update-later"
            type="button"
            onClick={() => setDismissed(true)}
          >
            {t("common.dismiss")}
          </button>
        </>
      ) : state.kind === "available" || state.kind === "package" ? (
        <>
          <div className="client-update-heading">
            <span className="client-update-mark" aria-hidden="true">
              &#8593;
            </span>
            <div>
              <strong>{t("update.noticeAvailable", { version: state.version })}</strong>
              <p>
                {state.kind === "package"
                  ? t("update.noticePackage")
                  : `${size ? `${t("update.size", { size })} ` : ""}${t("update.nothingYet")}`}
              </p>
            </div>
          </div>
          {notes.length > 0 && (
            <details className="client-update-details">
              <summary>{t("update.whatsNew")}</summary>
              <ul>
                {notes.map((note, index) => (
                  <li key={`${index}-${note}`}>{note}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="client-update-actions">
            {state.kind === "package" ? (
              <button
                className="client-update-primary"
                type="button"
                onClick={() => void online.help("help.download-client").catch(() => {})}
              >
                {t("update.btnPackage")}
              </button>
            ) : (
              <button
                className="client-update-primary"
                type="button"
                onClick={() => void downloadAvailableUpdate()}
              >
                {t("update.btnDownload")}
              </button>
            )}
            <button
              className="client-update-later"
              type="button"
              onClick={() => setDismissed(true)}
            >
              {t("common.later")}
            </button>
          </div>
        </>
      ) : state.kind === "installing" ? (
        <div className="client-update-heading">
          <span
            className="client-update-mark client-update-mark-pulse"
            aria-hidden="true"
          >
            &#8593;
          </span>
          <div>
            <strong>{t("update.noticeInstalling")}</strong>
            <p>{t("update.reopen")}</p>
          </div>
        </div>
      ) : state.kind === "downloading" ? (
        <>
          <div className="client-update-heading">
            <span
              className="client-update-mark client-update-mark-pulse"
              aria-hidden="true"
            >
              &#8593;
            </span>
            <div>
              <strong>{t("update.noticeDownloading", { version: state.version })}</strong>
              <p>
                {progressPercent(state) == null
                  ? t("update.background")
                  : t("update.percent", { percent: progressPercent(state)! })}
              </p>
            </div>
          </div>
          <div
            className="client-update-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPercent(state) ?? undefined}
          >
            <span
              style={{
                width:
                  progressPercent(state) == null ? "35%" : `${progressPercent(state)}%`,
              }}
              className={progressPercent(state) == null ? "client-update-progress-indeterminate" : undefined}
            />
          </div>
          <button
            className="client-update-later"
            type="button"
            onClick={() => setDismissed(true)}
          >
            {t("update.hide")}
          </button>
        </>
      ) : (
        <>
          <div className="client-update-heading">
            <span className="client-update-mark" aria-hidden="true">
              &#8593;
            </span>
            <div>
              <strong>{t("update.noticeReady", { version: state.version })}</strong>
              <p>{t("update.restartText")}</p>
            </div>
          </div>
          {notes.length > 0 && (
            <details className="client-update-details">
              <summary>{t("update.whatsNew")}</summary>
              <ul>
                {notes.map((note, index) => (
                  <li key={`${index}-${note}`}>{note}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="client-update-actions">
            <button
              className="client-update-primary"
              type="button"
              onClick={() => void confirmRestartToUpdate()}
            >
              {t("update.btnRestart")}
            </button>
            <button
              className="client-update-later"
              type="button"
              onClick={() => setDismissed(true)}
            >
              {t("common.later")}
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
