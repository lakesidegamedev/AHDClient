/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CrashDialog } from "./CrashDialog.js";

afterEach(cleanup);

describe("CrashDialog", () => {
  it("offers restart, report and back", async () => {
    const onRestart = vi.fn();
    const onReport = vi.fn();
    const onBack = vi.fn();
    render(<CrashDialog message="The world stopped unexpectedly." canRestart onRestart={onRestart} onReport={onReport} onBack={onBack} />);
    await userEvent.click(screen.getByRole("button", { name: "Restart world" }));
    await userEvent.click(screen.getByRole("button", { name: "Report" }));
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onRestart).toHaveBeenCalledOnce();
    expect(onReport).toHaveBeenCalledOnce();
    expect(onBack).toHaveBeenCalledOnce();
  });
  it("hides restart when the world is gone", () => {
    render(<CrashDialog message="x" canRestart={false} onRestart={() => {}} onReport={() => {}} onBack={() => {}} />);
    expect(screen.queryByRole("button", { name: "Restart world" })).toBeNull();
  });
});
