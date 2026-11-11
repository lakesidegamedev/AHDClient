import { useEffect, useMemo, useState } from "react";
import type { Era } from "../worlds.js";
import { themeForEra } from "../launcher/CommandGlobe.js";
import type { SetupAutonomy, SetupDifficulty, SetupMode, SetupOptions } from "./setupOptions.js";
import { filterSetupToCapabilities, readSetupOptions, writeSetupOptions } from "./setupOptions.js";
import { FEATURE_OPTIONS } from "./featureOptions.js";
import { legacyCapabilities, type Capabilities, type CapabilityFlag } from "../capabilities.js";
import { translate, useLanguage, type ClientLanguage, type TranslationKey, type TranslationVars } from "../i18n.js";

export type { SetupOptions } from "./setupOptions.js";

interface Props {
  language?: ClientLanguage;
  era: Era;
  /** What the game runtime supports. Absent means the older client-side table. */
  capabilities?: Capabilities | undefined;
  taken: readonly string[];
  onBack: () => void;
  /** The third argument is optional for existing callers while they migrate. */
  onCreate: (name: string, displayName: string, setup: SetupOptions) => void;
  /** Opens this screen in the simulation mode, which does not create a character. */
  initialWorldsim?: boolean;
  /** Controlled anonymous statistics consent, when the parent has settings available. */
  shareStatistics?: boolean;
  onStatisticsChange?: (share: boolean) => void;
  /** Entitlement refusal: shown above the form, which stays intact. */
  error?: string | null;
  /** Explicit link CTA next to the refusal. Absent when already linked. */
  onLinkAccount?: (() => void) | undefined;
}

/**
 * Autonomy is WHAT the computer-run politicians do; difficulty is HOW WELL they
 * do it. Keeping the two descriptions honest matters more here than anywhere
 * else in the client, because this screen is the only place a player is told
 * which is which.
 */
const AUTONOMY_OPTIONS: readonly { value: SetupAutonomy; label: TranslationKey; description: TranslationKey }[] = [
  { value: "off", label: "autonomy.off", description: "autonomy.off.text" },
  { value: "v0", label: "autonomy.v0", description: "autonomy.v0.text" },
  { value: "v1", label: "autonomy.v1", description: "autonomy.v1.text" },
  { value: "v2", label: "autonomy.v2", description: "autonomy.v2.text" },
  { value: "v3", label: "autonomy.v3", description: "autonomy.v3.text" },
  { value: "v4", label: "autonomy.v4", description: "autonomy.v4.text" },
  { value: "v5", label: "autonomy.v5", description: "autonomy.v5.text" },
  { value: "v6", label: "autonomy.v6", description: "autonomy.v6.text" },
];

/** Tiers the live world has moved past. Still selectable, under disclosure. */
const OLD_AUTONOMY: readonly SetupAutonomy[] = ["off", "v0", "v1", "v2", "v3"];

/**
 * Difficulty changes two things and the copy says both. Skill is a decision
 * difference: how far ahead rivals plan, how many options they weigh, how
 * readily they change course. The resources line is a resource bonus and is
 * labelled as one, because calling a funding advantage "smarter AI" is a lie a
 * player will eventually catch.
 */
interface DifficultyOption {
  value: SetupDifficulty;
  label: TranslationKey;
  description: TranslationKey;
  /** How the computer-run politicians decide. A skill difference, never an entitlement. */
  skill: TranslationKey;
  /** What they are given. Always stated as a resource bonus. */
  resources: TranslationKey;
}

/** Also the stored default, and the fallback for the description panel. */
const NORMAL_DIFFICULTY: DifficultyOption = {
  value: "normal",
  label: "difficulty.normal",
  description: "difficulty.normal.text",
  skill: "difficulty.normal.skill",
  resources: "difficulty.normal.resources",
};

const DIFFICULTIES: readonly DifficultyOption[] = [
  {
    value: "easy",
    label: "difficulty.easy",
    description: "difficulty.easy.text",
    skill: "difficulty.easy.skill",
    resources: "difficulty.easy.resources",
  },
  NORMAL_DIFFICULTY,
  {
    value: "hard",
    label: "difficulty.hard",
    description: "difficulty.hard.text",
    skill: "difficulty.hard.skill",
    resources: "difficulty.hard.resources",
  },
];

const FEATURE_GROUP_LABELS: Record<string, TranslationKey> = {
  "World systems": "newWorld.groupWorld",
  Politics: "newWorld.groupPolitics",
  Economy: "newWorld.groupEconomy",
  "Player systems": "newWorld.groupPlayer",
  "More settings": "newWorld.groupMore",
};

/** Configure a world. Character creation happens in the game after the server starts. */
export function NewWorldScreen({
  language,
  era,
  capabilities,
  taken,
  onBack,
  onCreate,
  initialWorldsim = false,
  shareStatistics,
  onStatisticsChange,
  error = null,
  onLinkAccount,
}: Props): JSX.Element {
  const contextLanguage = useLanguage();
  const activeLanguage = language ?? contextLanguage;
  const t = (key: TranslationKey, vars?: TranslationVars) => translate(activeLanguage, key, vars);
  const [name, setName] = useState(`${era.subtitle}, ${era.label}`);
  const caps = useMemo(() => capabilities ?? legacyCapabilities(), [capabilities]);
  const [savedSetup] = useState(() => readSetupOptions(caps));
  /**
   * A stored "worldsim" is a leftover from the Worldsim tab, not a choice for
   * this screen: singleplayer setup opens on Normal unless Worldsim asked for
   * it, and the writeback below then repairs the stored value too.
   */
  const [mode, setMode] = useState<SetupMode>(
    initialWorldsim ? "worldsim" : savedSetup.mode === "worldsim" ? "normal" : savedSetup.mode,
  );
  const [difficulty, setDifficulty] = useState<SetupDifficulty>(savedSetup.difficulty);
  const [autonomyLevel, setAutonomyLevel] = useState<SetupAutonomy>(savedSetup.autonomyLevel);
  const selectedDifficulty: DifficultyOption =
    DIFFICULTIES.find((option) => option.value === difficulty) ?? NORMAL_DIFFICULTY;
  const autonomyOptions = AUTONOMY_OPTIONS.filter((option) => caps.autonomyLevels.includes(option.value));
  const difficultyOptions = DIFFICULTIES.filter((option) => caps.difficulties.includes(option.value));
  const hasMode = (value: SetupMode) => caps.modes.includes(value);
  const eraPreset = caps.presets.find((preset) => preset.preset === era.preset);
  const presidentOnly = caps.source === "manifest" && eraPreset?.playerCountries.length === 1 && eraPreset.playerCountries[0]!.name === "United States";
  const autonomyControl = (option: (typeof AUTONOMY_OPTIONS)[number]) => (
    <label key={option.value}>
      <input
        type="radio"
        name="autonomy"
        value={option.value}
        checked={autonomyLevel === option.value}
        onChange={() => setAutonomyLevel(option.value)}
      />{" "}
      <strong>
        {t(option.label)}
        {option.value === "v6" && <span className="client-beta"> {t("newWorld.recommended")}</span>}
      </strong>
      <small>{t(option.description)}</small>
    </label>
  );
  const [featureFlags, setFeatureFlags] = useState<Record<string, boolean>>(savedSetup.featureFlags);
  const [localShareStatistics, setLocalShareStatistics] = useState(true);
  const duplicate = taken.some((existing) => existing.trim().toLowerCase() === name.trim().toLowerCase());
  const theme = themeForEra(era.id);
  const sharing = shareStatistics ?? localShareStatistics;
  const worldsim = mode === "worldsim";
  // The country count comes from the runtime's own era data. An older runtime lists only playable nations, so it gets no number.
  const seededCountries = eraPreset ? eraPreset.playerCountries.length + eraPreset.computerCountries.length + eraPreset.backgroundCountries.length : 0;
  const setupNote = caps.source === "manifest" && eraPreset && seededCountries > eraPreset.playerCountries.length
    ? t("newWorld.seedsCountries", { n: seededCountries })
    : caps.source === "legacy" ? t("newWorld.seedsWorld") : "";

  useEffect(() => {
    writeSetupOptions({ mode, difficulty, autonomyLevel, featureFlags });
  }, [mode, difficulty, autonomyLevel, featureFlags]);

  const changeStatistics = (next: boolean) => {
    setLocalShareStatistics(next);
    onStatisticsChange?.(next);
  };

  const featureGroups = ["World systems", "Politics", "Economy", "Player systems", "More settings"] as const;
  const categoryOf = (flag: CapabilityFlag): string =>
    FEATURE_OPTIONS.find((option) => option.key === flag.key)?.category ?? "More settings";
  /**
   * The onboarding checklist is player UI: with no character in Worldsim it
   * has nothing to attach to. Hidden in that mode with a note, but still
   * sent as stored, so switching modes never silently flips a real setting.
   * Every other flag drives the shared turn loop and applies to Worldsim too.
   */
  const visibleFeatures = (category: (typeof featureGroups)[number]) =>
    caps.featureFlags.filter(
      (option) =>
        categoryOf(option) === category &&
        !(worldsim && option.key === "onboardingChecklistEnabled"),
    );
  const advancedFeatures = caps.featureFlags.filter((option) => categoryOf(option) === "Advanced world settings");
  const featureControl = (option: CapabilityFlag) => (
    <label className="screen-feature" key={option.key}>
      <input
        type="checkbox"
        checked={featureFlags[option.key] ?? option.defaultEnabled}
        onChange={(event) => setFeatureFlags((current) => ({ ...current, [option.key]: event.target.checked }))}
      />
      <span><strong>{option.label}</strong><small>{option.description}</small></span>
    </label>
  );

  return (
    <main className="launcher-scope screen-scope">
      <div className="launcher-pattern" aria-hidden="true"><div className="launcher-nebula" /></div>
      <section className="launcher-stage screen-stage" aria-labelledby="new-world-title">
        <header className="screen-head">
          <button className="launcher-btn launcher-btn-secondary screen-back" onClick={onBack}>
            <span aria-hidden="true">&#8592;</span> {t("common.back")}
          </button>
          <h1 id="new-world-title">{t("newWorld.title")} <span className="client-beta">Beta</span></h1>
        </header>

        <div className="launcher-console screen-console screen-setup-console">
          <div className="screen-era" style={{ borderColor: theme.phosphor }}>
            <span className="launcher-era-swatch" style={{ backgroundColor: theme.phosphor }} aria-hidden="true" />
            <div><span className="screen-era-kicker">{t("newWorld.selectedEra")}</span><strong>{era.label}</strong><small>{era.subtitle} · {t("newWorld.begins")} {era.startDate}</small></div>
          </div>

          <label className="screen-field">
            <span>{t("newWorld.worldName")}</span>
            <input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} autoFocus />
            {duplicate && <em>{t("newWorld.duplicate")}</em>}
          </label>

          <section className="screen-setup-panel" aria-labelledby="campaign-options-title">
          <div className="screen-section-heading"><span>01</span><div><h2 id="campaign-options-title">{t("newWorld.campaign")}</h2><p>{t("newWorld.campaignHelp")}</p></div></div>
          <fieldset className="screen-choice-group">
            <legend>{t("launcher.playMode")}</legend>
            {hasMode("normal") && <label><input type="radio" name="play-mode" value="normal" checked={mode === "normal"} onChange={() => setMode("normal")} /> <strong>{t("newWorld.modeNormal")}</strong><small>{t("newWorld.modeNormalText")}</small></label>}
            {hasMode("head-of-state") && <label><input type="radio" name="play-mode" value="head-of-state" checked={mode === "head-of-state"} onChange={() => setMode("head-of-state")} /> <strong>{t("newWorld.modeHead")} <span className="client-beta">Beta</span></strong><small>{presidentOnly ? t("newWorld.modeHeadUs") : t("newWorld.modeHeadText")}</small></label>}
            {hasMode("worldsim") && <label><input type="radio" name="play-mode" value="worldsim" checked={worldsim} onChange={() => setMode("worldsim")} /> <strong>{t("launcher.worldsim")} <span className="client-beta">Beta</span></strong><small>{t("newWorld.modeWorldsimText")}</small></label>}
          </fieldset>
          </section>

          {/* The help text sits OUTSIDE the label: inside it, it becomes part of
              the select's accessible name, so "Difficulty" would no longer
              address the control for a screen reader or a test. */}
          <section className="screen-setup-panel" aria-labelledby="simulation-options-title">
          <div className="screen-section-heading"><span>02</span><div><h2 id="simulation-options-title">{t("newWorld.simulation")}</h2><p>{t("newWorld.simulationHelp")}</p></div></div>
          <div className="screen-field-group">
            <label className="screen-field"><span>{t("newWorld.difficulty")}</span><select value={difficulty} onChange={(event) => setDifficulty(event.target.value as SetupDifficulty)}>{difficultyOptions.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}</select></label>
            <small>{t("newWorld.difficultyHelp")}</small>
            <small>{t(selectedDifficulty.description)}</small>
            <small>{t(selectedDifficulty.skill)}</small>
            <small>{t(selectedDifficulty.resources)}</small>
          </div>
          <fieldset className="screen-choice-group">
            <legend>{t("newWorld.autonomy")}</legend>
            <small>{t("newWorld.autonomyDefine")}</small>
            <small>{t("newWorld.autonomyHelp")}</small>
            {autonomyOptions.filter((option) => !OLD_AUTONOMY.includes(option.value)).map(autonomyControl)}
            {autonomyOptions.some((option) => OLD_AUTONOMY.includes(option.value)) && (
              <details>
                <summary>{t("newWorld.olderAutonomy")}</summary>
                {autonomyOptions.filter((option) => OLD_AUTONOMY.includes(option.value)).map(autonomyControl)}
              </details>
            )}
          </fieldset>
          </section>

          <section className="screen-features screen-setup-panel" aria-labelledby="feature-settings-title">
            <div className="screen-section-heading"><span>03</span><div><h2 id="feature-settings-title">{t("newWorld.groupWorld")}</h2><p>{t("newWorld.featuresHelp")}</p></div></div>
            {featureGroups.filter((category) => visibleFeatures(category).length > 0).map((category) => (
              <fieldset key={category} className="screen-feature-group">
                <legend>{t(FEATURE_GROUP_LABELS[category] ?? "newWorld.groupMore")}</legend>
                {visibleFeatures(category).map(featureControl)}
              </fieldset>
            ))}
            {worldsim && (
              <small>{t("newWorld.onboardingHidden")}</small>
            )}
            {advancedFeatures.length > 0 && (
              <details>
                <summary>{t("newWorld.advanced")}</summary>
                <div className="screen-feature-list">{advancedFeatures.map(featureControl)}</div>
              </details>
            )}
          </section>

          <label className="screen-consent">
            <input type="checkbox" checked={sharing} onChange={(event) => changeStatistics(event.target.checked)} />
            <span><strong>{t("newWorld.shareStats")}</strong><small>{t("newWorld.shareStatsText")}</small></span>
          </label>

          {error && (
            <p className="launcher-error" role="alert">
              <span>{error}</span>
              {onLinkAccount && (
                <button
                  className="launcher-btn launcher-btn-primary"
                  type="button"
                  onClick={onLinkAccount}
                >
                  {t("common.linkAccount")}
                </button>
              )}
            </p>
          )}
          <div className="screen-launch-bar">
            <p className="launcher-caption">{worldsim ? t("newWorld.launchWorldsim") : t("newWorld.launchNormal")}{setupNote && <small>{setupNote}</small>}</p>
            <div className="launcher-actions">
              <button className="launcher-btn launcher-btn-primary" onClick={() => onCreate(name, "", filterSetupToCapabilities({ mode, difficulty, autonomyLevel, featureFlags }, caps))} disabled={!name.trim()}>{t("newWorld.create")} <span aria-hidden="true">&#8594;</span></button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
