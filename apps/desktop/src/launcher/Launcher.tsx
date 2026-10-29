import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import desktopPackage from "../../package.json";
import ahdLogo from "../assets/ahd-logo.png";
import { ERAS, eraForPreset } from "../worlds.js";
import type { WorldMeta } from "../worlds.js";
import { CommandGlobe, themeForEra } from "./CommandGlobe.js";
import { ERA_PHOTOS } from "./eraPhotos.js";
import "./launcher.css";
import type { ClientLanguage } from "../i18n.js";

type Mode = "sp" | "mp" | "sandbox" | "worldsim";

const DESKTOP_MODES: readonly Mode[] = ["sp", "mp", "sandbox", "worldsim"];
/** Phones and tablets run no local game: the live site and the sandbox only. */
const MOBILE_MODES: readonly Mode[] = ["mp", "sandbox"];
/**
 * Store builds sell nothing in-app, so a mode unlocked by an outside purchase
 * is shown only to accounts that already have it (App Store 3.1.3(b)).
 */
const MOBILE_MODES_WITHOUT_SANDBOX: readonly Mode[] = ["mp"];

export type OnlineTarget = "live" | "sandbox";

interface Props {
  language?: ClientLanguage;
  /** Android or iOS: hides every local-game mode and control. */
  mobile?: boolean;
  settingsControl?: ReactNode;
  accountControl?: ReactNode;
  askControl?: ReactNode;
  /** Multiplayer briefing. Phones show it beside Ask under the main action. */
  briefingControl?: ReactNode;
  gameVersionControl?: ReactNode;
  onPhotoSource?: (eraId: string) => void;
  onNewWorld: (eraId: string, worldsim?: boolean) => void;
  onContinue: (slot: string) => void;
  onLoad: () => void;
  onPlayOnline: (target: OnlineTarget) => void;
  error: string | null;
  onClearError: () => void;
  latestWorld: WorldMeta | null;
  runningSlot: string | null;
  continueBusy: boolean;
  sandboxGate?: "unlinked" | "upgrade" | null;
  /** Mobile only: false hides the sandbox mode entirely. */
  sandboxAvailable?: boolean;
  onLinkAccount?: () => void;
  onUpgradeSupporter?: (() => void) | undefined;
  /** Entry-gate refusal: the error box offers Link account next to Dismiss. */
  errorOffersLink?: boolean;
}

const MODE_STORAGE_KEY = "ahdclient.launcher.mode";
const ERA_STORAGE_KEY = "ahdclient.launcher.era";

function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preferences are optional. The launcher still works when storage is unavailable.
  }
}

export function Launcher({
  language = "en",
  mobile = false,
  settingsControl,
  accountControl,
  askControl,
  briefingControl,
  gameVersionControl,
  onPhotoSource,
  onNewWorld,
  onContinue,
  onLoad,
  onPlayOnline,
  error,
  onClearError,
  latestWorld,
  runningSlot,
  continueBusy,
  // Optional, so an omitted gate has to mean "no gate". Without the default it
  // arrives as undefined, which is not null, which disabled the Enter button
  // permanently — the prop's own optionality turned the sandbox off.
  sandboxGate = null,
  sandboxAvailable = true,
  onLinkAccount,
  onUpgradeSupporter,
  errorOffersLink = false,
}: Props): JSX.Element {
  const de = language === "de";
  const eras = useMemo(() => ERAS, []);
  const modes = mobile
    ? sandboxAvailable ? MOBILE_MODES : MOBILE_MODES_WITHOUT_SANDBOX
    : DESKTOP_MODES;
  const [mode, setMode] = useState<Mode>(() => {
    const saved = readPreference(MODE_STORAGE_KEY);
    const known = modes.find((candidate) => candidate === saved);
    return known ?? modes[0]!;
  });
  const [eraId, setEraId] = useState<string>(() => {
    const saved = readPreference(ERA_STORAGE_KEY);
    return saved && eras.some(({ id }) => id === saved)
      ? saved
      : (eras[0]?.id ?? "1953");
  });
  const [choosingEra, setChoosingEra] = useState(false);

  useEffect(() => {
    if (eras.length > 0 && !eras.some((era) => era.id === eraId)) {
      setEraId(eras[0]!.id);
    }
  }, [eras, eraId]);

  // Losing a mode (a supporter account signed out) falls back to the first.
  useEffect(() => {
    if (!modes.includes(mode)) setMode(modes[0]!);
  }, [modes, mode]);

  useEffect(() => writePreference(MODE_STORAGE_KEY, mode), [mode]);
  useEffect(() => writePreference(ERA_STORAGE_KEY, eraId), [eraId]);

  const multiplayer = mode === "mp" || mode === "sandbox";
  const onlineTarget: OnlineTarget = mode === "sandbox" ? "sandbox" : "live";
  const selectedEra = eras.find((era) => era.id === eraId) ?? eras[0];
  const latestEra = latestWorld ? eraForPreset(latestWorld.preset) : undefined;
  const latestRunning =
    latestWorld !== null && runningSlot === latestWorld.slot;
  const selectedPhoto = selectedEra ? ERA_PHOTOS[selectedEra.id] : undefined;
  // Phones keep the top bar to identity and Settings. Briefing and Ask are
  // tabs in the native tab bar there (2.7), so the launcher does not repeat
  // them; the quick row only remains for a phone whose tab bar failed to
  // attach, which marks nothing on the page.
  const nativeTabs =
    mobile && typeof window !== "undefined" &&
    (window as { __ahdclientNativeTabs?: boolean }).__ahdclientNativeTabs === true;
  const topControls = mobile
    ? [accountControl, settingsControl]
    : [accountControl, briefingControl, settingsControl, askControl];
  const quickControls = mobile && !nativeTabs ? [briefingControl, askControl].filter(Boolean) : [];

  return (
    <main
      className="launcher-scope"
      data-mode={mode}
      data-choosing-era={choosingEra && !multiplayer}
    >
      <div
        className="launcher-pattern"
        aria-hidden="true"
        style={{ "--nebula": themeForEra(eraId).dim } as CSSProperties}
      >
        <div className="launcher-nebula" />
      </div>

      {topControls.some(Boolean) && (
        <nav className="launcher-topbar" aria-label="Client">
          {topControls.map((control, index) => (control ? <span key={index}>{control}</span> : null))}
        </nav>
      )}

      <section className="launcher-stage" aria-labelledby="launcher-title">
        <header className="launcher-mast">
          <img className="launcher-logo" src={ahdLogo} alt="" />
          <div className="launcher-lockup">
            <p className="launcher-edition">AHDClient</p>
            <h1 id="launcher-title">A House Divided</h1>
            <p className="launcher-subtitle">
              {de ? "Eine historische politische Simulation" : "A historical political simulation"}
            </p>
          </div>
        </header>

        <div className="launcher-console">
          {modes.length > 1 && (
          <div
            className="launcher-toggle"
            data-mode={mode}
            data-modes={modes.length}
            aria-label="Play mode"
          >
            <div className="launcher-toggle-thumb" aria-hidden="true" />
            {!mobile && (
              <button
                className={mode === "sp" ? "active" : ""}
                onClick={() => setMode("sp")}
                aria-pressed={mode === "sp"}
              >
                {de ? "Einzelspieler" : "Singleplayer"} <span className="client-beta">Beta</span>
              </button>
            )}
            <button
              className={mode === "mp" ? "active" : ""}
              onClick={() => setMode("mp")}
              aria-pressed={mode === "mp"}
            >
              {de ? "Mehrspieler" : "Multiplayer"}
            </button>
            {modes.includes("sandbox") && (
              <button
                className={mode === "sandbox" ? "active" : ""}
                onClick={() => setMode("sandbox")}
                aria-pressed={mode === "sandbox"}
              >
                Sandbox
              </button>
            )}
            {!mobile && (
              <button
                className={mode === "worldsim" ? "active" : ""}
                onClick={() => {
                  setMode("worldsim");
                  setChoosingEra(false);
                }}
                aria-pressed={mode === "worldsim"}
              >
                Worldsim <span className="client-beta">Beta</span>
              </button>
            )}
          </div>
          )}

          {error && (
            <div className="launcher-error" role="alert">
              <span>{error}</span>
              {errorOffersLink && onLinkAccount && (
                <button onClick={onLinkAccount}>Link account</button>
              )}
              <button onClick={onClearError}>Dismiss</button>
            </div>
          )}

          {multiplayer ? (
            <div className="launcher-online-summary" aria-live="polite">
              <span className="launcher-live-dot" aria-hidden="true" />
              <span>
                <strong>
                  {mode === "sandbox"
                    ? "Enter the sandbox server"
                    : "Continue in the online world"}
                </strong>
                <small>
                  {mode === "sandbox"
                    ? "A separate world for trying things out. Nothing here touches the main game."
                    : mobile
                      ? "Your session stays in the app. Tap the AHD mark on any page to come back here."
                      : "Your account and session stay together in the app."}
                </small>
              </span>
              {mode === "sandbox" && sandboxGate === "unlinked" && (
                <span className="launcher-sandbox-gate">
                  <strong>Link your account to enter the sandbox.</strong>
                  <button onClick={onLinkAccount}>Link account</button>
                </span>
              )}
              {mode === "sandbox" && sandboxGate === "upgrade" && (
                <span className="launcher-sandbox-gate">
                  <strong>
                    Sandbox access requires an active Supporter tier.
                  </strong>
                  {onUpgradeSupporter && (
                    <button onClick={onUpgradeSupporter}>
                      View Supporter tiers
                    </button>
                  )}
                </span>
              )}
            </div>
          ) : choosingEra ? (
            <div className="launcher-era-panel" aria-label="New game setup">
              <div className="launcher-panel-label">
                <button
                  className="launcher-back"
                  onClick={() => setChoosingEra(false)}
                >
                  {de ? "Zurück" : "Back"}
                </button>
                <span>{de ? "Startzeitalter wählen" : "Choose a starting era"}</span>
                <span>{eras.length} {de ? "Zeitalter" : "eras"}</span>
              </div>
              <div className="launcher-era-timeline" role="list" aria-label={de ? "Zeitleiste der Startzeitalter" : "Starting era timeline"}>
                {eras.map((era) => <div role="listitem" key={era.id}><button type="button" aria-current={era.id === eraId ? "true" : undefined} className={era.id === eraId ? "active" : ""} onClick={() => setEraId(era.id)}><span className="launcher-era-node" style={{ borderColor: themeForEra(era.id).phosphor }} /><strong>{era.label}</strong><small>{era.subtitle}</small></button></div>)}
              </div>
              <div className="launcher-era-carousel">
                <div className="launcher-era-card" aria-live="polite">
                  {selectedPhoto && (
                    <img
                      className="launcher-era-photo"
                      src={selectedPhoto.src}
                      alt={selectedPhoto.alt}
                    />
                  )}
                  <span className="launcher-era-year">
                    {selectedEra?.label}
                  </span>
                  <strong>{selectedEra?.subtitle}</strong>
                  <span>{selectedEra?.startDate}</span>
                  <p>{selectedEra?.description}</p>
                  <p className="launcher-playable">
                    <strong>Playable nations</strong>
                    <br />
                    {selectedEra?.playableNations?.join(" · ") ||
                      "Availability is checked during setup"}
                  </p>
                  {selectedPhoto && (
                    <div className="launcher-era-attribution">
                      <span>
                        {selectedPhoto.credit} · {selectedPhoto.license}
                      </span>
                      {onPhotoSource ? (
                        <button
                          type="button"
                          onClick={() => onPhotoSource(selectedEra!.id)}
                        >
                          Photo source
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          <div className="launcher-actions">
            {multiplayer ? (
              <>
                <button
                  className="launcher-btn launcher-btn-primary"
                  onClick={() => onPlayOnline(onlineTarget)}
                  disabled={
                    continueBusy || (mode === "sandbox" && sandboxGate !== null)
                  }
                >
                  {mode === "sandbox" ? "Enter sandbox" : "Enter multiplayer"}{" "}
                  <span aria-hidden="true">&#8599;</span>
                </button>
                {quickControls.length > 0 && (
                  <div className="launcher-quick">
                    {quickControls.map((control, index) => <span key={index}>{control}</span>)}
                  </div>
                )}
              </>
            ) : (
              <>
                <button
                  className="launcher-btn launcher-btn-primary"
                  onClick={() =>
                    choosingEra
                      ? mode === "worldsim"
                        ? onNewWorld(eraId, true)
                        : onNewWorld(eraId)
                      : setChoosingEra(true)
                  }
                  disabled={continueBusy}
                >
                    {choosingEra ? (de ? "Neues Spiel starten" : "Start new game") : (de ? "Neues Spiel" : "New Game")}{" "}
                  <span aria-hidden="true">&#8594;</span>
                </button>
                {!choosingEra && (
                  <button
                    className="launcher-btn launcher-btn-secondary"
                    onClick={onLoad}
                    disabled={continueBusy}
                  >
                    {de ? "Spiel laden" : "Load Game"}
                  </button>
                )}
                {latestWorld && !choosingEra && (
                  <button
                    className="launcher-btn launcher-btn-secondary launcher-btn-continue"
                    onClick={() => onContinue(latestWorld.slot)}
                    disabled={continueBusy}
                    aria-busy={continueBusy}
                    title={`${latestWorld.name}${latestWorld.turn != null ? ` · turn ${latestWorld.turn}` : ""}`}
                  >
                    <span>
                      {continueBusy
                        ? "Starting"
                        : latestRunning
                          ? "Resume"
                          : "Continue"}
                      <small>
                        {latestWorld.name}
                        {latestEra ? ` · ${latestEra.label}` : ""}
                        {latestWorld.turn != null
                          ? ` · turn ${latestWorld.turn}`
                          : ""}
                      </small>
                    </span>
                    <span aria-hidden="true">&#8594;</span>
                  </button>
                )}
              </>
            )}
          </div>

          <CommandGlobe eraId={eraId} live={multiplayer} />
        </div>
      </section>

      <footer className="launcher-footer">
        <span>AHDClient {desktopPackage.version}</span>
        {gameVersionControl}
      </footer>
    </main>
  );
}
