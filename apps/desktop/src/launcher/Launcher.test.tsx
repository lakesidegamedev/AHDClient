/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Launcher } from "./Launcher.js";
import type { WorldMeta } from "../worlds.js";

vi.mock("./CommandGlobe.js", () => ({
  CommandGlobe: () => null,
  themeForEra: () => ({ phosphor: "#0f0" }),
}));

const world: WorldMeta = {
  slot: "cold-war-1953",
  name: "Cold War, 1953",
  preset: "1953-default",
  createdAt: "2026-09-05T00:00:00Z",
  lastPlayedAt: "2026-09-05T01:00:00Z",
  turn: 12,
  character: "Senator Example",
};

function renderLauncher(overrides: Partial<Parameters<typeof Launcher>[0]> = {}) {
  const props = {
    onNewWorld: vi.fn(),
    onContinue: vi.fn(),
    onLoad: vi.fn(),
    onPlayOnline: vi.fn(),
    error: null,
    onClearError: vi.fn(),
    latestWorld: null,
    runningSlot: null,
    continueBusy: false,
    sandboxGate: null,
    ...overrides,
  };
  render(<Launcher {...props} />);
  return props;
}

describe("Launcher", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("keeps singleplayer actions together until New Game opens era selection", async () => {
    const props = renderLauncher();
    expect(screen.getByRole("button", { name: "New Game" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load Game" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Starting era timeline" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "New Game" }));
    expect(screen.getAllByText("Cold War dawn")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: /1979/ }));
    expect(screen.getAllByText("Late Cold War")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: /1953/ }));
    await userEvent.click(screen.getByRole("button", { name: /Start new game/ }));
    expect(props.onNewWorld).toHaveBeenCalledWith("1953");
  });

  it("starts a new world in the selected era", async () => {
    const props = renderLauncher();
    await userEvent.click(screen.getByRole("button", { name: "New Game" }));
    await userEvent.click(screen.getByRole("button", { name: /1979/ }));
    await userEvent.click(screen.getByRole("button", { name: /Start new game/ }));
    expect(props.onNewWorld).toHaveBeenCalledWith("1979");
  });

  it("presents every era as one chronological timeline", async () => {
    renderLauncher();
    await userEvent.click(screen.getByRole("button", { name: "New Game" }));
    const timeline = screen.getByRole("list", { name: "Starting era timeline" });
    expect(timeline.querySelectorAll('[role="listitem"]')).toHaveLength(8);
    expect(timeline.querySelector('button[aria-current="true"]')?.textContent).toContain("1953");
  });

  it("gives the selected era preview the full panel width", () => {
    const css = readFileSync("src/launcher/launcher.css", "utf8");
    expect(css).toMatch(/\.launcher-era-carousel\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    expect(css).toMatch(/\.launcher-era-timeline button small\s*\{[^}]*white-space:\s*normal/s);
    expect(css).not.toMatch(/\.launcher-era-timeline button small\s*\{[^}]*text-overflow:\s*ellipsis/s);
    expect(css).toMatch(/\.launcher-era-photo\s*\{[^}]*object-fit:\s*contain/s);
  });

  it("renders the launcher in German when the locale setting selects it", () => {
    renderLauncher({ language: "de" });
    expect(screen.getByRole("button", { name: /Einzelspieler/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mehrspieler" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Neues Spiel" })).toBeTruthy();
  });

  it("keeps era photography hidden until New Game and delegates source opening", async () => {
    localStorage.removeItem("ahdclient.launcher.era");
    const onPhotoSource = vi.fn();
    renderLauncher({ onPhotoSource });
    expect(screen.queryByAltText(/Eisenhower's 1953/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "New Game" }));
    expect(screen.getByAltText(/Eisenhower's 1953/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Photo source" }));
    expect(onPhotoSource).toHaveBeenCalledWith("1953");
  });

  it("continues the most recent world by slot", async () => {
    const props = renderLauncher({ latestWorld: world });
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(props.onContinue).toHaveBeenCalledWith("cold-war-1953");
    expect(screen.getByText(/turn 12/)).toBeTruthy();
  });

  it("says Resume when that world's server is already running", () => {
    renderLauncher({ latestWorld: world, runningSlot: world.slot });
    expect(screen.getByRole("button", { name: /Resume/ })).toBeTruthy();
  });

  it("hands multiplayer to the guarded online window", async () => {
    const props = renderLauncher();
    await userEvent.click(screen.getByRole("button", { name: "Multiplayer" }));
    await userEvent.click(screen.getByRole("button", { name: /Enter multiplayer/ }));
    expect(props.onPlayOnline).toHaveBeenCalledWith("live");
  });

  it("offers the sandbox server as a third mode", async () => {
    const props = renderLauncher();
    await userEvent.click(screen.getByRole("button", { name: "Sandbox" }));
    await userEvent.click(screen.getByRole("button", { name: /Enter sandbox/ }));
    expect(props.onPlayOnline).toHaveBeenCalledWith("sandbox");
  });
  it("keeps every client control in the top bar on desktop", () => {
    renderLauncher({
      accountControl: <button>Account</button>,
      briefingControl: <button>Briefing</button>,
      settingsControl: <button>Settings</button>,
      askControl: <button>Ask</button>,
    });
    const bar = screen.getByRole("navigation", { name: "Client" });
    expect([...bar.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Account",
      "Briefing",
      "Settings",
      "Ask",
    ]);
    expect(document.querySelector(".launcher-quick")).toBeNull();
  });

  it("moves Briefing and Ask beside the main action on phones", () => {
    renderLauncher({
      mobile: true,
      accountControl: <button>Account</button>,
      briefingControl: <button>Briefing</button>,
      settingsControl: <button>Settings</button>,
      askControl: <button>Ask</button>,
    });
    const bar = screen.getByRole("navigation", { name: "Client" });
    expect([...bar.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Account", "Settings"]);
    const quick = document.querySelector(".launcher-actions .launcher-quick")!;
    expect([...quick.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Briefing", "Ask"]);
  });

  it("offers only the online modes on mobile and defaults to multiplayer", async () => {
    localStorage.setItem("ahdclient.launcher.mode", "sp");
    const props = renderLauncher({ mobile: true });
    expect(screen.queryByRole("button", { name: /Singleplayer/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Worldsim/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "New Game" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Load Game" })).toBeNull();
    expect(screen.getByRole("button", { name: "Multiplayer" }).getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: /Enter multiplayer/ }));
    expect(props.onPlayOnline).toHaveBeenCalledWith("live");
    await userEvent.click(screen.getByRole("button", { name: "Sandbox" }));
    await userEvent.click(screen.getByRole("button", { name: /Enter sandbox/ }));
    expect(props.onPlayOnline).toHaveBeenCalledWith("sandbox");
    localStorage.removeItem("ahdclient.launcher.mode");
  });

  it("hides the sandbox on mobile unless the account already has it", async () => {
    localStorage.setItem("ahdclient.launcher.mode", "sandbox");
    renderLauncher({ mobile: true, sandboxAvailable: false });
    expect(screen.queryByRole("button", { name: "Sandbox" })).toBeNull();
    expect(screen.queryByText(/Supporter/)).toBeNull();
    expect(screen.getByRole("button", { name: /Enter multiplayer/ })).toBeTruthy();
    expect(localStorage.getItem("ahdclient.launcher.mode")).toBe("mp");
  });
});
