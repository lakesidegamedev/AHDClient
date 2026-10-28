import desktopPackage from "../package.json";
import { PushControl } from "./PushControl.js";
import type { ClientSettings } from "./settings.js";
import { UpdateControl } from "./UpdateControl.js";
import "./settings.css";

interface Props {
  /** Android or iOS: no local game, no separate window, no desktop updater. */
  mobile?: boolean;
  open: boolean;
  settings: ClientSettings;
  onChange: (settings: ClientSettings) => void;
  onClose: () => void;
  onReportIssue: () => void;
  onOpenDiagnostics: () => void;
}

function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="client-settings-section" aria-labelledby={id}>
      <div className="client-settings-section-heading"><h3 id={id}>{title}</h3>{description && <p>{description}</p>}</div>
      <div className="client-settings-options">{children}</div>
    </section>
  );
}

function Toggle({ title, detail, checked, onChange }: { title: string; detail: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="client-settings-row">
      <span><strong>{title}</strong><small>{detail}</small></span>
      <input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

/**
 * One dialog for every platform. Phones drop the rows that only make sense
 * with a local game or the desktop updater (store builds update through the
 * store, so an Updates section there would offer nothing to do).
 */
export function SettingsMenu({ mobile = false, open, settings, onChange, onClose, onReportIssue, onOpenDiagnostics }: Props): JSX.Element | null {
  if (!open) return null;
  const de = settings.language === "de";
  const set = (patch: Partial<ClientSettings>) => onChange({ ...settings, ...patch });
  return (
    <div className="client-settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="client-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="client-settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className="client-settings-kicker">AHDClient {desktopPackage.version}</span>
            <h2 id="client-settings-title">{de ? "Einstellungen" : "Settings"}</h2>
          </div>
          <button className="client-settings-close" type="button" aria-label={de ? "Einstellungen schließen" : "Close settings"} onClick={onClose}>×</button>
        </header>
        <div className="client-settings-body">
          <Section id="client-settings-general" title={de ? "Allgemein" : "General"}>
            <label className="client-settings-row">
              <span><strong>{de ? "Sprache" : "Language"}</strong><small>{de ? "Für Launcher und Client-Steuerung." : "For the launcher and client controls."}</small></span>
              <select aria-label={de ? "Sprache" : "Language"} value={settings.language} onChange={(event) => set({ language: event.target.value === "de" ? "de" : "en" })}><option value="en">English</option><option value="de">Deutsch</option></select>
            </label>
            <Toggle
              title={de ? "Launcher-Animation" : "Launcher animation"}
              detail={de ? "Animiert Globus und Hintergrund." : "Animate the globe and background."}
              checked={settings.animations}
              onChange={(animations) => set({ animations })}
            />
            {!mobile && (
              <Toggle
                title={de ? "Separates Spielfenster" : "Separate gameplay window"}
                detail={de ? "Öffnet das Spiel beim nächsten Mal außerhalb des Launchers." : "Open the game in its own window next time."}
                checked={settings.separateWindow}
                onChange={(separateWindow) => set({ separateWindow })}
              />
            )}
          </Section>
          <Section id="client-settings-notifications" title={de ? "Benachrichtigungen" : "Notifications"}>
            <PushControl mobile={mobile} onOpenedPage={onClose} />
          </Section>
          {!mobile && (
            <Section id="client-settings-game" title={de ? "Einzelspieler" : "Singleplayer"}>
              <Toggle
                title={de ? "Anonyme Simulationsstatistik" : "Anonymous simulation statistics"}
                detail={de ? "Teilt Welteinstellungen und Gesamtergebnisse. Nie Kontodaten, Charakternamen oder Spielstände." : "Share world settings and overall outcomes. Never account details, character names or saves."}
                checked={settings.shareStatistics}
                onChange={(shareStatistics) => set({ shareStatistics })}
              />
            </Section>
          )}
          {!mobile && (
            <Section id="client-settings-updates" title="Updates">
              <UpdateControl />
            </Section>
          )}
          <Section id="client-settings-support" title={de ? "Hilfe" : "Support"}>
            <div className="client-support-control"><div><strong>{de ? "Problem gefunden?" : "Found a problem?"}</strong><small>{de ? "Sende einen Bericht mit deiner Client-Version." : "Send a report with your client version attached."}</small></div><button type="button" onClick={onReportIssue}>{de ? "Problem melden" : "Report a problem"}</button></div>
          </Section>
          <details className="client-settings-advanced">
            <summary>{de ? "Erweitert" : "Advanced"}</summary>
            <div className="client-settings-options">
              {!mobile && (
                <Toggle
                  title={de ? "Technische Startprotokolle" : "Technical startup logs"}
                  detail={de ? "Zeigt Details beim Start, um ein Problem einzugrenzen." : "Show detailed logs while diagnosing a launch issue."}
                  checked={settings.showBootLogs}
                  onChange={(showBootLogs) => set({ showBootLogs })}
                />
              )}
            </div>
            <div className="client-support-control"><div><strong>{de ? "Entwicklerdiagnose" : "Developer diagnostics"}</strong><small>{de ? "Konsolenausgabe und Laufzeitdaten ansehen." : "View console output and runtime information."}</small></div><button type="button" onClick={onOpenDiagnostics}>{de ? "Öffnen" : "Open"}</button></div>
          </details>
        </div>
        <footer>{!mobile && <span>{de ? "Esc zum Schließen" : "Press Esc to close"}</span>}<button type="button" onClick={onClose}>{de ? "Fertig" : "Done"}</button></footer>
      </section>
    </div>
  );
}
