import { invoke } from "@tauri-apps/api/core";
import type { SetupOptions } from "./screens/setupOptions.js";

/**
 * A world is a directory under the app's data folder holding a MongoDB data
 * directory, the mirrored art and a small metadata file. The Rust side owns
 * the directory; this module is the typed edge of those commands.
 */
export interface WorldMeta {
  slot: string;
  name: string;
  preset: string;
  createdAt: string;
  lastPlayedAt: string;
  turn: number | null;
  character: string | null;
  setup?: SetupOptions | null;
  /** Game version this world last ran on. Absent on worlds made before 2.11. */
  gameVersion?: string | null;
  /** Pre-1.20 world: always opens on the Classic game, never upgraded. */
  classic?: boolean;
}

export type SaveKind = "manual" | "auto" | "safety";

/** One entry of a world's save list, as the game wrote it. */
export interface SaveMeta {
  id: string;
  kind: SaveKind;
  name: string;
  turn: number | null;
  preset: string | null;
  mode: string | null;
  characterName: string | null;
  createdAt: string;
  sizeBytes: number;
}

export interface SavesOverview {
  saves: SaveMeta[];
  settings: { autosaveEvery: number };
  /** Plain-words reason the last autosave failed, or null. */
  autosaveError: string | null;
  /** What happened the last time a save was loaded into this world. */
  lastLoad: { at: string; ok: boolean; message: string; saveName?: string } | null;
}

export interface GameInfo {
  running: boolean;
  hosted: boolean;
  port: number | null;
  slot: string | null;
  url: string | null;
}

export interface LinkedAccount {
  linked: boolean;
  displayName: string;
  supporter: boolean;
  /** Player picture from the game account API (`avatarUrl`, shipped by the game). */
  avatarUrl?: string | null;
  singleplayer: { entitled: boolean; expiresAt: string | null };
}

export interface GameVersion {
  version: string;
  installed: boolean;
  selected: boolean;
  /** Download size in bytes for this computer, when known. */
  sizeBytes?: number | null;
}

export const gameVersions = {
  list: () => invoke<GameVersion[]>("list_game_versions"),
  install: (version: string) =>
    invoke<void>("install_game_version", { version }),
  select: (version: string | null) =>
    invoke<void>("select_game_version", { version }),
};

/** The Classic game: the last release before 1.20, kept for older worlds and eras. */
export interface ClassicInfo {
  /** Version to use or download. Null when none is installed or published. */
  version: string | null;
  installed: boolean;
  sizeBytes: number | null;
}

/** Marks the error the game returns when a Classic world needs the download first. */
export const CLASSIC_REQUIRED = "classic-required:";

export const classicGame = {
  info: () => invoke<ClassicInfo>("classic_game_info"),
  install: (version: string) => invoke<void>("install_game_version", { version }),
  cancel: () => invoke<void>("cancel_game_download"),
};

/** What the game reports about a world once its server is up. */
export interface SingleplayerStatus {
  hasWorld: boolean;
  mode?: "normal" | "head-of-state" | "worldsim" | null;
  turn: number | null;
  preset: string | null;
  hasCharacter: boolean;
  characterName: string | null;
}

export interface SetupProgress {
  active: boolean;
  phase: string;
  label: string;
  detail: string;
  progress: number;
  updatedAt: string;
  stalled: boolean;
}

export interface Era {
  /** Year, which is also the key CommandGlobe themes by. */
  id: string;
  /** The AHDGame reset preset that builds this world. */
  preset: string;
  label: string;
  subtitle: string;
  startDate: string;
  description?: string;
  playableNations?: readonly string[];
}

/** Every era the game can seed, oldest first. Mirrors AHDGame's presets. */
export const ERAS: readonly Era[] = [
  {
    description:
      "The Cold War hardens after Stalin. Compete for power in a world divided between rival blocs.",
    playableNations: [
      "United States",
      "United Kingdom",
      "Soviet Union",
      "East Germany",
    ],
    id: "1953",
    preset: "1953-default",
    label: "1953",
    subtitle: "Cold War dawn",
    startDate: "January 1953",
  },
  {
    description:
      "Oil shocks, revolution and renewed Cold War tensions challenge the postwar settlement.",
    playableNations: [
      "United States",
      "United Kingdom",
      "Soviet Union",
      "East Germany",
    ],
    id: "1979",
    preset: "1979-default",
    label: "1979",
    subtitle: "Late Cold War",
    startDate: "January 1979",
  },
  {
    description:
      "The Cold War order unravels. Shape the political choices of a new international era.",
    playableNations: ["United States", "United Kingdom"],
    id: "1991",
    preset: "1991-default",
    label: "1991",
    subtitle: "New world order",
    startDate: "January 1991",
  },
  {
    description:
      "Globalisation accelerates as the internet boom and a new European currency reshape politics.",
    playableNations: ["United States", "United Kingdom"],
    id: "1999",
    preset: "1999-default",
    label: "1999",
    subtitle: "Peak globalisation",
    startDate: "January 1999",
  },
  {
    description:
      "Credit and confidence run high on the eve of the global financial crisis.",
    playableNations: ["United States", "United Kingdom"],
    id: "2007",
    preset: "2007-default",
    label: "2007",
    subtitle: "Before the crash",
    startDate: "January 2007",
  },
  {
    description:
      "Polarisation, shifting alliances and contested institutions define an interconnected world.",
    playableNations: [
      "United States",
      "United Kingdom",
      "Germany",
      "Japan",
      "Ireland",
      "China",
    ],
    id: "2019",
    preset: "2019-default",
    label: "2019",
    subtitle: "Contemporary politics",
    startDate: "January 2019",
  },
  {
    description:
      "Inflation, war and renewed great-power competition put governments under pressure.",
    playableNations: [
      "United States",
      "United Kingdom",
      "Japan",
      "Germany",
      "Ireland",
      "China",
    ],
    id: "2023",
    preset: "2023-default",
    label: "2023",
    subtitle: "Realignment",
    startDate: "January 2023",
  },
  {
    description:
      "Inflation is cooling but has not broken. AI, European security and a contested world order reshape the next mandate.",
    playableNations: [
      "United States",
      "United Kingdom",
      "Japan",
      "Germany",
      "China",
    ],
    id: "2027",
    preset: "2027-default",
    label: "2027",
    subtitle: "The next mandate",
    startDate: "January 2027",
  },
];

export function eraById(id: string): Era | undefined {
  return ERAS.find((era) => era.id === id);
}

export function eraForPreset(
  preset: string | null | undefined,
): Era | undefined {
  return ERAS.find((era) => era.preset === preset);
}

/**
 * Directory-safe slot from a display name, unique among the slots taken.
 * "Cold War, 1953" becomes "cold-war-1953", then "cold-war-1953-2" if needed.
 */
/** A world name not already used: "1953", then "1953 2", "1953 3". */
export function uniqueWorldName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.trim().toLowerCase()));
  if (!used.has(base.trim().toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

export function slugForWorld(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "world";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

export const worlds = {
  list: () => invoke<WorldMeta[]>("list_worlds"),
  create: (slot: string, name: string, preset: string, setup?: SetupOptions, classic = false) =>
    invoke<WorldMeta>("create_world", {
      slot,
      name,
      preset,
      setup: setup ?? null,
      classic,
    }),
  touch: (slot: string, turn?: number | null, character?: string | null) =>
    invoke<WorldMeta>("touch_world", {
      slot,
      turn: turn ?? null,
      character: character ?? null,
    }),
  remove: (slot: string) => invoke<void>("delete_world", { slot }),
  rename: (slot: string, name: string) => invoke<WorldMeta>("rename_world", { slot, name }),
  sizes: () => invoke<{ slot: string; sizeBytes: number }[]>("world_sizes"),
  /** Path written, or null when the player closed the file dialog. */
  exportTo: (slot: string, title: string) => invoke<string | null>("export_world", { slot, title }),
  /** The new world, or null when the player closed the file dialog. */
  importFrom: (title: string) => invoke<WorldMeta | null>("import_world", { title }),
  /** How many autosaves were removed. */
  tidyAutosaves: (slot: string, keep: number) => invoke<number>("delete_old_autosaves", { slot, keep }),
};

/** Autosaves kept when the player clears old ones. */
export const AUTOSAVES_KEPT = 3;

/**
 * Saves read from disk, so they work with the world stopped. Creating a save
 * needs the running game (`game.saveNow`); loading one stops the world,
 * queues the load here and starts the world again.
 */
export const worldSaves = {
  list: (slot: string) => invoke<SaveMeta[]>("list_world_saves", { slot }),
  remove: (slot: string, id: string) =>
    invoke<void>("delete_world_save", { slot, id }),
  requestLoad: (slot: string, id: string) =>
    invoke<SaveMeta>("request_world_save_load", { slot, id }),
};

/** Why a multi-turn advance ended early. Absent when every requested turn ran. */
export interface BatchStop {
  kind: "character" | "office" | "election" | "vote" | "crisis" | "offer" | "error" | "requested";
  message: string;
  turn: number | null;
  details: string[];
}

export interface BatchDigest {
  startTurn: number | null;
  endTurn: number | null;
  turnsPlayed: number;
  funds: { before: number; after: number; delta: number };
  actions: { before: number; after: number; delta: number };
  office: { before: string | null; after: string | null };
  officesWon: string[];
  officesLost: string[];
  inbox: {
    total: number;
    actionRequired: number;
    groups: Array<{ category: string; count: number; actionRequired: number; titles: string[] }>;
  };
  worldEvents: Array<{ turn: number; title: string }>;
  warnings: string[];
}

/** Progress and result of a multi-turn advance, as the game reports it. */
export interface TurnBatch {
  id: string;
  status: "running" | "finished";
  requested: number;
  completed: number;
  runningTurn: number | null;
  startTurn: number | null;
  stopRequested: boolean;
  /** One entry per turn the batch has committed so far. */
  turns: Array<{ turn: number; fundsDelta: number; actionsDelta: number; durationSeconds: number }>;
  stop: BatchStop | null;
  digest: BatchDigest | null;
}

export const game = {
  start: (slot: string, hosted = false) =>
    invoke<GameInfo>("game_start", { slot, hosted }),
  /** `quit` closes the app once the world has stopped (the window close path). */
  stop: (quit = false) => (quit ? invoke<GameInfo>("game_stop", { quit: true }) : invoke<GameInfo>("game_stop")),
  status: () => invoke<GameInfo>("game_status"),
  request: <T>(method: string, path: string, body?: unknown) =>
    invoke<T>("game_request", { method, path, body: body ?? null }),
  openWindow: (path = "/", separateWindow = false) =>
    invoke<void>("open_game_window", { path, separateWindow }),
  closeEmbedded: () => invoke<void>("close_embedded_game"),
  /**
   * Reload the local game view on its current path (funds, map, country and
   * briefing pages pick up the latest turn). Scoped in Rust to the running
   * game's own loopback origin+port; multiplayer views are never touched.
   * Resolves with the refreshed path.
   */
  refreshView: () => invoke<string>("refresh_game_view"),
  /**
   * Hide the embedded child webviews (which sit above launcher DOM dialogs)
   * or show them again. Views are never closed or navigated, so the child
   * keeps its current path and session. No-op without embedded views.
   */
  setEmbeddedVisible: (visible: boolean) =>
    invoke<void>("set_embedded_visible", { visible }),
  singleplayerStatus: () =>
    game.request<SingleplayerStatus>("GET", "/api/singleplayer/status"),
  setup: (preset: string, setup: SetupOptions, displayName?: string) =>
    game.request<{ ok: boolean }>("POST", "/api/singleplayer/setup", {
      preset,
      ...setup,
      ...(displayName ? { displayName } : {}),
    }),
  setupProgress: () =>
    game.request<SetupProgress>("GET", "/api/singleplayer/setup/progress"),
  advanceTurn: () =>
    game.request<{ success: boolean; turn: number; message: string; briefing?: { fundsDelta: number; actionsDelta: number } }>(
      "POST",
      "/api/singleplayer/turn/advance",
    ),
  /** Start playing several turns in the background; poll `batchStatus` for progress. */
  startBatch: (turns: number) =>
    game.request<{ success: boolean; batch: TurnBatch }>("POST", "/api/singleplayer/turn/batch", { turns }),
  batchStatus: () =>
    game.request<{ batch: TurnBatch | null }>("GET", "/api/singleplayer/turn/batch"),
  /** Stop after the turn that is running now. */
  stopBatch: () =>
    game.request<{ success: boolean; batch: TurnBatch }>("DELETE", "/api/singleplayer/turn/batch"),
  /**
   * Worldsim runs playerless, so it is exempt from the character gate on the
   * player turn endpoint and advances one turn at a time here instead. The
   * server still rejects with 409 while the world is paused.
   */
  advanceWorldsim: () =>
    game.request<{ success: boolean; turn: number; briefing?: { fundsDelta: number; actionsDelta: number } }>(
      "POST",
      "/api/singleplayer/worldsim/advance",
      { turns: 1 },
    ),
  /**
   * Local pause state. The server keeps it separate from hosted maintenance
   * while answering the legacy open|sealed availability shape. Pausing never
   * interrupts a running turn; it makes the next advance fail with 409 until
   * the world is resumed.
   */
  worldAvailability: () =>
    game.request<{ availability: "open" | "sealed"; mode: string }>(
      "GET",
      "/api/singleplayer/operator/availability",
    ),
  setWorldAvailability: (availability: "open" | "sealed") =>
    game.request<{ availability: "open" | "sealed"; mode: string }>(
      "POST",
      "/api/singleplayer/operator/availability",
      { availability },
    ),
  /** Save the running world now. Takes a few seconds on a big world. */
  saveNow: (name: string) =>
    game.request<{ save: SaveMeta }>("POST", "/api/singleplayer/saves", {
      name,
    }),
  saves: () => game.request<SavesOverview>("GET", "/api/singleplayer/saves"),
  /** 0 turns autosave off. Kept with the world, so it also applies after a load. */
  setAutosaveEvery: (autosaveEvery: number) =>
    game.request<{ autosaveEvery: number }>(
      "PUT",
      "/api/singleplayer/saves/settings",
      { autosaveEvery },
    ),
  newGame: (preset: string, displayName?: string) =>
    game.request<{ ok: boolean }>("POST", "/api/singleplayer/new-game", {
      preset,
      ...(displayName ? { displayName } : {}),
    }),
};

export type OnlineTarget = "live" | "sandbox";

export const ask = {
  /** Open the player Q&A surface. Mobile presents the native Ask sheet. */
  open: () => invoke<void>("open_ask_window"),
};

export const online = {
  open: (target: OnlineTarget = "live", separateWindow = false) =>
    invoke<void>("open_online_window", { target, separateWindow }),
  link: (separateWindow = false) =>
    invoke<void>("link_account", { separateWindow }),
  account: () => invoke<LinkedAccount | null>("linked_account"),
  /** Revoke the game session and clear every identity cookie in the app. */
  signOut: () => invoke<void>("sign_out"),
  help: (routeId: string) => invoke<void>("open_help_destination", { routeId }),
};
