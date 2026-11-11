/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
import { AutostartControl, StorageControls, formatDiskSize } from "./DesktopControls.js";
import { LanguageProvider } from "./i18n.js";

describe("desktop controls", () => {
  afterEach(() => { cleanup(); invoke.mockReset(); });

  it("start on sign-in is off until chosen and saves the choice", async () => {
    invoke.mockImplementation(async (cmd: string, args?: { enabled: boolean }) => (cmd === "get_autostart" ? false : args?.enabled));
    render(<AutostartControl />);
    const toggle = (await screen.findByRole("switch")) as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(invoke).toHaveBeenCalledWith("set_autostart", { enabled: true });
  });

  it("shows world disk use in German and opens the folder", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "data_folder_info" ? { worldsBytes: 5 * 1024 * 1024, totalBytes: 2 * 1024 ** 3 } : undefined));
    render(<LanguageProvider language="de"><StorageControls /></LanguageProvider>);
    await screen.findByText(/5,0 MB.*2,0 GB/);
    fireEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_data_folder"));
  });

  it("formats sizes", () => {
    expect(formatDiskSize(100)).toBe("1 KB");
    expect(formatDiskSize(12 * 1024 * 1024)).toBe("12 MB");
    expect(formatDiskSize(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});
