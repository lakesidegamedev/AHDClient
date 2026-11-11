/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
import { TurnReminderControl } from "./TurnReminderControl.js";

const off = { turnReminder: false, quiet: { enabled: false, start: 1320, end: 420 } };

describe("TurnReminderControl", () => {
  afterEach(() => { cleanup(); invoke.mockReset(); });

  it("is off by default and saves each choice", async () => {
    invoke.mockImplementation(async (cmd: string, args?: { turnReminder: boolean; quiet: unknown }) =>
      cmd === "get_reminder_settings" ? off : args);
    render(<TurnReminderControl />);
    const [reminder, quiet] = await screen.findAllByRole("switch") as HTMLInputElement[];
    await waitFor(() => expect(reminder.disabled).toBe(false));
    expect(reminder.checked).toBe(false);
    expect(quiet.checked).toBe(false);
    fireEvent.click(reminder);
    await waitFor(() => expect(reminder.checked).toBe(true));
    expect(invoke).toHaveBeenCalledWith("set_reminder_settings", { turnReminder: true, quiet: off.quiet });
    fireEvent.click(quiet);
    await waitFor(() => expect(quiet.checked).toBe(true));
    expect(invoke).toHaveBeenCalledWith("set_reminder_settings", { turnReminder: true, quiet: { ...off.quiet, enabled: true } });
    expect(await screen.findAllByDisplayValue(/^\d\d:\d\d$/)).toHaveLength(2);
  });
});
