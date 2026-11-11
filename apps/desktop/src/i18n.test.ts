import { describe, expect, it } from "vitest";
import { defaultLanguage, translate } from "./i18n.js";
import { DE } from "./i18n.de.js";
import { EN } from "./i18n.en.js";

describe("client language", () => {
  it("follows German operating-system locales and falls back to English", () => {
    expect(defaultLanguage(["de-DE"])).toBe("de");
    expect(defaultLanguage(["de-CH", "en"])).toBe("de");
    expect(defaultLanguage(["fr-FR"])).toBe("en");
  });

  it("has German client-shell copy", () => {
    expect(translate("de", "settings.title")).toBe("Einstellungen");
    expect(translate("de", "launcher.newGame")).toBe("Neues Spiel");
    expect(translate("de", "runtime.label")).toBe("Spielversion");
  });

  it("fills placeholders and keeps them identical in both languages", () => {
    expect(translate("en", "settings.autosaveEveryN", { n: 5 })).toBe("Every 5 turns");
    expect(translate("de", "settings.autosaveEveryN", { n: 5 })).toBe("Alle 5 Züge");
    const holes = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join(",");
    for (const key of Object.keys(EN) as (keyof typeof EN)[]) {
      expect(DE[key], key).toBeTruthy();
      expect(holes(DE[key]), key).toBe(holes(EN[key]));
    }
  });

  it("uses no dashes in player copy", () => {
    for (const text of [...Object.values(EN), ...Object.values(DE)]) expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("client screens in German", () => {
  it("has German copy for the screens and dialogs", () => {
    expect(translate("de", "worlds.title")).toBe("Deine Welten");
    expect(translate("de", "boot.retry")).toBe("Noch einmal versuchen");
    expect(translate("de", "worldsim.completed", { n: 3 })).toBe("3 Züge abgeschlossen");
  });

  it("never shows engine jargon in player copy", () => {
    for (const text of Object.values(EN)) expect(text).not.toMatch(/\bNPPs?\b/);
  });
});
