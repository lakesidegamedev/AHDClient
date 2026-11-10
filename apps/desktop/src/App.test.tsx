/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  game: {
    start: vi.fn(),
    stop: vi.fn(),
    status: vi.fn(),
    setup: vi.fn(),
    setupProgress: vi.fn(),
    singleplayerStatus: vi.fn(),
    openWindow: vi.fn(),
    closeEmbedded: vi.fn(),
    request: vi.fn(),
    refreshView: vi.fn(),
    setEmbeddedVisible: vi.fn(),
    advanceTurn: vi.fn(),
    advanceWorldsim: vi.fn(),
    worldAvailability: vi.fn(),
    setWorldAvailability: vi.fn(),
    setAutosaveEvery: vi.fn(),
    saves: vi.fn(),
    saveNow: vi.fn(),
  },
  worldSaves: { list: vi.fn(), remove: vi.fn(), requestLoad: vi.fn() },
  worlds: { list: vi.fn(), create: vi.fn(), touch: vi.fn(), remove: vi.fn() },
  classicGame: { info: vi.fn(async () => ({ version: null, installed: false, sizeBytes: null })), install: vi.fn(), cancel: vi.fn() },
  online: { account: vi.fn(), open: vi.fn(), link: vi.fn() },
  ask: { open: vi.fn() },
  listen: vi.fn(),
  stats: {
    captureStatistics: vi.fn(),
    flushStatistics: vi.fn(),
    setStatisticsConsent: vi.fn(),
  },
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("./worlds.js", () => ({
  game: mocks.game,
  worlds: mocks.worlds,
  classicGame: mocks.classicGame,
  CLASSIC_REQUIRED: "classic-required:",
  worldSaves: mocks.worldSaves,
  online: mocks.online,
  ask: mocks.ask,
  eraById: (id: string) =>
    id === "1953"
      ? {
          id,
          preset: "1953-default",
          label: "1953",
          subtitle: "Cold War dawn",
          startDate: "January 1953",
        }
      : undefined,
  slugForWorld: () => "test-world",
}));
vi.mock("./statisticsDelivery.js", () => mocks.stats);
vi.mock("./SettingsMenu.js", () => ({
  SettingsMenu: ({
    open,
    onClose,
    onOpenDiagnostics,
  }: {
    open: boolean;
    onClose: () => void;
    onOpenDiagnostics: () => void;
  }) =>
    open ? (
      <div role="dialog" aria-label="Settings">
        <button aria-label="Close settings" onClick={onClose}>
          ×
        </button>
        <button onClick={onOpenDiagnostics}>Open diagnostics</button>
      </div>
    ) : null,
}));
vi.mock("./launcher/Launcher.js", () => ({
  Launcher: ({
    onNewWorld,
    error,
  }: {
    onNewWorld: (era: string, worldsim?: boolean) => void;
    error: string | null;
  }) => (
    <main>
      <button onClick={() => onNewWorld("1953")}>New world</button>
      {error && <p role="alert">{error}</p>}
    </main>
  ),
}));
vi.mock("./screens/NewWorldScreen.js", () => ({
  NewWorldScreen: ({
    onCreate,
    error,
    onLinkAccount,
  }: {
    onCreate: (name: string, displayName: string, setup: unknown) => void;
    error?: string | null;
    onLinkAccount?: () => void;
  }) => (
    <main>
      <button
        onClick={() =>
          onCreate("Test world", "", {
            mode: "normal",
            difficulty: "normal",
            autonomyLevel: "v4",
            featureFlags: {},
          })
        }
      >
        Create
      </button>
      {error && <p role="alert">{error}</p>}
      {onLinkAccount && <button onClick={onLinkAccount}>Link account</button>}
    </main>
  ),
}));
vi.mock("./screens/WorldsScreen.js", () => ({ WorldsScreen: () => null }));
vi.mock("./screens/BootScreen.js", () => ({
  BootScreen: ({ onCancel }: { onCancel: () => void }) => <main><p>Booting</p><button onClick={onCancel}>Cancel loading</button></main>,
}));
vi.mock("./screens/PlayingScreen.js", () => ({
  PlayingScreen: () => <p>Playing</p>,
}));
vi.mock("./screens/WorldsimScreen.js", () => ({
  WorldsimScreen: ({ onView }: { onView: () => void }) => (
    <main>
      <p>Worldsim</p>
      <button onClick={onView}>View all world</button>
    </main>
  ),
}));

import { App } from "./App.js";

const idle = { running: false, hosted: false, port: null, slot: null, url: null };
const running = {
  running: true,
  hosted: false,
  port: 3000,
  slot: "test-world",
  url: "http://127.0.0.1:3000",
};
const normalStatus: {
  hasWorld: boolean;
  turn: number;
  preset: string;
  hasCharacter: boolean;
  characterName: string | null;
  mode: string;
} = {
  hasWorld: true,
  turn: 1,
  preset: "1953-default",
  hasCharacter: false,
  characterName: null,
  mode: "normal",
};

function prepare(status = normalStatus) {
  mocks.listen.mockResolvedValue(vi.fn());
  mocks.worlds.list.mockResolvedValue([]);
  mocks.worlds.create.mockResolvedValue({
    slot: "test-world",
    name: "Test world",
    preset: "1953-default",
  });
  mocks.game.status.mockResolvedValue(idle);
  mocks.game.start.mockResolvedValue(running);
  mocks.game.stop.mockResolvedValue(idle);
  mocks.game.setup.mockResolvedValue({ ok: true });
  mocks.game.setupProgress.mockResolvedValue({
    active: true,
    phase: "building",
    label: "Building the world",
    detail: "Seeding institutions",
    progress: 42,
    updatedAt: new Date().toISOString(),
    stalled: false,
  });
  mocks.game.singleplayerStatus.mockResolvedValue(status);
  mocks.game.openWindow.mockResolvedValue(undefined);
  mocks.game.refreshView.mockResolvedValue("/profile");
  mocks.game.setEmbeddedVisible.mockResolvedValue(undefined);
  mocks.game.advanceTurn.mockResolvedValue({ success: true, turn: 2, message: "Turn 2" });
  mocks.game.advanceWorldsim.mockResolvedValue({ success: true, turn: 41 });
  mocks.game.worldAvailability.mockResolvedValue({ availability: "open", mode: "off" });
  mocks.game.setWorldAvailability.mockImplementation(async (next: "open" | "sealed") =>
    ({ availability: next, mode: "off" }),
  );
  mocks.game.setAutosaveEvery.mockResolvedValue({ autosaveEvery: 1 });
  mocks.game.saves.mockResolvedValue({ saves: [], settings: { autosaveEvery: 1 }, autosaveError: null, lastLoad: null });
  mocks.worldSaves.list.mockResolvedValue([
    {
      id: "20261101T120000Z-aaaaaa",
      kind: "manual",
      name: "Before the vote",
      turn: 7,
      preset: "1953-default",
      mode: "normal",
      characterName: "Ada",
      createdAt: "2026-11-01T12:00:00.000Z",
      sizeBytes: 9_000_000,
    },
  ]);
  mocks.worldSaves.requestLoad.mockResolvedValue({});
  mocks.stats.captureStatistics.mockResolvedValue(undefined);
  mocks.stats.flushStatistics.mockResolvedValue(undefined);
  mocks.stats.setStatisticsConsent.mockResolvedValue(undefined);
  mocks.online.account.mockResolvedValue({
    linked: true,
    displayName: "Ada",
    supporter: false,
    singleplayer: {
      entitled: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
}

describe("App singleplayer integration", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("sends setup options and opens mandatory character creation in the default same window", async () => {
    prepare();
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "New world" }));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(mocks.game.setup).toHaveBeenCalledWith(
        "1953-default",
        expect.objectContaining({
          mode: "normal",
          difficulty: "normal",
          autonomyLevel: "v4",
        }),
        undefined,
      ),
    );
    await waitFor(() =>
      expect(mocks.game.openWindow).toHaveBeenCalledWith(
        "/create-character",
        false,
      ),
    );
  });

  it("keeps worldsim in the launcher until the player requests the game viewport", async () => {
    prepare({ ...normalStatus, mode: "worldsim", hasCharacter: false });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "New world" }));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByText("Worldsim")).toBeTruthy());
    expect(mocks.game.openWindow).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "View all world" }),
    );
    await waitFor(() =>
      expect(mocks.game.openWindow).toHaveBeenCalledWith(
        "/singleplayer/worldsim",
        false,
      ),
    );
  });

  it("surfaces setup failures in the launcher", async () => {
    prepare();
    mocks.game.setup.mockRejectedValue(new Error("setup failed"));
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "New world" }));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "setup failed",
    );
  });

  it("escapes a setup request when the game reports that setup stalled", async () => {
    prepare();
    mocks.game.setup.mockReturnValue(new Promise(() => {}));
    mocks.game.setupProgress.mockResolvedValue({
      active: true,
      phase: "building",
      label: "Building the world",
      detail: "Seeding institutions",
      progress: 42,
      updatedAt: new Date(Date.now() - 120_000).toISOString(),
      stalled: true,
    });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "New world" }));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect((await screen.findByRole("alert", {}, { timeout: 3_000 })).textContent)
      .toContain("stopped reporting progress");
    expect(screen.getByRole("dialog", { name: "Report this problem?" })).toBeTruthy();
  });

  it("offers diagnostics after the player cancels loading", async () => {
    prepare();
    mocks.game.start.mockReturnValue(new Promise(() => {}));
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "New world" }));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel loading" }));
    expect(await screen.findByRole("dialog", { name: "Report this problem?" })).toBeTruthy();
    expect(mocks.game.stop).toHaveBeenCalled();
  });

  it("refuses setup entry without singleplayer access, before any world is configured", async () => {
    prepare();
    mocks.online.account.mockResolvedValue({
      linked: true,
      displayName: "Ada",
      supporter: false,
      singleplayer: { entitled: false, expiresAt: null },
    });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "New world" }));
    // The refusal lands on the launcher: setup never opens, so there is no
    // entered configuration to discard.
    expect((await screen.findByRole("alert")).textContent).toContain(
      "not enabled",
    );
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    expect(mocks.game.start).not.toHaveBeenCalled();
    expect(mocks.worlds.create).not.toHaveBeenCalled();
  });

  /** Boot a world with a character so the embedded playing toolbar mounts. */
  async function bootToEmbeddedPlaying() {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "New world" }));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByRole("button", { name: "End turn" });
  }

  it("refreshes the child game view on its current path after a turn", async () => {
    prepare({ ...normalStatus, hasCharacter: true, characterName: "Ada" });
    await bootToEmbeddedPlaying();
    const button = screen.getByRole("button", { name: "End turn" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(button);
    await waitFor(() => expect(mocks.game.advanceTurn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.worlds.touch).toHaveBeenCalled());
    await waitFor(() => expect(mocks.game.refreshView).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(mocks.stats.captureStatistics).toHaveBeenCalledWith("test-world"),
    );
  });

  it("hides the embedded game while launcher dialogs are open and restores it after", async () => {
    prepare({ ...normalStatus, hasCharacter: true, characterName: "Ada" });
    await bootToEmbeddedPlaying();
    // Showing the embedded view on open is expected; the dialog sequence
    // starts from a clean slate.
    mocks.game.setEmbeddedVisible.mockClear();
    // The toolbar no longer duplicates the game's settings entry: Settings
    // opens from the Game menu (Ctrl or Cmd+comma), which emits this event.
    const settingsCall = mocks.listen.mock.calls.find(([name]) => name === "client:settings");
    expect(settingsCall).toBeTruthy();
    await act(async () => { (settingsCall![1] as () => void)(); });
    await waitFor(() =>
      expect(mocks.game.setEmbeddedVisible).toHaveBeenCalledWith(false),
    );
    // Settings to diagnostics handoff: the game stays hidden, never flashes back.
    await userEvent.click(screen.getByRole("button", { name: "Open diagnostics" }));
    expect(mocks.game.setEmbeddedVisible).not.toHaveBeenCalledWith(true);
    await userEvent.click(screen.getByRole("button", { name: "Close diagnostics" }));
    await waitFor(() =>
      expect(mocks.game.setEmbeddedVisible).toHaveBeenCalledWith(true),
    );
  });

  it("hands the autosave interval from Settings to the running world", async () => {
    localStorage.setItem("ahdclient.settings.v1", JSON.stringify({ autosaveEvery: 5 }));
    prepare({ ...normalStatus, hasCharacter: true, characterName: "Ada" });
    await bootToEmbeddedPlaying();
    await waitFor(() => expect(mocks.game.setAutosaveEvery).toHaveBeenCalledWith(5));
  });

  async function openSavesAndLoad() {
    await bootToEmbeddedPlaying();
    const saves = [...document.querySelectorAll<HTMLButtonElement>(".client-toolbar-overflow [role='menuitem']")].find(
      (button) => button.textContent === "Saves",
    )!;
    fireEvent.click(saves);
    await userEvent.click(await screen.findByRole("button", { name: "Load" }));
    await userEvent.click(screen.getByRole("button", { name: "Load it" }));
  }

  it("loads a save by stopping the world, queueing the load and starting it again", async () => {
    prepare({ ...normalStatus, hasCharacter: true, characterName: "Ada" });
    mocks.game.status.mockResolvedValue(running);
    await openSavesAndLoad();
    await waitFor(() =>
      expect(mocks.worldSaves.requestLoad).toHaveBeenCalledWith("test-world", "20261101T120000Z-aaaaaa"),
    );
    expect(mocks.game.stop).toHaveBeenCalled();
    await waitFor(() => expect(mocks.game.start).toHaveBeenCalledTimes(2));
    expect(mocks.game.start).toHaveBeenLastCalledWith("test-world", false);
    // The stop happens before the load is queued: a running world cannot take one.
    expect(mocks.game.stop.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.worldSaves.requestLoad.mock.invocationCallOrder[0]!,
    );
  });

  it("stops and says why when the game reports the load failed", async () => {
    prepare({ ...normalStatus, hasCharacter: true, characterName: "Ada" });
    mocks.game.saves.mockResolvedValue({
      saves: [],
      settings: { autosaveEvery: 1 },
      autosaveError: null,
      lastLoad: { at: "now", ok: false, message: "That save could not be loaded and your world is unchanged." },
    });
    await openSavesAndLoad();
    expect((await screen.findByRole("alert")).textContent).toContain("your world is unchanged");
  });

  it("keeps the setup form on a create-time refusal with a link CTA", async () => {
    prepare();
    const entitled = {
      linked: true,
      displayName: "Ada",
      supporter: false,
      singleplayer: { entitled: true, expiresAt: null },
    };
    mocks.online.account
      .mockResolvedValueOnce(entitled)
      .mockResolvedValueOnce(entitled)
      .mockResolvedValue({
        linked: true,
        displayName: "Ada",
        supporter: false,
        singleplayer: { entitled: false, expiresAt: null },
      });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "New world" }));
    // Entry gate passed while entitled: the setup form opens.
    await userEvent.click(await screen.findByRole("button", { name: "Create" }));
    // Access revoked before creation: the form stays mounted with a link CTA.
    expect((await screen.findByRole("alert")).textContent).toContain(
      "not enabled",
    );
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
    expect(mocks.game.start).not.toHaveBeenCalled();
    expect(mocks.worlds.create).not.toHaveBeenCalled();
  });
});
