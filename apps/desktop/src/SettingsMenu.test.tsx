/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsMenu } from "./SettingsMenu.js";
import { DEFAULT_SETTINGS } from "./settings.js";

vi.mock("./UpdateControl.js", () => ({
  UpdateControl: () => <p>Desktop updates</p>,
}));

vi.mock("./PushControl.js", () => ({
  PushControl: ({ mobile = true }: { mobile?: boolean }) => <p>{mobile ? "Push notifications" : "Desktop alerts"}</p>,
}));

describe("SettingsMenu", () => {
  afterEach(cleanup);

  it("sections desktop settings into General, Notifications, Singleplayer, Updates and Support", () => {
    render(
      <SettingsMenu open settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} onReportIssue={vi.fn()} onOpenDiagnostics={vi.fn()} />,
    );
    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Singleplayer" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Updates" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Support" })).toBeTruthy();
    expect(screen.getByText("Separate gameplay window")).toBeTruthy();
    expect(screen.getByText("Anonymous simulation statistics")).toBeTruthy();
    expect(screen.getByText("Desktop updates")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Notifications" })).toBeTruthy();
    expect(screen.getByText("Desktop alerts")).toBeTruthy();
  });

  it("keeps Advanced collapsed and uses player copy", () => {
    render(
      <SettingsMenu open settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} onReportIssue={vi.fn()} onOpenDiagnostics={vi.fn()} />,
    );
    const advanced = document.querySelector("details.client-settings-advanced");
    expect(advanced).toBeTruthy();
    expect((advanced as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByRole("button", { name: "Report a problem" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/GitHub/);
  });

  it("shows the mobile short variant without desktop-only rows", () => {
    render(
      <SettingsMenu mobile open settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} onReportIssue={vi.fn()} onOpenDiagnostics={vi.fn()} />,
    );
    expect(screen.getByText("Push notifications")).toBeTruthy();
    expect(screen.getByText("Launcher animation")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Report a problem" })).toBeTruthy();
    expect(screen.getByText("Developer diagnostics")).toBeTruthy();
    expect(screen.queryByText("Separate gameplay window")).toBeNull();
    expect(screen.queryByText("Anonymous simulation statistics")).toBeNull();
    expect(screen.queryByText("Technical startup logs")).toBeNull();
    expect(screen.queryByText("Desktop updates")).toBeNull();
    // Store builds update through the store: no Updates section to act on.
    expect(screen.queryByRole("heading", { name: "Updates" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Notifications" })).toBeTruthy();
  });

  it("names the client version and keeps English copy in English", () => {
    render(
      <SettingsMenu mobile open settings={DEFAULT_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} onReportIssue={vi.fn()} onOpenDiagnostics={vi.fn()} />,
    );
    expect(document.querySelector(".client-settings-kicker")?.textContent).toMatch(/^AHDClient \d+\.\d+\.\d+$/);
    expect(document.body.textContent).not.toMatch(/Kontrollraum|Einstellungen/);
  });

  it("switches rows to German", () => {
    render(
      <SettingsMenu open settings={{ ...DEFAULT_SETTINGS, language: "de" }} onChange={vi.fn()} onClose={vi.fn()} onReportIssue={vi.fn()} onOpenDiagnostics={vi.fn()} />,
    );
    expect(screen.getByRole("heading", { name: "Einstellungen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Problem melden" })).toBeTruthy();
  });

  it("reports each switch change as a settings patch", () => {
    const onChange = vi.fn();
    render(
      <SettingsMenu open settings={DEFAULT_SETTINGS} onChange={onChange} onClose={vi.fn()} onReportIssue={vi.fn()} onOpenDiagnostics={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("switch", { name: /Separate gameplay window/ }));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, separateWindow: true });
  });
});
