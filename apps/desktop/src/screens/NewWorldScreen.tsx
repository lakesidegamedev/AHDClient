import { useEffect, useMemo, useState } from "react";
import type { Era } from "../worlds.js";
import { themeForEra } from "../launcher/CommandGlobe.js";
import type { SetupAutonomy, SetupDifficulty, SetupMode, SetupOptions } from "./setupOptions.js";
import { filterSetupToCapabilities, readSetupOptions, writeSetupOptions } from "./setupOptions.js";
import { FEATURE_OPTIONS } from "./featureOptions.js";
import { legacyCapabilities, type Capabilities, type CapabilityFlag } from "../capabilities.js";
import type { ClientLanguage } from "../i18n.js";

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
 * Autonomy is WHAT the world's politicians do; difficulty is HOW WELL they do
 * it. Keeping the two descriptions honest matters more here than anywhere else
 * in the client, because this screen is the only place a player is told which
 * is which.
 */
const AUTONOMY_HELP =
  "What the world's politicians are allowed to do. Each step adds activities, not skill.";

/**
 * What each autonomy tier lets the world's politicians DO. Mirrors the game's
 * own `NppAutonomyLevel` doc (src/lib/db/types/gameState.ts): tiers add
 * activities, never skill. Skill is the separate difficulty axis below.
 */
const AUTONOMY_OPTIONS: readonly { value: SetupAutonomy; label: string; description: string }[] = [
  { value: "off", label: "Off", description: "Countries follow authored rules only. Nothing acts on its own." },
  { value: "v0", label: "V0", description: "Chair elections, stalled prime minister cover, bill sponsorship and voting, and international organization votes in non-player countries." },
  { value: "v1", label: "V1", description: "Adds the governing brain in non-player countries: agenda, executive action, cabinet, ministerial orders, fiscal moves, and opposition." },
  { value: "v2", label: "V2", description: "Brings the v1 governing brain into player countries and player-owned companies." },
  { value: "v3", label: "V3", description: "Politicians campaign, fundraise, run for and win office, legislate, and manage personal finances like players do." },
  { value: "v4", label: "V4", description: "Full political life in every country, with tighter bill sponsorship throttles where you play. This is what the live multiplayer world runs." },
  { value: "v5", label: "V5", description: "Governments hold long-term goals and follow through on them instead of re-deciding every cycle." },
  { value: "v6", label: "V6 (NPP engine 6)", description: "The same activities as the tier above, decided better: stronger candidates in winnable races, rallies, vote counting before bills, central banks that defend the currency, and votes shaped by business interests. No extra money or action points. See the NPP changelog." },
];

/** Tiers the live world has moved past. Still selectable, under disclosure. */
const OLD_AUTONOMY: readonly SetupAutonomy[] = ["off", "v0", "v1", "v2", "v3"];

/**
 * Difficulty changes two things and the copy says both. NPP skill is a decision
 * difference: how far ahead they plan, how many options they weigh, how readily
 * they change course. The resources line is a resource bonus and is labelled as
 * one, because calling a funding advantage "smarter AI" is a lie a player will
 * eventually catch.
 */
const DIFFICULTY_HELP =
  "How well the world's politicians play. This never changes what they are allowed to do.";

interface DifficultyOption {
  value: SetupDifficulty;
  label: string;
  description: string;
  /** How the world's politicians decide. A skill difference, never an entitlement. */
  skill: string;
  /** What the world's politicians are given. Always stated as a resource bonus. */
  resources: string;
}

/** Also the stored default, and the fallback for the description panel. */
const NORMAL_DIFFICULTY: DifficultyOption = {
  value: "normal",
  label: "Normal",
  description: "The intended balance for a first campaign.",
  skill: "Rivals play at the standard level.",
  resources: "Rivals receive the same action points and funding as you do.",
};

const DIFFICULTIES: readonly DifficultyOption[] = [
  {
    value: "easy",
    label: "Easy",
    description: "More forgiving conditions while you learn.",
    skill: "Rivals plan a shorter way ahead, weigh fewer options, and drop goals sooner.",
    resources: "Rivals also receive fewer action points and less funding than you do.",
  },
  NORMAL_DIFFICULTY,
  {
    value: "hard",
    label: "Hard",
    description: "Tighter conditions and less room for error.",
    skill:
      "Rivals plan further ahead, hold to their goals, pass on weak opportunities, keep money in reserve, and vote together more reliably.",
    resources: "Rivals also receive more action points and more funding than you do.",
  },
];

/** Configure a world. Character creation happens in the game after the server starts. */
export function NewWorldScreen({
  language = "en",
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
  const de = language === "de";
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
        {option.label}
        {option.value === "v6" && <span className="client-beta"> Recommended</span>}
      </strong>
      <small>{option.description}</small>
    </label>
  );
  const [featureFlags, setFeatureFlags] = useState<Record<string, boolean>>(savedSetup.featureFlags);
  const [localShareStatistics, setLocalShareStatistics] = useState(true);
  const duplicate = taken.some((existing) => existing.trim().toLowerCase() === name.trim().toLowerCase());
  const theme = themeForEra(era.id);
  const sharing = shareStatistics ?? localShareStatistics;
  const worldsim = mode === "worldsim";

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
            <span aria-hidden="true">&#8592;</span> {de ? "Zurück" : "Back"}
          </button>
          <h1 id="new-world-title">{de ? "Neue Welt" : "New world"} <span className="client-beta">Beta</span></h1>
        </header>

        <div className="launcher-console screen-console screen-setup-console">
          <div className="screen-era" style={{ borderColor: theme.phosphor }}>
            <span className="launcher-era-swatch" style={{ backgroundColor: theme.phosphor }} aria-hidden="true" />
            <div><span className="screen-era-kicker">{de ? "Gewähltes Zeitalter" : "Selected era"}</span><strong>{era.label}</strong><small>{era.subtitle} · {de ? "Beginn" : "begins"} {era.startDate}</small></div>
          </div>

          <label className="screen-field">
            <span>{de ? "Name der Welt" : "World name"}</span>
            <input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} autoFocus />
            {duplicate && <em>You already have a world with this name. It will get a numbered folder.</em>}
          </label>

          <section className="screen-setup-panel" aria-labelledby="campaign-options-title">
          <div className="screen-section-heading"><span>01</span><div><h2 id="campaign-options-title">{de ? "Deine Kampagne" : "Your campaign"}</h2><p>{de ? "Benenne die Welt und wähle deinen Einstieg." : "Name the world and choose how you enter it."}</p></div></div>
          <fieldset className="screen-choice-group">
            <legend>{de ? "Spielmodus" : "Play mode"}</legend>
            {hasMode("normal") && <label><input type="radio" name="play-mode" value="normal" checked={mode === "normal"} onChange={() => setMode("normal")} /> <strong>Normal</strong><small>Climb from citizen to power through a character in the world.</small></label>}
            {hasMode("head-of-state") && <label><input type="radio" name="play-mode" value="head-of-state" checked={mode === "head-of-state"} onChange={() => setMode("head-of-state")} /> <strong>Permanent head of state <span className="client-beta">Beta</span></strong><small>{presidentOnly ? "Start as President of the United States and stay in office. You do not play the normal climb." : "You enter as head of state and remain head of state. You do not play the normal climb."}</small></label>}
            {hasMode("worldsim") && <label><input type="radio" name="play-mode" value="worldsim" checked={worldsim} onChange={() => setMode("worldsim")} /> <strong>Worldsim <span className="client-beta">Beta</span></strong><small>Simulate the world without creating a character.</small></label>}
          </fieldset>
          </section>

          {/* The help text sits OUTSIDE the label: inside it, it becomes part of
              the select's accessible name, so "Difficulty" would no longer
              address the control for a screen reader or a test. */}
          <section className="screen-setup-panel" aria-labelledby="simulation-options-title">
          <div className="screen-section-heading"><span>02</span><div><h2 id="simulation-options-title">Simulation</h2><p>{de ? "Lege Schwierigkeit und politische Autonomie fest." : "Set the challenge and political autonomy."}</p></div></div>
          <div className="screen-field-group">
            <label className="screen-field"><span>Difficulty</span><select value={difficulty} onChange={(event) => setDifficulty(event.target.value as SetupDifficulty)}>{difficultyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <small>{DIFFICULTY_HELP}</small>
            <small>{selectedDifficulty.description}</small>
            <small>{selectedDifficulty.skill}</small>
            <small>{selectedDifficulty.resources}</small>
          </div>
          <fieldset className="screen-choice-group">
            <legend>Autonomy</legend>
            <small>{AUTONOMY_HELP}</small>
            {autonomyOptions.filter((option) => !OLD_AUTONOMY.includes(option.value)).map(autonomyControl)}
            {autonomyOptions.some((option) => OLD_AUTONOMY.includes(option.value)) && (
              <details>
                <summary>Older autonomy tiers</summary>
                {autonomyOptions.filter((option) => OLD_AUTONOMY.includes(option.value)).map(autonomyControl)}
              </details>
            )}
          </fieldset>
          </section>

          <section className="screen-features screen-setup-panel" aria-labelledby="feature-settings-title">
            <div className="screen-section-heading"><span>03</span><div><h2 id="feature-settings-title">World systems</h2><p>Fine-tune the mechanics active in this save.</p></div></div>
            {featureGroups.filter((category) => visibleFeatures(category).length > 0).map((category) => (
              <fieldset key={category} className="screen-feature-group">
                <legend>{category}</legend>
                {visibleFeatures(category).map(featureControl)}
              </fieldset>
            ))}
            {worldsim && (
              <small>Onboarding checklist is hidden here: Worldsim has no player to onboard. It stays as stored.</small>
            )}
            {advancedFeatures.length > 0 && (
              <details>
                <summary>Advanced world settings</summary>
                <div className="screen-feature-list">{advancedFeatures.map(featureControl)}</div>
              </details>
            )}
          </section>

          <label className="screen-consent">
            <input type="checkbox" checked={sharing} onChange={(event) => changeStatistics(event.target.checked)} />
            <span><strong>Share anonymous setup statistics</strong><small>Help improve balance with anonymous, aggregate data. You can opt out at any time.</small></span>
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
                  Link account
                </button>
              )}
            </p>
          )}
          <div className="screen-launch-bar">
            <p className="launcher-caption">{worldsim ? "This mode opens the world simulator after setup and does not create a character." : "Character creation happens in the game after the world starts."}{caps.source === "legacy" && <small>Seeds thirty countries · about one minute</small>}</p>
            <div className="launcher-actions">
              <button className="launcher-btn launcher-btn-primary" onClick={() => onCreate(name, "", filterSetupToCapabilities({ mode, difficulty, autonomyLevel, featureFlags }, caps))} disabled={!name.trim()}>Create and play <span aria-hidden="true">&#8594;</span></button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
