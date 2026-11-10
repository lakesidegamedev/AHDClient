import { invoke } from "@tauri-apps/api/core";
import { defaultLanguage, type ClientLanguage } from "./i18n.js";

export interface ClientSettings {
  language: ClientLanguage;
  separateWindow: boolean;
  animations: boolean;
  shareStatistics: boolean;
  showBootLogs: boolean;
  /** Autosave a singleplayer world after every Nth turn; 0 is off. */
  autosaveEvery: number;
  /** Download and offer to install updates without asking first. */
  autoInstallUpdates: boolean;
  /** Phones: skip the launcher and open the game when signed in. */
  openGameOnStart: boolean;
}

/** What Settings offers; the game accepts any whole number up to 100. */
export const AUTOSAVE_CHOICES = [1, 2, 5, 10, 0] as const;
export const DEFAULT_SETTINGS: ClientSettings = {
  language: "en",
  separateWindow: false,
  animations: true,
  shareStatistics: true,
  showBootLogs: false,
  autosaveEvery: 1,
  autoInstallUpdates: false,
  openGameOnStart: true,
};
const KEY = "ahdclient.settings.v1";
/** The OS "reduce motion" choice; a player who never touched the toggle gets it. */
function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
export function readSettings(): ClientSettings {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    const result = { ...DEFAULT_SETTINGS, language: defaultLanguage(), animations: !prefersReducedMotion() };
    if (!parsed || typeof parsed !== "object") return result;
    for (const key of Object.keys(result) as (keyof ClientSettings)[]) {
      const value = (parsed as Record<string, unknown>)[key];
      if (key === "language" && (value === "de" || value === "en")) result.language = value;
      else if (key === "autosaveEvery") {
        if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100)
          result.autosaveEvery = value;
      } else if (typeof value === "boolean") result[key] = value as never;
    }
    return result;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
export function writeSettings(settings: ClientSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* Keep current-session settings when storage is unavailable. */
  }
}
/** Tell the native shell, which reads this before any page script runs. */
export async function syncOpenGameOnStart(enabled: boolean): Promise<void> {
  try {
    await invoke("set_open_game_on_start", { enabled });
  } catch {
    /* Desktop has no such command, and a failed write keeps the old value. */
  }
}
export function applySettings(settings: ClientSettings): void {
  document.documentElement.lang = settings.language;
  document.documentElement.dataset.animations = settings.animations
    ? "on"
    : "off";
  window.dispatchEvent(new CustomEvent("ahdclient:settings"));
}
