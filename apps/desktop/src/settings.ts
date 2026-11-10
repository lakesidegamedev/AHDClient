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
};
const KEY = "ahdclient.settings.v1";
export function readSettings(): ClientSettings {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS, language: defaultLanguage() };
    const result = { ...DEFAULT_SETTINGS, language: defaultLanguage() };
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
export function applySettings(settings: ClientSettings): void {
  document.documentElement.lang = settings.language;
  document.documentElement.dataset.animations = settings.animations
    ? "on"
    : "off";
  window.dispatchEvent(new CustomEvent("ahdclient:settings"));
}
