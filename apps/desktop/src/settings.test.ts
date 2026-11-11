/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, applySettings, readSettings, writeSettings } from "./settings.js";
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});
describe("client preferences", () => {
  it("defaults to same-window gameplay", () => {
    expect(readSettings()).toEqual(DEFAULT_SETTINGS);
    expect(readSettings().separateWindow).toBe(false);
  });
  it("persists an explicit statistics opt-out across reloads", () => {
    writeSettings({ ...DEFAULT_SETTINGS, shareStatistics: false });
    expect(readSettings().shareStatistics).toBe(false);
  });
  it("does not accept string booleans or unknown persisted fields", () => {
    localStorage.setItem("ahdclient.settings.v1", '{"separateWindow":"false","accountToken":"secret","animations":false}');
    expect(readSettings()).toEqual({ ...DEFAULT_SETTINGS, animations: false });
  });
  it("defaults to an autosave every turn and only accepts a whole number from 0 to 100", () => {
    expect(readSettings().autosaveEvery).toBe(1);
    for (const [stored, expected] of [[0, 0], [5, 5], [101, 1], [-1, 1], [2.5, 1]] as const) {
      localStorage.setItem("ahdclient.settings.v1", JSON.stringify({ autosaveEvery: stored }));
      expect(readSettings().autosaveEvery).toBe(expected);
    }
    localStorage.setItem("ahdclient.settings.v1", '{"autosaveEvery":"5"}');
    expect(readSettings().autosaveEvery).toBe(1);
  });
  it("opens into the game by default and only accepts a real boolean", () => {
    expect(readSettings().openGameOnStart).toBe(true);
    localStorage.setItem("ahdclient.settings.v1", '{"openGameOnStart":false}');
    expect(readSettings().openGameOnStart).toBe(false);
    localStorage.setItem("ahdclient.settings.v1", '{"openGameOnStart":"no"}');
    expect(readSettings().openGameOnStart).toBe(true);
  });
  it("turns animations off when the OS asks for reduced motion, unless the player chose", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    expect(readSettings().animations).toBe(false);
    localStorage.setItem("ahdclient.settings.v1", '{"animations":true}');
    expect(readSettings().animations).toBe(true);
  });
  it("accepts only the offered interface sizes", () => {
    expect(DEFAULT_SETTINGS.uiScale).toBe(100);
    localStorage.setItem("ahdclient.settings.v1", '{"uiScale":125}');
    expect(readSettings().uiScale).toBe(125);
    localStorage.setItem("ahdclient.settings.v1", '{"uiScale":300}');
    expect(readSettings().uiScale).toBe(100);
  });
  it("applies the interface size to the page and clears it at 100", () => {
    applySettings({ ...DEFAULT_SETTINGS, uiScale: 110 });
    expect(document.documentElement.dataset.uiScale).toBe("110");
    expect(document.documentElement.style.getPropertyValue("--ui-scale")).toBe("1.1");
    applySettings(DEFAULT_SETTINGS);
    expect(document.documentElement.dataset.uiScale).toBeUndefined();
  });
});
