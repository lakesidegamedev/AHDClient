import { useRef } from "react";
import { useDialog } from "./useDialog.js";
import "./settings.css";

interface Props {
  onClose: () => void;
}

const MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform ?? "");
const MOD = MAC ? "Cmd" : "Ctrl";

/** What each shortcut does. The native Game menu carries the same keys. */
export const SHORTCUTS: ReadonlyArray<{ keys: string; does: string }> = [
  { keys: `${MOD}+K`, does: "Ask about the game" },
  { keys: `${MOD}+E`, does: "End turn" },
  { keys: `${MOD}+,`, does: "Open settings" },
  { keys: `${MOD}+R`, does: "Reload the game page" },
  { keys: MAC ? "Cmd+[" : "Alt+Left", does: "Back" },
  { keys: MAC ? "Cmd+]" : "Alt+Right", does: "Forward" },
  { keys: `${MOD}+ +`, does: "Zoom in" },
  { keys: `${MOD}+ -`, does: "Zoom out" },
  { keys: `${MOD}+0`, does: "Actual size" },
  { keys: MAC ? "Ctrl+Cmd+F" : "F11", does: "Full screen" },
  { keys: "Esc", does: "Close a window that is open" },
];

export function ShortcutsDialog({ onClose }: Props): JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);
  useDialog(dialogRef, onClose);
  return (
    <div className="client-settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="client-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="client-shortcuts-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="client-settings-kicker">Desktop</span>
            <h2 id="client-shortcuts-title">Keyboard shortcuts</h2>
          </div>
          <button className="client-settings-close" type="button" aria-label="Close keyboard shortcuts" onClick={onClose}>
            ×
          </button>
        </header>
        <dl className="client-shortcuts">
          {SHORTCUTS.map((row) => (
            <div key={row.keys}>
              <dt>{row.does}</dt>
              <dd><kbd>{row.keys}</kbd></dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
