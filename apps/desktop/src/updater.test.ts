/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const download = vi.fn();
const install = vi.fn();
const downloadAndInstall = vi.fn();
const check = vi.fn();
const relaunch = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => check(...args),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => relaunch(...args),
}));
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  checkForUpdatesNow,
  confirmRestartToUpdate,
  getUpdaterSnapshot,
  resetUpdaterForTests,
  startBackgroundUpdateCheck,
  startUpdateSchedule,
  downloadAvailableUpdate,
  plainUpdateError,
  formatUpdateSize,
  UPDATE_RECHECK_MS,
  isWindowsUserAgent,
} from "./updater.js";
import { DEFAULT_SETTINGS, writeSettings } from "./settings.js";

async function checkAndDownload(): Promise<void> {
  await startBackgroundUpdateCheck();
  await downloadAvailableUpdate();
}

function updateMock(version = "2.3.1") {
  return {
    version,
    body: "- First improvement\n- Second improvement",
    download,
    install,
    downloadAndInstall,
  };
}

beforeEach(() => {
  resetUpdaterForTests();
  localStorage.clear();
  download.mockReset().mockImplementation(async (onEvent?: (event: unknown) => void) => {
    onEvent?.({ event: "Started", data: { contentLength: 100 } });
    onEvent?.({ event: "Progress", data: { chunkLength: 40 } });
    onEvent?.({ event: "Progress", data: { chunkLength: 60 } });
    onEvent?.({ event: "Finished" });
  });
  install.mockReset().mockResolvedValue(undefined);
  downloadAndInstall.mockReset();
  check.mockReset();
  relaunch.mockReset();
  invoke.mockReset().mockResolvedValue("self-updating");
});

afterEach(() => {
  resetUpdaterForTests();
});

describe("silent updater", () => {
  it("recognises Windows user agents for install-exits-process", () => {
    expect(isWindowsUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(true);
    expect(isWindowsUserAgent("Mozilla/5.0 (X11; Linux x86_64)")).toBe(false);
  });

  it("asks before downloading and shows the size", async () => {
    check.mockResolvedValue({
      ...updateMock(),
      rawJson: { platforms: { "linux-x86_64": { size: 52_428_800 }, "windows-x86_64": { size: 1 } } },
    });
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (X11; Linux x86_64)",
    });
    await startBackgroundUpdateCheck();
    expect(download).not.toHaveBeenCalled();
    expect(getUpdaterSnapshot()).toMatchObject({ kind: "available", version: "2.3.1", size: 52_428_800 });
    expect(formatUpdateSize(52_428_800)).toBe("50 MB");
    expect(formatUpdateSize(null)).toBeNull();
  });

  it("downloads on its own when Install updates automatically is on", async () => {
    writeSettings({ ...DEFAULT_SETTINGS, autoInstallUpdates: true });
    check.mockResolvedValue(updateMock());
    await startBackgroundUpdateCheck();
    expect(download).toHaveBeenCalledTimes(1);
    expect(getUpdaterSnapshot()).toMatchObject({ kind: "ready" });
    expect(install).not.toHaveBeenCalled();
  });

  it("links to the new package instead of updating a deb or rpm install", async () => {
    invoke.mockResolvedValue("package");
    check.mockResolvedValue(updateMock());
    await startBackgroundUpdateCheck();
    expect(getUpdaterSnapshot()).toMatchObject({ kind: "package", version: "2.3.1" });
    await downloadAvailableUpdate();
    expect(download).not.toHaveBeenCalled();
    expect(downloadAndInstall).not.toHaveBeenCalled();
  });

  it("turns raw plugin errors into plain sentences", () => {
    expect(plainUpdateError("error sending request for url")).toMatch(/Could not reach/);
    expect(plainUpdateError("signature verification failed")).toMatch(/could not be verified/);
    expect(plainUpdateError("Could not fetch a valid release JSON from the remote")).toMatch(/not available/);
    expect(plainUpdateError("weird")).toBe("The update did not finish. Try again from Settings.");
  });

  it("re-checks every six hours while the app stays open", async () => {
    vi.useFakeTimers();
    check.mockResolvedValue(null);
    const stop = startUpdateSchedule(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_MS / 2);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_MS / 2 + 11 * 60 * 1000);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
    vi.useRealTimers();
  });

  it("downloads in the background without installing or relaunching", async () => {
    check.mockResolvedValue(updateMock());
    await checkAndDownload();
    expect(download).toHaveBeenCalledTimes(1);
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    expect(getUpdaterSnapshot()).toMatchObject({
      kind: "ready",
      version: "2.3.1",
    });
  });

  it("records download progress from Started and Progress events", async () => {
    const seen: string[] = [];
    const { subscribeUpdater } = await import("./updater.js");
    const stop = subscribeUpdater(() => seen.push(getUpdaterSnapshot().kind));
    check.mockResolvedValue(updateMock());
    await checkAndDownload();
    stop();
    expect(seen).toContain("checking");
    expect(seen).toContain("downloading");
    expect(seen).toContain("ready");
    expect(getUpdaterSnapshot()).toEqual({
      kind: "ready",
      version: "2.3.1",
      notes: "- First improvement\n- Second improvement",
    });
  });

  it("installs only after Restart to update and relaunches off Windows", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    });
    check.mockResolvedValue(updateMock());
    await checkAndDownload();
    await confirmRestartToUpdate();
    expect(install).toHaveBeenCalledWith({ restartAfterInstall: true });
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("hands Windows restart to the installer after showing its progress UI", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    });
    check.mockResolvedValue(updateMock());
    await checkAndDownload();
    await confirmRestartToUpdate();
    expect(install).toHaveBeenCalledWith({ restartAfterInstall: true });
    expect(relaunch).not.toHaveBeenCalled();
    expect(localStorage.getItem("ahdclient.update.restart")).toContain('"to":"2.3.1"');
  });

  it("does not start a second download while one is ready", async () => {
    check.mockResolvedValue(updateMock());
    await checkAndDownload();
    await checkForUpdatesNow();
    expect(check).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(1);
  });
});
