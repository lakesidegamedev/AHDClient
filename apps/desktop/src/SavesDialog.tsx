import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage, useT } from "./i18n.js";
import { useDialog } from "./useDialog.js";
import { game, worldSaves } from "./worlds.js";
import type { SaveKind, SaveMeta } from "./worlds.js";
import "./settings.css";
import "./saves.css";

interface Props {
  slot: string;
  worldName: string;
  /** This world's game is running: saves can be made, and loading restarts it. */
  running: boolean;
  /** Runs the load: stops the world if needed, queues the save, starts it again. */
  onLoad: (save: SaveMeta) => Promise<void>;
  onClose: () => void;
}

const KIND_KEY = {
  manual: "saves.kindManual",
  auto: "saves.kindAuto",
  safety: "saves.kindSafety",
} as const satisfies Record<SaveKind, string>;

export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function whenLabel(iso: string, language: "en" | "de"): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(language === "de" ? "de-DE" : undefined);
}

/**
 * The saves of one world. Listing and deleting read the world folder, so the
 * dialog works with the game stopped; making a save needs the running game.
 */
export function SavesDialog({ slot, worldName, running, onLoad, onClose }: Props): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const [saves, setSaves] = useState<SaveMeta[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"save" | "load" | "delete" | null>(null);
  const [confirming, setConfirming] = useState<{ id: string; action: "load" | "delete" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autosaveError, setAutosaveError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSaves(await worldSaves.list(slot));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaves([]);
    }
    if (running) {
      try {
        setAutosaveError((await game.saves()).autosaveError);
      } catch {
        // The list above is what matters; the autosave note is a courtesy.
      }
    }
  }, [slot, running]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveNow = async () => {
    if (busy) return;
    setBusy("save");
    setError(null);
    try {
      await game.saveNow(name.trim());
      setName("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (save: SaveMeta) => {
    setBusy("delete");
    setError(null);
    setConfirming(null);
    try {
      await worldSaves.remove(slot, save.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const load = async (save: SaveMeta) => {
    setBusy("load");
    setError(null);
    setConfirming(null);
    try {
      await onLoad(save);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const dialogRef = useRef<HTMLElement>(null);
  useDialog(dialogRef, () => { if (!busy) onClose(); });

  return (
    <div className="client-settings-backdrop" role="presentation" onMouseDown={() => !busy && onClose()}>
      <section
        ref={dialogRef}
        className="client-settings-dialog client-saves-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="client-saves-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="client-settings-kicker">{worldName}</span>
            <h2 id="client-saves-title">{t("saves.title")}</h2>
          </div>
          <button className="client-settings-close" type="button" aria-label={t("saves.close")} disabled={busy === "load"} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="client-saves-body">
          {running ? (
            <form
              className="client-saves-new"
              onSubmit={(event) => {
                event.preventDefault();
                void saveNow();
              }}
            >
              <input
                type="text"
                value={name}
                maxLength={60}
                placeholder={t("saves.namePlaceholder")}
                aria-label={t("saves.nameLabel")}
                onChange={(event) => setName(event.target.value)}
              />
              <button type="submit" disabled={busy !== null}>
                {busy === "save" ? t("saves.saving") : t("saves.saveNow")}
              </button>
            </form>
          ) : (
            <p className="client-saves-note">{t("saves.openToSave")}</p>
          )}
          {autosaveError && (
            <p className="client-saves-warning" role="alert">
              {t("saves.autosaveFailed", { reason: autosaveError })}
            </p>
          )}
          {error && (
            <p className="client-saves-warning" role="alert">
              {error}
            </p>
          )}
          {busy === "load" && (
            <p className="client-saves-note" role="status">
              {t("saves.loading")}
            </p>
          )}
          {saves === null ? (
            <p className="client-saves-note">{t("saves.looking")}</p>
          ) : saves.length === 0 ? (
            <p className="client-saves-note">{t("saves.none")}</p>
          ) : (
            <ul className="client-saves-list">
              {saves.map((save) => (
                <li key={save.id} className="client-saves-row" data-kind={save.kind}>
                  <div className="client-saves-meta">
                    <strong>{save.name}</strong>
                    <small>
                      {t(KIND_KEY[save.kind])}
                      {save.turn != null ? ` · ${t("saves.turn", { turn: save.turn })}` : ""}
                      {save.characterName ? ` · ${save.characterName}` : ""}
                    </small>
                    <small>
                      {whenLabel(save.createdAt, language)} · {formatSize(save.sizeBytes)}
                    </small>
                  </div>
                  <div className="client-saves-actions">
                    {confirming?.id === save.id ? (
                      <>
                        {confirming.action === "load" ? (
                          <>
                            <span className="client-saves-confirm">
                              {save.turn != null ? t("saves.confirmLoadTurn", { turn: save.turn }) : t("saves.confirmLoadThis")}
                            </span>
                            <button type="button" disabled={busy !== null} onClick={() => void load(save)}>
                              {t("saves.loadIt")}
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="client-saves-confirm">{t("saves.confirmDelete")}</span>
                            <button type="button" disabled={busy !== null} onClick={() => void remove(save)}>
                              {t("common.delete")}
                            </button>
                          </>
                        )}
                        <button type="button" className="secondary" disabled={busy !== null} onClick={() => setConfirming(null)}>
                          {t("common.keep")}
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" disabled={busy !== null} onClick={() => setConfirming({ id: save.id, action: "load" })}>
                          {t("saves.load")}
                        </button>
                        <button type="button" className="secondary" disabled={busy !== null} onClick={() => setConfirming({ id: save.id, action: "delete" })}>
                          {t("common.delete")}
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer>
          <span>{t("saves.footer")}</span>
          <button type="button" disabled={busy === "load"} onClick={onClose}>
            {t("common.done")}
          </button>
        </footer>
      </section>
    </div>
  );
}
