import { useCallback, useEffect, useRef, useState } from "react";
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

const KIND_LABEL: Record<SaveKind, string> = {
  manual: "Save",
  auto: "Autosave",
  safety: "Before a load",
};

export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function whenLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

/**
 * The saves of one world. Listing and deleting read the world folder, so the
 * dialog works with the game stopped; making a save needs the running game.
 */
export function SavesDialog({ slot, worldName, running, onLoad, onClose }: Props): JSX.Element {
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
            <h2 id="client-saves-title">Saves</h2>
          </div>
          <button className="client-settings-close" type="button" aria-label="Close saves" disabled={busy === "load"} onClick={onClose}>
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
                placeholder="Name this save (optional)"
                aria-label="Save name"
                onChange={(event) => setName(event.target.value)}
              />
              <button type="submit" disabled={busy !== null}>
                {busy === "save" ? "Saving" : "Save now"}
              </button>
            </form>
          ) : (
            <p className="client-saves-note">Open the world to save it. You can load or delete saves from here at any time.</p>
          )}
          {autosaveError && (
            <p className="client-saves-warning" role="alert">
              The last autosave did not work: {autosaveError}
            </p>
          )}
          {error && (
            <p className="client-saves-warning" role="alert">
              {error}
            </p>
          )}
          {busy === "load" && (
            <p className="client-saves-note" role="status">
              Loading. The world restarts and this can take a minute.
            </p>
          )}
          {saves === null ? (
            <p className="client-saves-note">Looking for saves.</p>
          ) : saves.length === 0 ? (
            <p className="client-saves-note">No saves yet. Autosaves appear here after the next turn.</p>
          ) : (
            <ul className="client-saves-list">
              {saves.map((save) => (
                <li key={save.id} className="client-saves-row" data-kind={save.kind}>
                  <div className="client-saves-meta">
                    <strong>{save.name}</strong>
                    <small>
                      {KIND_LABEL[save.kind]}
                      {save.turn != null ? ` · turn ${save.turn}` : ""}
                      {save.characterName ? ` · ${save.characterName}` : ""}
                    </small>
                    <small>
                      {whenLabel(save.createdAt)} · {formatSize(save.sizeBytes)}
                    </small>
                  </div>
                  <div className="client-saves-actions">
                    {confirming?.id === save.id ? (
                      <>
                        {confirming.action === "load" ? (
                          <>
                            <span className="client-saves-confirm">
                              Go back to {save.turn != null ? `turn ${save.turn}` : "this save"}? Where you are now is kept as a save first.
                            </span>
                            <button type="button" disabled={busy !== null} onClick={() => void load(save)}>
                              Load it
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="client-saves-confirm">Delete this save for good?</span>
                            <button type="button" disabled={busy !== null} onClick={() => void remove(save)}>
                              Delete
                            </button>
                          </>
                        )}
                        <button type="button" className="secondary" disabled={busy !== null} onClick={() => setConfirming(null)}>
                          Keep
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" disabled={busy !== null} onClick={() => setConfirming({ id: save.id, action: "load" })}>
                          Load
                        </button>
                        <button type="button" className="secondary" disabled={busy !== null} onClick={() => setConfirming({ id: save.id, action: "delete" })}>
                          Delete
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
          <span>Autosaves keep the last 3. Change how often in Settings.</span>
          <button type="button" disabled={busy === "load"} onClick={onClose}>
            Done
          </button>
        </footer>
      </section>
    </div>
  );
}
