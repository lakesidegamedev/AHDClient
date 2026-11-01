/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  singleplayerStatus: vi.fn(),
  advanceTurn: vi.fn(),
  advanceWorldsim: vi.fn(),
  worldAvailability: vi.fn(),
  setWorldAvailability: vi.fn(),
}));

vi.mock("./worlds.js", () => ({
  game: {
    singleplayerStatus: mocks.singleplayerStatus,
    advanceTurn: mocks.advanceTurn,
    advanceWorldsim: mocks.advanceWorldsim,
    worldAvailability: mocks.worldAvailability,
    setWorldAvailability: mocks.setWorldAvailability,
  },
}));

import { GameToolbar } from "./GameToolbar.js";

const base = {
  worldName: "Cold War dawn, 1953",
  onLauncher: vi.fn(),
  onSaveAndStop: vi.fn(),
  onOpenSaves: vi.fn(),
  onOpenAsk: vi.fn(),
};

function prepare(status: unknown, availability: "open" | "sealed" = "open") {
  mocks.singleplayerStatus.mockResolvedValue(status);
  mocks.advanceTurn.mockResolvedValue({ success: true, turn: 2, message: "Turn 2" });
  mocks.advanceWorldsim.mockResolvedValue({ success: true, turn: 41 });
  mocks.worldAvailability.mockResolvedValue({ availability, mode: availability === "open" ? "off" : "full" });
  mocks.setWorldAvailability.mockImplementation(async (next: "open" | "sealed") =>
    ({ availability: next, mode: next === "open" ? "off" : "full" }),
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GameToolbar", () => {
  it("locks End turn until the game reports a character", async () => {
    prepare({ hasWorld: true, turn: 1, hasCharacter: false, characterName: null, mode: "normal" });
    render(<GameToolbar {...base} worldsim={false} />);

    const button = screen.getByRole("button", { name: "End turn" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(button.getAttribute("title")).toMatch(/Create a character/));
    expect(mocks.advanceTurn).not.toHaveBeenCalled();
  });

  it("advances the turn once a character exists and reports the new turn", async () => {
    prepare({ hasWorld: true, turn: 1, hasCharacter: true, characterName: "Ada", mode: "normal" });
    const onTurnAdvanced = vi.fn();
    render(<GameToolbar {...base} worldsim={false} onTurnAdvanced={onTurnAdvanced} />);

    const button = await screen.findByRole("button", { name: "End turn" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(button);
    await waitFor(() => expect(mocks.advanceTurn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onTurnAdvanced).toHaveBeenCalledWith(2));
    expect(mocks.singleplayerStatus).toHaveBeenCalledTimes(2);
  });

  it("surfaces turn failures without losing the toolbar", async () => {
    prepare({ hasWorld: true, turn: 1, hasCharacter: true, characterName: "Ada", mode: "normal" });
    mocks.advanceTurn.mockRejectedValue(new Error("turn exploded"));
    render(<GameToolbar {...base} worldsim={false} />);

    const button = await screen.findByRole("button", { name: "End turn" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("turn exploded");
  });

  it("shows native turn progress until singleplayer advancement finishes", async () => {
    prepare({ hasWorld: true, turn: 1, hasCharacter: true, characterName: "Ada", mode: "normal" });
    let finishTurn!: (result: { success: boolean; turn: number; message: string }) => void;
    mocks.advanceTurn.mockReturnValue(new Promise((resolve) => { finishTurn = resolve; }));
    render(<GameToolbar {...base} worldsim={false} />);
    const button = screen.getByRole("button", { name: "End turn" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(button);
    expect(screen.getByRole("status", { name: "Running turn" })).toBeTruthy();
    expect(screen.getByText("Turn 1", { selector: ".client-toolbar-turn" })).toBeTruthy();
    finishTurn({ success: true, turn: 2, message: "Turn 2" });
    await waitFor(() => expect(screen.queryByRole("status", { name: "Running turn" })).toBeNull());
  });

  it("enables End turn for worldsim without a character and advances one turn", async () => {
    prepare({ hasWorld: true, turn: 40, hasCharacter: false, characterName: null, mode: "worldsim" });
    const onViewStats = vi.fn();
    const onTurnAdvanced = vi.fn();
    render(<GameToolbar {...base} worldsim onViewStats={onViewStats} onTurnAdvanced={onTurnAdvanced} />);

    const button = await screen.findByRole("button", { name: "End turn" });
    // No character gate for the playerless simulation.
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(button);
    await waitFor(() => expect(mocks.advanceWorldsim).toHaveBeenCalledTimes(1));
    expect(mocks.advanceTurn).not.toHaveBeenCalled();
    await waitFor(() => expect(onTurnAdvanced).toHaveBeenCalledWith(41));
    await userEvent.click(screen.getByRole("button", { name: "World statistics" }));
    expect(onViewStats).toHaveBeenCalledTimes(1);
  });

  it("reports a turn advance when the in-game End turn changes the polled turn", async () => {
    vi.useFakeTimers();
    try {
      const onTurnAdvanced = vi.fn();
      prepare({ hasWorld: true, turn: 5, hasCharacter: true, characterName: "Ada", mode: "normal" });
      render(<GameToolbar {...base} worldsim={false} onTurnAdvanced={onTurnAdvanced} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      mocks.singleplayerStatus.mockResolvedValue(
        { hasWorld: true, turn: 6, hasCharacter: true, characterName: "Ada", mode: "normal" },
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(onTurnAdvanced).toHaveBeenCalledWith(6);
      expect(mocks.advanceTurn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes turn state on a timer when a character appears", async () => {
    // findBy* deadlocks under fake timers (its polling never advances), so
    // drive the clock by hand and use synchronous queries throughout.
    vi.useFakeTimers();
    try {
      prepare({ hasWorld: true, turn: 1, hasCharacter: false, characterName: null, mode: "normal" });
      render(<GameToolbar {...base} worldsim={false} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const button = screen.getByRole("button", { name: "End turn" });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      // Character creation happens in the child webview with no focus event.
      mocks.singleplayerStatus.mockResolvedValue(
        { hasWorld: true, turn: 1, hasCharacter: true, characterName: "Ada", mode: "normal" },
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect((button as HTMLButtonElement).disabled).toBe(false);
      expect(mocks.singleplayerStatus.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling after a character exists, so death or retirement locks End turn again", async () => {
    vi.useFakeTimers();
    try {
      prepare({ hasWorld: true, turn: 1, hasCharacter: true, characterName: "Ada", mode: "normal" });
      render(<GameToolbar {...base} worldsim={false} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const button = screen.getByRole("button", { name: "End turn" });
      expect((button as HTMLButtonElement).disabled).toBe(false);
      const reads = mocks.singleplayerStatus.mock.calls.length;
      // The character dies or retires inside the child webview.
      mocks.singleplayerStatus.mockResolvedValue(
        { hasWorld: true, turn: 2, hasCharacter: false, characterName: null, mode: "normal" },
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(mocks.singleplayerStatus.mock.calls.length).toBeGreaterThan(reads);
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect(button.getAttribute("title")).toMatch(/Create a character/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables End turn while paused for both normal and worldsim play", async () => {
    prepare({ hasWorld: true, turn: 1, hasCharacter: true, characterName: "Ada", mode: "normal" }, "sealed");
    const { unmount } = render(<GameToolbar {...base} worldsim={false} />);
    const button = await screen.findByRole("button", { name: "End turn" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    expect(button.getAttribute("title")).toMatch(/Resume the world/);
    unmount();

    prepare({ hasWorld: true, turn: 40, hasCharacter: false, characterName: null, mode: "worldsim" }, "sealed");
    render(<GameToolbar {...base} worldsim />);
    const simButton = await screen.findByRole("button", { name: "End turn" });
    await waitFor(() => expect((simButton as HTMLButtonElement).disabled).toBe(true));
  });

  it("disables End turn until the first status read lands", async () => {
    mocks.singleplayerStatus.mockReturnValue(new Promise(() => {}));
    mocks.worldAvailability.mockResolvedValue({ availability: "open", mode: "off" });
    mocks.setWorldAvailability.mockImplementation(async (next: "open" | "sealed") =>
      ({ availability: next, mode: "off" }),
    );
    render(<GameToolbar {...base} worldsim />);
    const button = screen.getByRole("button", { name: "End turn" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("title")).toMatch(/Checking/);
  });

  it("marks permanent head of state with a Beta chip", async () => {
    prepare({ hasWorld: true, turn: 1, hasCharacter: true, characterName: "Ada", mode: "head-of-state" });
    render(<GameToolbar {...base} worldsim={false} />);
    expect(await screen.findByText(/Head of state/)).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
  });

  it("pauses and resumes the world from the overflow menu", async () => {
    prepare({ hasWorld: true, turn: 1, hasCharacter: true, characterName: "Ada", mode: "normal" });
    render(<GameToolbar {...base} worldsim={false} />);

    const overflow = [...document.querySelectorAll<HTMLButtonElement>(".client-toolbar-overflow [role='menuitem']")];
    const pause = overflow.find((button) => button.textContent === "Pause world");
    expect(pause).toBeTruthy();
    await userEvent.click(pause!);
    await waitFor(() => expect(mocks.setWorldAvailability).toHaveBeenCalledWith("sealed"));
    expect(await screen.findByText("Paused")).toBeTruthy();

    const resumed = [...document.querySelectorAll<HTMLButtonElement>(".client-toolbar-overflow [role='menuitem']")];
    await userEvent.click(resumed.find((button) => button.textContent === "Resume world")!);
    await waitFor(() => expect(mocks.setWorldAvailability).toHaveBeenCalledWith("open"));
    await waitFor(() => expect(screen.queryByText("Paused")).toBeNull());
  });

  it("marks the toolbar paused when the world starts sealed", async () => {
    prepare({ hasWorld: true, turn: 1, hasCharacter: true, characterName: "Ada", mode: "normal" }, "sealed");
    render(<GameToolbar {...base} worldsim={false} />);

    expect(await screen.findByText("Paused")).toBeTruthy();
  });

  it("leaves identity to the game below and shows no account chip", async () => {
    prepare({ hasWorld: true, turn: 1, hasCharacter: true, characterName: "Ada", mode: "normal" });
    render(<GameToolbar {...base} worldsim={false} />);

    expect(document.querySelector(".client-toolbar-identity")).toBeNull();
    expect(screen.queryByText("Admin")).toBeNull();
  });

  it("keeps End turn beside Launcher and the world name clear", async () => {
    prepare({ hasWorld: true, turn: 1, hasCharacter: true, characterName: "Ada", mode: "normal" });
    render(<GameToolbar {...base} worldsim={false} />);

    const nav = screen.getByRole("navigation", { name: "Client controls" });
    const order = [...nav.querySelectorAll(":scope > button, :scope > strong")]
      .map((node) => node.textContent);
    expect(order[0]).toBe("Launcher");
    expect(order[1]).toMatch(/End turn|Running turn/);
    expect(order[2]).toBe("Ask");
    expect(order[3]).toBe("Cold War dawn, 1953");
    expect(nav.querySelector("strong")?.getAttribute("title")).toBe(
      "Cold War dawn, 1953",
    );
  });

  it("keeps overflow actions behind More, pause first, without PiP or duplicates", async () => {
    prepare({ hasWorld: true, turn: 1, hasCharacter: true, characterName: "Ada", mode: "normal" });
    const handlers = {
      onSaveAndStop: vi.fn(),
      onOpenSaves: vi.fn(),
    };
    render(<GameToolbar {...base} {...handlers} worldsim={false} />);

    // Closed <details> content stays out of the accessibility tree, so reach
    // the overflow items through the DOM instead of role queries.
    const overflow = [...document.querySelectorAll<HTMLButtonElement>(".client-toolbar-overflow [role='menuitem']")];
    // No picture-in-picture here: that is the multiplayer briefing, and this
    // bar only ever fronts the local game. No Settings or Diagnostics either:
    // the game below owns settings, and both dialogs stay reachable through
    // the launcher and the Escape shortcut.
    expect(overflow.map((button) => button.textContent)).toEqual([
      "Pause world",
      "Saves",
      "Save and stop",
    ]);
    fireEvent.click(overflow[1]!);
    expect(handlers.onOpenSaves).toHaveBeenCalledTimes(1);
    fireEvent.click(overflow[2]!);
    expect(handlers.onSaveAndStop).toHaveBeenCalledTimes(1);
  });

  it("opens the Ask panel from the top bar without touching the turn", async () => {
    prepare({ hasWorld: true, turn: 1, hasCharacter: true, characterName: "Ada", mode: "normal" });
    const onOpenAsk = vi.fn();
    render(<GameToolbar {...base} onOpenAsk={onOpenAsk} worldsim={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Ask about the game" }));
    expect(onOpenAsk).toHaveBeenCalledTimes(1);
    expect(mocks.advanceTurn).not.toHaveBeenCalled();
  });
});
