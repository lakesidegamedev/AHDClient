/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, readSettings, writeSettings } from "./settings.js";
afterEach(() => localStorage.clear());
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
});
