/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DiagnosticPanel } from "./DiagnosticPanel.js";
import { clearDiagnostics, recordDiagnostic } from "./diagnostics.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("DiagnosticPanel", () => {
  beforeEach(() => {
    clearDiagnostics();
    recordDiagnostic("warn", "renderer warning");
  });
  afterEach(cleanup);

  it("shows redacted console and runtime details on every shell", () => {
    render(<DiagnosticPanel open screen="launcher" game="remote only" onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Diagnostics" })).toBeTruthy();
    expect(screen.getByLabelText("Recent console output").textContent).toContain("renderer warning");
    expect(screen.getByText("launcher")).toBeTruthy();
    expect(screen.getByText("remote only")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });
});
