/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => "self-updating"),
}));

import { UpdateNotice } from "./UpdateNotice.js";
import { resetUpdaterForTests, startBackgroundUpdateCheck } from "./updater.js";

describe("UpdateNotice", () => {
  afterEach(() => {
    cleanup();
    resetUpdaterForTests();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("draws nothing when updates are disabled", async () => {
    check.mockResolvedValue({ version: "2.3.1", body: "- A", download, install, downloadAndInstall });
    render(<UpdateNotice enabled={false} />);
    await act(async () => {
      await startBackgroundUpdateCheck();
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows notes and size and waits for Download update", async () => {
    check.mockResolvedValue({
      version: "2.3.1",
      body: "- First improvement",
      rawJson: { platforms: { "linux-x86_64": { size: 30 * 1024 * 1024 } } },
      download,
      install,
      downloadAndInstall,
    });
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (X11; Linux x86_64)",
    });
    render(<UpdateNotice />);
    await act(async () => {
      await startBackgroundUpdateCheck();
    });
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("AHDClient 2.3.1 is available");
    expect(notice.textContent).toContain("30 MB download");
    expect(notice.textContent).toContain("First improvement");
    expect(download).not.toHaveBeenCalled();
    download.mockResolvedValue(undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Download update" }));
      await Promise.resolve();
    });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("shows a dismissable download bar then Restart to update after download", async () => {
    let finishDownload: () => void = () => {};
    download.mockImplementation(
      async (
        onEvent?: (event: {
          event: string;
          data?: { contentLength?: number; chunkLength?: number };
        }) => void,
      ) => {
        onEvent?.({ event: "Started", data: { contentLength: 50 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 25 } });
        await new Promise<void>((resolve) => {
          finishDownload = resolve;
        });
        onEvent?.({ event: "Progress", data: { chunkLength: 25 } });
      },
    );
    install.mockResolvedValue(undefined);
    check.mockResolvedValue({
      version: "2.3.1",
      body: "- First improvement\n- Second improvement with much more detail",
      download,
      install,
      downloadAndInstall,
    });

    render(<UpdateNotice />);
    await act(async () => {
      await startBackgroundUpdateCheck();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Download update" }));
      await Promise.resolve();
    });

    expect(screen.getByRole("status").textContent).toContain("Downloading AHDClient 2.3.1");
    expect(screen.getByRole("progressbar")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();

    await act(async () => {
      finishDownload();
      await Promise.resolve();
    });
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("AHDClient 2.3.1 is ready");
    expect(screen.getByRole("button", { name: "Restart to update" })).toBeTruthy();
    const details = screen.getByText("What's new").closest("details");
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.textContent).toContain("First improvement");

    const css = readFileSync(join(process.cwd(), "src/update.css"), "utf8");
    expect(css).toMatch(/\.client-update-notice\s*\{[^}]*position:\s*fixed/s);
    expect(css).toMatch(/\.client-update-progress\s*\{/s);

    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(relaunch).not.toHaveBeenCalled();
  });
});
