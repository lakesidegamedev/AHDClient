/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
import { TrayControl } from "./TrayControl.js";

describe("TrayControl", () => {
  afterEach(() => { cleanup(); invoke.mockReset(); });

  it("is off by default and saves the choice", async () => {
    invoke.mockImplementation(async (cmd: string, args?: { enabled: boolean }) =>
      cmd === "get_tray_settings" ? { available: true, keepInTray: false } : { available: true, keepInTray: args?.enabled });
    render(<TrayControl />);
    const toggle = await screen.findByRole("switch");
    await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false));
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true));
    expect(invoke).toHaveBeenCalledWith("set_keep_in_tray", { enabled: true });
  });

  it("is disabled with a plain explanation when the system has no tray", async () => {
    invoke.mockResolvedValue({ available: false, keepInTray: true });
    render(<TrayControl />);
    await screen.findByText(/no tray available/);
    expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(true);
  });
});
