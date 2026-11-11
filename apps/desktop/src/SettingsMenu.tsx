import { useRef, useState } from "react";
import desktopPackage from "../package.json";
import { GameVersionSetting } from "./GameVersionBar.js";
import { PushControl } from "./PushControl.js";
import { AutostartControl, StorageControls } from "./DesktopControls.js";
import { defaultLanguage, LanguageProvider, useT } from "./i18n.js";
import { invoke } from "@tauri-apps/api/core";
import { AUTOSAVE_CHOICES, UI_SCALE_CHOICES, defaultSettingsFor } from "./settings.js";
import type { ClientSettings } from "./settings.js";
import { TrayControl } from "./TrayControl.js";
import { TurnReminderControl } from "./TurnReminderControl.js";
import { UpdateControl } from "./UpdateControl.js";
import { useDialog } from "./useDialog.js";
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
export function SettingsMenu(props: Props): JSX.Element | null {
  return props.open ? <LanguageProvider language={props.settings.language}><SettingsDialog {...props} /></LanguageProvider> : null;
}

function SettingsDialog({ mobile = false, settings, onChange, onClose, onReportIssue, onOpenDiagnostics }: Props): JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);
  useDialog(dialogRef, onClose);
  const t = useT();
  const set = (patch: Partial<ClientSettings>) => onChange({ ...settings, ...patch });
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetError, setResetError] = useState(false);
  // Bumped by a reset so rows that read the system (tray, start on sign-in) read it again.
  const [generation, setGeneration] = useState(0);
  async function reset() {
    setResetError(false);
    setConfirmReset(false);
    if (!mobile) {
      try { await invoke("reset_native_settings"); } catch { setResetError(true); }
    }
    onChange(defaultSettingsFor(defaultLanguage()));
    setGeneration((n) => n + 1);
  }
  return (
    <div className="client-settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} className="client-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="client-settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className="client-settings-kicker">AHDClient {desktopPackage.version}</span>
            <h2 id="client-settings-title">{t("settings.title")}</h2>
          </div>
          <button className="client-settings-close" type="button" aria-label={t("settings.close")} onClick={onClose}>×</button>
        </header>
        <div className="client-settings-body">
          <Section id="client-settings-general" title={t("settings.general")}>
            <label className="client-settings-row">
              <span><strong>{t("settings.language")}</strong><small>{t("settings.languageDetail")}</small></span>
              <select aria-label={t("settings.language")} value={settings.language} onChange={(event) => set({ language: event.target.value === "de" ? "de" : "en" })}><option value="en">English</option><option value="de">Deutsch</option></select>
            </label>
            <Toggle
              title={t("settings.animation")}
              detail={t("settings.animationDetail")}
              checked={settings.animations}
              onChange={(animations) => set({ animations })}
            />
            {!mobile && (
              <label className="client-settings-row">
                <span><strong>{t("settings.scale")}</strong><small>{t("settings.scaleDetail")}</small></span>
                <select aria-label={t("settings.scale")} value={settings.uiScale} onChange={(event) => set({ uiScale: Number(event.target.value) })}>
                  {UI_SCALE_CHOICES.map((n) => <option key={n} value={n}>{n} %</option>)}
                </select>
              </label>
            )}
            {mobile && (
              <Toggle
                title={t("settings.openGame")}
                detail={t("settings.openGameDetail")}
                checked={settings.openGameOnStart}
                onChange={(openGameOnStart) => set({ openGameOnStart })}
              />
            )}
            {!mobile && (
              <Toggle
                title={t("settings.separateWindow")}
                detail={t("settings.separateWindowDetail")}
                checked={settings.separateWindow}
                onChange={(separateWindow) => set({ separateWindow })}
              />
            )}
            {!mobile && <AutostartControl key={`autostart-${generation}`} />}
          </Section>
          <Section id="client-settings-notifications" title={t("settings.notifications")}>
            <PushControl mobile={mobile} onOpenedPage={onClose} />
            {!mobile && <TrayControl key={`tray-${generation}`} />}
            {!mobile && <TurnReminderControl key={`reminder-${generation}`} />}
          </Section>
          {!mobile && (
            <Section id="client-settings-game" title={t("settings.singleplayer")}>
              <label className="client-settings-row">
                <span>
                  <strong>{t("settings.autosave")}</strong>
                  <small>{t("settings.autosaveDetail")}</small>
                </span>
                <select
                  aria-label={t("settings.autosave")}
                  value={AUTOSAVE_CHOICES.some((n) => n === settings.autosaveEvery) ? settings.autosaveEvery : 1}
                  onChange={(event) => set({ autosaveEvery: Number(event.target.value) })}
                >
                  {AUTOSAVE_CHOICES.map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? t("common.off") : n === 1 ? t("settings.autosaveEvery1") : t("settings.autosaveEveryN", { n })}
                    </option>
                  ))}
                </select>
              </label>
              <GameVersionSetting />
              <Toggle
                title={t("settings.statistics")}
                detail={t("settings.statisticsDetail")}
                checked={settings.shareStatistics}
                onChange={(shareStatistics) => set({ shareStatistics })}
              />
            </Section>
          )}
          {!mobile && (
            <Section id="client-settings-storage" title={t("settings.storage")}>
              <StorageControls />
            </Section>
          )}
          {!mobile && (
            <Section id="client-settings-updates" title={t("settings.updates")}>
              <UpdateControl />
              <Toggle
                title={t("settings.autoInstall")}
                detail={t("settings.autoInstallDetail")}
                checked={settings.autoInstallUpdates}
                onChange={(autoInstallUpdates) => set({ autoInstallUpdates })}
              />
            </Section>
          )}
          <Section id="client-settings-support" title={t("settings.support")}>
            <div className="client-support-control"><div><strong>{t("settings.problem")}</strong><small>{t("settings.problemDetail")}</small></div><button type="button" onClick={onReportIssue}>{t("settings.reportProblem")}</button></div>
          </Section>
          <details className="client-settings-advanced">
            <summary>{t("settings.advanced")}</summary>
            <div className="client-settings-options">
              {!mobile && (
                <Toggle
                  title={t("settings.bootLogs")}
                  detail={t("settings.bootLogsDetail")}
                  checked={settings.showBootLogs}
                  onChange={(showBootLogs) => set({ showBootLogs })}
                />
              )}
            </div>
            <div className="client-support-control"><div><strong>{t("settings.diagnostics")}</strong><small>{t("settings.diagnosticsDetail")}</small></div><button type="button" onClick={onOpenDiagnostics}>{t("settings.open")}</button></div>
            <div className="client-support-control">
              <div>
                <strong>{t("settings.reset")}</strong>
                <small role={resetError ? "alert" : undefined}>{resetError ? t("settings.resetError") : confirmReset ? t("settings.resetConfirm") : t("settings.resetDetail")}</small>
              </div>
              {confirmReset ? (
                <span>
                  <button type="button" onClick={() => void reset()}>{t("settings.resetYes")}</button>{" "}
                  <button type="button" className="secondary" onClick={() => setConfirmReset(false)}>{t("common.cancel")}</button>
                </span>
              ) : (
                <button type="button" onClick={() => setConfirmReset(true)}>{t("settings.resetButton")}</button>
              )}
            </div>
          </details>
        </div>
        <footer>{!mobile && <span>{t("settings.escHint")}</span>}<button type="button" onClick={onClose}>{t("common.done")}</button></footer>
      </section>
    </div>
  );
}
