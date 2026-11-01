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
  startBatch: vi.fn(),
  batchStatus: vi.fn(),
  stopBatch: vi.fn(),
}));

vi.mock("./worlds.js", () => ({
  game: {
    singleplayerStatus: mocks.singleplayerStatus,
    advanceTurn: mocks.advanceTurn,
    advanceWorldsim: mocks.advanceWorldsim,
    worldAvailability: mocks.worldAvailability,
    setWorldAvailability: mocks.setWorldAvailability,
    startBatch: mocks.startBatch,
    batchStatus: mocks.batchStatus,
    stopBatch: mocks.stopBatch,
  },
}));

import { GameToolbar } from "./GameToolbar.js";

const base = {
  worldName: "Cold War dawn, 1953",
  onLauncher: vi.fn(),
  onSaveAndStop: vi.fn(),
  onOpenAsk: vi.fn(),
};

function prepare(status: unknown, availability: "open" | "sealed" = "open") {
  mocks.singleplayerStatus.mockResolvedValue(status);
  mocks.advanceTurn.mockResolvedValue({ success: true, turn: 2, message: "Turn 2" });
  mocks.advanceWorldsim.mockResolvedValue({ success: true, turn: 41 });
  mocks.batchStatus.mockResolvedValue({ batch: null });
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
      "Save and stop",
    ]);
    fireEvent.click(overflow[1]!);
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

  describe("multi-turn advance", () => {
    const running = (completed: number) => ({
      id: "b1",
      status: "running" as const,
      requested: 5,
      completed,
      runningTurn: 10 + completed + 1,
      startTurn: 10,
      stopRequested: false,
      turns: Array.from({ length: completed }, (_, i) => ({
        turn: 11 + i,
        fundsDelta: 100,
        actionsDelta: 1,
        durationSeconds: 1,
      })),
      stop: null,
      digest: null,
    });
    const digest = {
      startTurn: 10,
      endTurn: 13,
      turnsPlayed: 3,
      funds: { before: 1000, after: 1750, delta: 750 },
      actions: { before: 10, after: 4, delta: -6 },
      office: { before: null, after: null },
      officesWon: [],
      officesLost: [],
      inbox: {
        total: 2,
        actionRequired: 1,
        groups: [{ category: "legislation", count: 2, actionRequired: 1, titles: ["Budget vote"] }],
      },
      worldEvents: [{ turn: 12, title: "New leader" }],
      warnings: [],
    };

    it("offers turn counts in a normal world and none in worldsim", async () => {
      prepare({ hasWorld: true, turn: 10, hasCharacter: true, characterName: "Ada", mode: "normal" });
      const { unmount } = render(<GameToolbar {...base} worldsim={false} />);
      const select = (await screen.findByRole("combobox", { name: "Turns to play" })) as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.value)).toEqual(["1", "3", "5", "10"]);
      unmount();
      prepare({ hasWorld: true, turn: 10, hasCharacter: false, characterName: null, mode: "worldsim" });
      render(<GameToolbar {...base} worldsim />);
      await screen.findByRole("button", { name: "End turn" });
      expect(screen.queryByRole("combobox", { name: "Turns to play" })).toBeNull();
    });

    it("keeps the single-turn path when the count is 1", async () => {
      prepare({ hasWorld: true, turn: 10, hasCharacter: true, characterName: "Ada", mode: "normal" });
      render(<GameToolbar {...base} worldsim={false} />);
      const button = await screen.findByRole("button", { name: "End turn" });
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
      await userEvent.click(button);
      await waitFor(() => expect(mocks.advanceTurn).toHaveBeenCalledTimes(1));
      expect(mocks.startBatch).not.toHaveBeenCalled();
    });

    it("runs a batch, shows turn k of N, and ends with the stop reason and summary", async () => {
      vi.useFakeTimers();
      try {
        const onTurnAdvanced = vi.fn();
        prepare({ hasWorld: true, turn: 10, hasCharacter: true, characterName: "Ada", mode: "normal" });
        mocks.startBatch.mockResolvedValue({ success: true, batch: running(0) });
        render(<GameToolbar {...base} worldsim={false} onTurnAdvanced={onTurnAdvanced} />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        fireEvent.change(screen.getByRole("combobox", { name: "Turns to play" }), { target: { value: "5" } });
        const button = screen.getByRole("button", { name: "End 5 turns" });
        await act(async () => {
          fireEvent.click(button);
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(mocks.startBatch).toHaveBeenCalledWith(5);
        expect(mocks.advanceTurn).not.toHaveBeenCalled();
        expect(screen.getByText("Turn 1 of 5")).toBeTruthy();

        mocks.batchStatus.mockResolvedValue({ batch: running(2) });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(screen.getByText("Turn 3 of 5")).toBeTruthy();
        expect(onTurnAdvanced).toHaveBeenCalledWith(11);
        expect(onTurnAdvanced).toHaveBeenCalledWith(12);

        mocks.batchStatus.mockResolvedValue({
          batch: {
            ...running(3),
            status: "finished",
            runningTurn: null,
            stop: { kind: "vote", message: "A vote is waiting for you.", turn: 13, details: ["Budget vote"] },
            digest,
          },
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(screen.queryByRole("status", { name: "Running turn" })).toBeNull();
        expect(screen.getByText("Played 3 of 5 turns. A vote is waiting for you.", { selector: "small" })).toBeTruthy();
        expect(screen.getByText(/Campaign funds \+750, actions -6/)).toBeTruthy();
        expect(screen.getByText(/Legislation: 2/)).toBeTruthy();
        expect(screen.getByText("Turn 12: New leader")).toBeTruthy();
        expect((screen.getByRole("button", { name: "End 5 turns" }) as HTMLButtonElement).disabled).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("lets the player stop after the current turn", async () => {
      vi.useFakeTimers();
      try {
        prepare({ hasWorld: true, turn: 10, hasCharacter: true, characterName: "Ada", mode: "normal" });
        mocks.startBatch.mockResolvedValue({ success: true, batch: running(1) });
        mocks.stopBatch.mockResolvedValue({ success: true, batch: { ...running(1), stopRequested: true } });
        render(<GameToolbar {...base} worldsim={false} />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        fireEvent.change(screen.getByRole("combobox", { name: "Turns to play" }), { target: { value: "5" } });
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "End 5 turns" }));
          await vi.advanceTimersByTimeAsync(0);
        });
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "Stop after this turn" }));
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(mocks.stopBatch).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("button", { name: "Stopping" })).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("shows the refusal when the game will not start a batch", async () => {
      vi.useFakeTimers();
      try {
        prepare({ hasWorld: true, turn: 10, hasCharacter: true, characterName: "Ada", mode: "normal" });
        mocks.startBatch.mockRejectedValue(new Error("Resume the world before ending a turn."));
        render(<GameToolbar {...base} worldsim={false} />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        fireEvent.change(screen.getByRole("combobox", { name: "Turns to play" }), { target: { value: "3" } });
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "End 3 turns" }));
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByRole("alert").textContent).toContain("Resume the world");
        expect((screen.getByRole("button", { name: "End 3 turns" }) as HTMLButtonElement).disabled).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("picks a running batch back up after the toolbar remounts", async () => {
      vi.useFakeTimers();
      try {
        prepare({ hasWorld: true, turn: 12, hasCharacter: true, characterName: "Ada", mode: "normal" });
        mocks.batchStatus.mockResolvedValue({ batch: running(2) });
        render(<GameToolbar {...base} worldsim={false} />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByText("Turn 3 of 5")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Stop after this turn" })).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
