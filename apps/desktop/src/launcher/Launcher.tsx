import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import desktopPackage from "../../package.json";
import ahdLogo from "../assets/ahd-logo.png";
import { ERAS, eraForPreset } from "../worlds.js";
import type { Era, WorldMeta } from "../worlds.js";
import { legacyCapabilities } from "../capabilities.js";
import type { Capabilities, CapabilityPreset } from "../capabilities.js";
import { CommandGlobe, themeForEra } from "./CommandGlobe.js";
import { ERA_PHOTOS } from "./eraPhotos.js";
import "./launcher.css";
import { translate, useLanguage, type ClientLanguage, type TranslationKey, type TranslationVars } from "../i18n.js";

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

/** Era text and photos stay client-side, keyed by era id. */
function eraForCapabilityPreset(preset: CapabilityPreset): Era {
  return (
    ERAS.find((era) => era.id === preset.era) ?? {
      id: preset.era,
      preset: preset.preset,
      label: preset.era,
      subtitle: "",
      startDate: "",
    }
  );
}

const joinNames = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * What the era card says about who you can play. A runtime that reports its
 * countries gets a plain sentence; the older table keeps the nation list.
 */
export function playableSummary(era: Era | undefined, preset: CapabilityPreset | undefined, source: Capabilities["source"]): string | null {
  if (source === "manifest" && preset && preset.playerCountries.length > 0) {
    const player = joinNames(preset.playerCountries.map((country) => country.name));
    const computer = preset.computerCountries.map((country) => country.name);
    const verb = preset.playerCountries.length > 1 ? "You can play" : "You play in";
    return computer.length > 0
      ? `${verb} the ${player}. The ${joinNames(computer)} ${computer.length > 1 ? "are" : "is"} run by the computer.`
      : `${verb} the ${player}.`;
  }
  return era?.playableNations?.join(" · ") || null;
}

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
  /** What the game runtime supports. Absent means the older client-side era table. */
  capabilities?: Capabilities | undefined;
  /**
   * Set once a Classic runtime can be installed. Eras the bundled game cannot
   * seed then sit under a "Classic eras" heading instead of staying hidden.
   */
  classicAvailable?: boolean;
  /** The Classic game is already on this computer: eras can be started directly. */
  classicInstalled?: boolean;
  /** Download size shown on the one-time download button, such as "310 MB". */
  classicSizeLabel?: string;
  onClassicEras?: () => void;
  onClassicEra?: (eraId: string) => void;
  onPhotoSource?: (eraId: string) => void;
  onNewWorld: (eraId: string, worldsim?: boolean) => void;
  /** Start the chosen era now with the recommended settings, skipping setup. */
  onQuickStart?: (eraId: string) => void;
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
  language,
  mobile = false,
  settingsControl,
  accountControl,
  askControl,
  briefingControl,
  gameVersionControl,
  capabilities,
  classicAvailable = false,
  classicInstalled = false,
  classicSizeLabel = "",
  onClassicEras,
  onClassicEra,
  onPhotoSource,
  onNewWorld,
  onQuickStart,
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
  const contextLanguage = useLanguage();
  const activeLanguage = language ?? contextLanguage;
  const t = (key: TranslationKey, vars?: TranslationVars) => translate(activeLanguage, key, vars);
  const caps = useMemo(() => capabilities ?? legacyCapabilities(), [capabilities]);
  // Only eras this runtime can seed are offered. An era with nothing to tap is
  // never shown; the rest are Classic eras, listed only once Classic exists.
  const eras = useMemo(
    () => caps.presets.filter((preset) => preset.seedable).map(eraForCapabilityPreset),
    [caps],
  );
  const classicEras = useMemo(
    () => caps.presets.filter((preset) => !preset.seedable).map(eraForCapabilityPreset),
    [caps],
  );
  const defaultEraId =
    eras.find((era) => era.preset === caps.defaultPreset)?.id ?? eras[eras.length - 1]?.id ?? eras[0]?.id ?? "";
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
      : defaultEraId;
  });
  const [choosingEra, setChoosingEra] = useState(false);

  useEffect(() => {
    if (eras.length > 0 && !eras.some((era) => era.id === eraId)) {
      setEraId(defaultEraId);
    }
  }, [eras, eraId, defaultEraId]);

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
  // Phones keep the top bar to identity and Settings. Briefing and Ask live
  // in the native dock's More sheet there (2.10), so the launcher does not
  // repeat them; the quick row only remains for a phone whose dock failed to
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
              {t("launcher.subtitle")}
            </p>
          </div>
        </header>

        <div className="launcher-console">
          {modes.length > 1 && (
          <div
            className="launcher-toggle"
            data-mode={mode}
            data-modes={modes.length}
            aria-label={t("launcher.playMode")}
          >
            <div className="launcher-toggle-thumb" aria-hidden="true" />
            {!mobile && (
              <button
                className={mode === "sp" ? "active" : ""}
                onClick={() => setMode("sp")}
                aria-pressed={mode === "sp"}
              >
                {t("launcher.singleplayer")} <span className="client-beta">Beta</span>
              </button>
            )}
            <button
              className={mode === "mp" ? "active" : ""}
              onClick={() => setMode("mp")}
              aria-pressed={mode === "mp"}
            >
              {t("launcher.multiplayer")}
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
                <button onClick={onLinkAccount}>{t("common.linkAccount")}</button>
              )}
              <button onClick={onClearError}>{t("common.dismiss")}</button>
            </div>
          )}

          {multiplayer ? (
            <div className="launcher-online-summary" aria-live="polite">
              <span className="launcher-live-dot" aria-hidden="true" />
              <span>
                <strong>
                  {mode === "sandbox"
                    ? t("launcher.sandboxTitle")
                    : t("launcher.onlineTitle")}
                </strong>
                <small>
                  {mode === "sandbox"
                    ? t("launcher.sandboxBody")
                    : mobile
                      ? t("launcher.mobileBody")
                      : t("launcher.onlineBody")}
                </small>
              </span>
              {mode === "sandbox" && sandboxGate === "unlinked" && (
                <span className="launcher-sandbox-gate">
                  <strong>{t("launcher.sandboxLink")}</strong>
                  <button onClick={onLinkAccount}>{t("common.linkAccount")}</button>
                </span>
              )}
              {mode === "sandbox" && sandboxGate === "upgrade" && (
                <span className="launcher-sandbox-gate">
                  <strong>{t("launcher.sandboxUpgrade")}</strong>
                  {onUpgradeSupporter && (
                    <button onClick={onUpgradeSupporter}>
                      {t("launcher.viewSupporter")}
                    </button>
                  )}
                </span>
              )}
            </div>
          ) : choosingEra ? (
            <div className="launcher-era-panel" aria-label={t("launcher.setupAria")}>
              <div className="launcher-panel-label">
                <button
                  className="launcher-back"
                  onClick={() => setChoosingEra(false)}
                >
                  {t("common.back")}
                </button>
                <span>{t("launcher.chooseEra")}</span>
                <span>{t("launcher.erasCount", { n: eras.length })}</span>
              </div>
              <div className="launcher-era-timeline" role="list" aria-label={t("launcher.eraTimeline")}>
                {eras.map((era) => <div role="listitem" key={era.id}><button type="button" aria-current={era.id === eraId ? "true" : undefined} className={era.id === eraId ? "active" : ""} onClick={() => setEraId(era.id)}><span className="launcher-era-node" style={{ borderColor: themeForEra(era.id).phosphor }} /><strong>{era.label}</strong><small>{era.subtitle}</small></button></div>)}
              </div>
              {classicAvailable && classicEras.length > 0 && onClassicEras && (
                <div className="launcher-classic-eras">
                  <strong>{t("launcher.classicEras")}</strong>
                  <small>
                    {classicInstalled
                      ? t("launcher.classicInstalledBody")
                      : t(classicSizeLabel ? "launcher.classicDownloadSized" : "launcher.classicDownload", {
                          eras: classicEras.map((era) => era.label).join(", "),
                          size: classicSizeLabel,
                        })}
                  </small>
                  {classicInstalled && onClassicEra ? (
                    classicEras.map((era) => (
                      <button key={era.id} type="button" className="launcher-btn launcher-btn-secondary" onClick={() => onClassicEra(era.id)}>
                        {era.label} · {era.subtitle}
                      </button>
                    ))
                  ) : (
                    <button type="button" className="launcher-btn launcher-btn-secondary" onClick={onClassicEras}>
                      {t("launcher.getClassic")}
                    </button>
                  )}
                </div>
              )}
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
                    <strong>{t("launcher.playableNations")}</strong>
                    <br />
                    {playableSummary(
                      selectedEra,
                      caps.presets.find((preset) => preset.preset === selectedEra?.preset),
                      caps.source,
                    ) ?? t("launcher.availabilityChecked")}
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
                          {t("launcher.photoSource")}
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
                  {mode === "sandbox" ? t("launcher.enterSandbox") : t("launcher.enterMultiplayer")}{" "}
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
                    {choosingEra ? t("launcher.startNewGame") : t("launcher.newGame")}{" "}
                  <span aria-hidden="true">&#8594;</span>
                </button>
                {choosingEra && mode === "sp" && onQuickStart && (
                  <button
                    className="launcher-btn launcher-btn-secondary"
                    onClick={() => onQuickStart(eraId)}
                    disabled={continueBusy}
                    title={t("launcher.quickStartTitle")}
                  >
                    {t("launcher.quickStart")}
                  </button>
                )}
                {!choosingEra && (
                  <button
                    className="launcher-btn launcher-btn-secondary"
                    onClick={onLoad}
                    disabled={continueBusy}
                  >
                    {t("launcher.loadGame")}
                  </button>
                )}
                {latestWorld && !choosingEra && (
                  <button
                    className="launcher-btn launcher-btn-secondary launcher-btn-continue"
                    onClick={() => onContinue(latestWorld.slot)}
                    disabled={continueBusy}
                    aria-busy={continueBusy}
                    title={`${latestWorld.name}${latestWorld.turn != null ? ` · ${t("world.turn", { turn: latestWorld.turn })}` : ""}`}
                  >
                    <span>
                      {continueBusy
                        ? t("launcher.starting")
                        : latestRunning
                          ? t("launcher.resume")
                          : t("launcher.continue")}
                      <small>
                        {latestWorld.name}
                        {latestEra ? ` · ${latestEra.label}` : ""}
                        {latestWorld.turn != null
                          ? ` · ${t("world.turn", { turn: latestWorld.turn })}`
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
