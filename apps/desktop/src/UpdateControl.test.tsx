/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const download = vi.fn();
const install = vi.fn();
const downloadAndInstall = vi.fn();
const check = vi.fn();
const relaunch = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => check(...args),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => "self-updating"),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => relaunch(...args),
}));

import { UpdateControl } from "./UpdateControl.js";
import { resetUpdaterForTests } from "./updater.js";

afterEach(() => {
  cleanup();
  resetUpdaterForTests();
  vi.clearAllMocks();
});

describe("desktop updates", () => {
  it("reports an installation failure and lets the user retry", async () => {
    download.mockResolvedValue(undefined);
    install.mockRejectedValueOnce(new Error("signature rejected"));
    check.mockResolvedValue({
      version: "2.0.4",
      body: "notes",
      download,
      install,
      downloadAndInstall,
    });
    render(<UpdateControl />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    fireEvent.click(await screen.findByRole("button", { name: "Download update" }));
    const restart = await screen.findByRole("button", {
      name: "Restart to update",
    });
    expect(downloadAndInstall).not.toHaveBeenCalled();
    fireEvent.click(restart);

    await waitFor(() =>
      expect(screen.getByText(/could not be verified/)).toBeTruthy(),
    );
    expect(
      screen.getByRole("button", { name: "Check for updates" }),
    ).toBeTruthy();
    expect(relaunch).not.toHaveBeenCalled();
  });
});
