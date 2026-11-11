import { useRef } from "react";
import { useDialog } from "./useDialog.js";
import { useT, type TranslationKey } from "./i18n.js";
import "./settings.css";

interface Props {
  onClose: () => void;
}

const MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform ?? "");
const MOD = MAC ? "Cmd" : "Ctrl";

/** What each shortcut does. The native Game menu carries the same keys. */
export const SHORTCUTS: ReadonlyArray<{ keys: string; does: TranslationKey }> = [
  { keys: `${MOD}+K`, does: "shortcuts.ask" },
  { keys: `${MOD}+E`, does: "shortcuts.endTurn" },
  { keys: `${MOD}+,`, does: "shortcuts.settings" },
  { keys: `${MOD}+R`, does: "shortcuts.reload" },
  { keys: MAC ? "Cmd+[" : "Alt+Left", does: "shortcuts.back" },
  { keys: MAC ? "Cmd+]" : "Alt+Right", does: "shortcuts.forward" },
  { keys: `${MOD}+ +`, does: "shortcuts.zoomIn" },
  { keys: `${MOD}+ -`, does: "shortcuts.zoomOut" },
  { keys: `${MOD}+0`, does: "shortcuts.actualSize" },
  { keys: MAC ? "Ctrl+Cmd+F" : "F11", does: "shortcuts.fullScreen" },
  { keys: "Esc", does: "shortcuts.closeWindow" },
];

export function ShortcutsDialog({ onClose }: Props): JSX.Element {
  const t = useT();
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
            <span className="client-settings-kicker">{t("shortcuts.kicker")}</span>
            <h2 id="client-shortcuts-title">{t("shortcuts.title")}</h2>
          </div>
          <button className="client-settings-close" type="button" aria-label={t("shortcuts.close")} onClick={onClose}>
            ×
          </button>
        </header>
        <dl className="client-shortcuts">
          {SHORTCUTS.map((row) => (
            <div key={row.keys}>
              <dt>{t(row.does)}</dt>
              <dd><kbd>{row.keys}</kbd></dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
