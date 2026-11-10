import { invoke } from "@tauri-apps/api/core";
import { ERAS } from "./worlds.js";
import { FEATURE_OPTIONS } from "./screens/featureOptions.js";

/** The manifest schema this client understands. */
export const SUPPORTED_SCHEMA_VERSION = 1;

export interface CapabilityCountry {
  id: string;
  name: string;
}

export interface CapabilityPreset {
  preset: string;
  era: string;
  /** False when the runtime cannot build this world (for example a rebuilt era). */
  seedable: boolean;
  playerCountries: CapabilityCountry[];
  computerCountries: CapabilityCountry[];
  backgroundCountries: CapabilityCountry[];
}

export interface CapabilityFlag {
  key: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
}

export type CapabilitySource = "manifest" | "legacy";

export interface Capabilities {
  source: CapabilitySource;
  gameVersion: string | null;
  rulesVersion: string | null;
  defaultPreset: string;
  presets: CapabilityPreset[];
  modes: string[];
  difficulties: string[];
  autonomyLevels: string[];
  defaultAutonomyLevel: string;
  featureFlags: CapabilityFlag[];
  /** Why a manifest was ignored, when it was. For the diagnostics report only. */
  diagnostic: string | null;
}

/**
 * The older style: runtimes that ship no manifest. Built from the client's own
 * era table and feature list, so behaviour for them is unchanged.
 */
export function legacyCapabilities(diagnostic: string | null = null): Capabilities {
  return {
    source: "legacy",
    gameVersion: null,
    rulesVersion: null,
    defaultPreset: ERAS[0]?.preset ?? "",
    presets: ERAS.map((era) => ({
      preset: era.preset,
      era: era.id,
      seedable: true,
      playerCountries: (era.playableNations ?? []).map((name) => ({ id: name, name })),
      computerCountries: [],
      backgroundCountries: [],
    })),
    modes: ["normal", "head-of-state", "worldsim"],
    difficulties: ["easy", "normal", "hard"],
    autonomyLevels: ["off", "v0", "v1", "v2", "v3", "v4", "v5", "v6"],
    defaultAutonomyLevel: "v6",
    featureFlags: FEATURE_OPTIONS.map((option) => ({
      key: option.key,
      label: option.label,
      description: option.description,
      defaultEnabled: option.defaultValue,
    })),
    diagnostic,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;

function countries(value: unknown): CapabilityCountry[] | null {
  if (!Array.isArray(value)) return null;
  const out: CapabilityCountry[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string") return null;
    out.push({ id: item.id, name: item.name });
  }
  return out;
}

function parseManifest(raw: Record<string, unknown>): Capabilities | null {
  const modes = strings(raw.modes);
  const difficulties = strings(raw.difficulties);
  const autonomyLevels = strings(raw.autonomyLevels);
  if (!modes || !difficulties || !autonomyLevels) return null;
  if (typeof raw.defaultPreset !== "string" || typeof raw.defaultAutonomyLevel !== "string") return null;
  if (!Array.isArray(raw.presets) || !Array.isArray(raw.featureFlags)) return null;

  const presets: CapabilityPreset[] = [];
  for (const item of raw.presets) {
    if (!isRecord(item) || typeof item.preset !== "string" || typeof item.era !== "string") return null;
    const player = countries(item.playerCountries);
    const computer = countries(item.computerCountries);
    const background = countries(item.backgroundCountries);
    if (!player || !computer || !background) return null;
    presets.push({
      preset: item.preset,
      era: item.era,
      seedable: item.seedable === true,
      playerCountries: player,
      computerCountries: computer,
      backgroundCountries: background,
    });
  }

  const featureFlags: CapabilityFlag[] = [];
  for (const item of raw.featureFlags) {
    if (!isRecord(item) || typeof item.key !== "string" || typeof item.label !== "string") return null;
    featureFlags.push({
      key: item.key,
      label: item.label,
      description: typeof item.description === "string" ? item.description : "",
      defaultEnabled: item.defaultEnabled === true,
    });
  }

  return {
    source: "manifest",
    gameVersion: typeof raw.gameVersion === "string" ? raw.gameVersion : null,
    rulesVersion: typeof raw.rulesVersion === "string" ? raw.rulesVersion : null,
    defaultPreset: raw.defaultPreset,
    presets,
    modes,
    difficulties,
    autonomyLevels,
    defaultAutonomyLevel: raw.defaultAutonomyLevel,
    featureFlags,
    diagnostic: null,
  };
}

/**
 * Turn what the runtime reported into something the screens can use. A missing
 * manifest gives the legacy table quietly. A manifest this client cannot read
 * (unknown schema, malformed) also gives the legacy table, with a diagnostic.
 */
export function resolveCapabilities(manifest: unknown): Capabilities {
  if (manifest === null || manifest === undefined) return legacyCapabilities();
  if (!isRecord(manifest)) return legacyCapabilities("capabilities manifest is not an object");
  if (manifest.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return legacyCapabilities(`unsupported capabilities schema ${String(manifest.schemaVersion)}`);
  }
  return parseManifest(manifest) ?? legacyCapabilities("capabilities manifest is malformed");
}

export interface BundledGameInfo {
  gameVersion: string | null;
  gameCommit: string | null;
  clientVersion: string | null;
}

export const gameRuntime = {
  capabilities: async (): Promise<Capabilities> => {
    try {
      return resolveCapabilities(await invoke<unknown>("game_capabilities"));
    } catch {
      return legacyCapabilities("could not read the capabilities manifest");
    }
  },
  bundledInfo: () => invoke<BundledGameInfo>("bundled_game_info"),
};
