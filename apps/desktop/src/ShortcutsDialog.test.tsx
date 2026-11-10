/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShortcutsDialog } from "./ShortcutsDialog.js";

afterEach(cleanup);

describe("ShortcutsDialog", () => {
  it("lists the shortcuts and closes on Escape", async () => {
    const onClose = vi.fn();
    render(<ShortcutsDialog onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
    expect(screen.getByText("End turn")).toBeTruthy();
    expect(screen.getByText("Ask about the game")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
