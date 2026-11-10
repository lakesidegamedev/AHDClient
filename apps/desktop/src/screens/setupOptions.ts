import { legacyCapabilities, type Capabilities } from "../capabilities.js";

/** Values accepted by the singleplayer setup route. */
export type SetupMode = "normal" | "head-of-state" | "worldsim";
export type SetupDifficulty = "easy" | "normal" | "hard";
/**
 * Autonomy tiers the game's setup route accepts. Mirrors the game's own
 * `NppAutonomyLevel`. Three things move together whenever a tier is added — this
 * union, `defaultSetupOptions`, and the stored-preference regex below — because
 * a tier missing from any one of them is silently downgraded rather than
 * rejected, which reads to a player as the setting not sticking.
 */
export type SetupAutonomy = "off" | "v0" | "v1" | "v2" | "v3" | "v4" | "v5" | "v6";

export interface SetupOptions {
  mode: SetupMode;
  difficulty: SetupDifficulty;
  autonomyLevel: SetupAutonomy;
  featureFlags: Record<string, boolean>;
}

export const SETUP_OPTIONS_STORAGE_KEY = "ahdclient.lastSetup.v1";

export function defaultFeatureFlags(capabilities: Capabilities = legacyCapabilities()): Record<string, boolean> {
  return Object.fromEntries(capabilities.featureFlags.map((flag) => [flag.key, flag.defaultEnabled]));
}

/**
 * The default new world. Autonomy is v6 (NPP engine 6) for the legacy table; a
 * runtime that reports its own default wins. The live multiplayer world is
 * unaffected and stays on its own setting.
 */
export function defaultSetupOptions(capabilities: Capabilities = legacyCapabilities()): SetupOptions {
  return {
    mode: "normal",
    difficulty: "normal",
    autonomyLevel: capabilities.defaultAutonomyLevel as SetupAutonomy,
    featureFlags: defaultFeatureFlags(capabilities),
  };
}

/**
 * Keep only what the runtime knows. Unknown flags are dropped, missing flags
 * take the runtime default, and a mode, difficulty or autonomy tier the runtime
 * does not offer falls back to its default. Used for stored preferences and
 * again right before a world is created, so only known keys are ever sent.
 */
export function filterSetupToCapabilities(setup: SetupOptions, capabilities: Capabilities): SetupOptions {
  const fallback = defaultSetupOptions(capabilities);
  const featureFlags: Record<string, boolean> = { ...fallback.featureFlags };
  for (const flag of capabilities.featureFlags) {
    const value = setup.featureFlags[flag.key];
    if (typeof value === "boolean") featureFlags[flag.key] = value;
  }
  return {
    mode: capabilities.modes.includes(setup.mode) ? setup.mode : fallback.mode,
    difficulty: capabilities.difficulties.includes(setup.difficulty) ? setup.difficulty : fallback.difficulty,
    autonomyLevel: capabilities.autonomyLevels.includes(setup.autonomyLevel) ? setup.autonomyLevel : fallback.autonomyLevel,
    featureFlags,
  };
}

/** Read the last setup safely. Invalid or stale local storage falls back per field. */
export function readSetupOptions(capabilities: Capabilities = legacyCapabilities()): SetupOptions {
  const fallback = defaultSetupOptions(capabilities);
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SETUP_OPTIONS_STORAGE_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return fallback;
    const value = raw as Record<string, unknown>;
    const mode: SetupMode = value.mode === "normal" || value.mode === "head-of-state" || value.mode === "worldsim" ? value.mode : fallback.mode;
    const difficulty: SetupDifficulty = value.difficulty === "easy" || value.difficulty === "normal" || value.difficulty === "hard" ? value.difficulty : fallback.difficulty;
    const autonomyLevel: SetupAutonomy = value.autonomyLevel === "off" || /^v[0-6]$/.test(String(value.autonomyLevel)) ? value.autonomyLevel as SetupAutonomy : fallback.autonomyLevel;
    const flags = { ...fallback.featureFlags };
    if (value.featureFlags && typeof value.featureFlags === "object") {
      for (const option of capabilities.featureFlags) {
        const flag = (value.featureFlags as Record<string, unknown>)[option.key];
        if (typeof flag === "boolean") flags[option.key] = flag;
      }
    }
    return filterSetupToCapabilities({ mode, difficulty, autonomyLevel, featureFlags: flags }, capabilities);
  } catch {
    return fallback;
  }
}

export function writeSetupOptions(options: SetupOptions): void {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(SETUP_OPTIONS_STORAGE_KEY, JSON.stringify(options)); } catch { /* Storage is optional. */ }
}
