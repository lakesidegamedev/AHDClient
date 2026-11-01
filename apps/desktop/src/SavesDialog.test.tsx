/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SaveMeta } from "./worlds.js";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
  saveNow: vi.fn(),
  saves: vi.fn(),
}));

vi.mock("./worlds.js", () => ({
  worldSaves: { list: mocks.list, remove: mocks.remove },
  game: { saveNow: mocks.saveNow, saves: mocks.saves },
}));

import { SavesDialog, formatSize } from "./SavesDialog.js";

const save = (patch: Partial<SaveMeta>): SaveMeta => ({
  id: "20261101T120000Z-aaaaaa",
  kind: "manual",
  name: "Before the vote",
  turn: 12,
  preset: "1991-default",
  mode: "normal",
  characterName: "Ada",
  createdAt: "2026-11-01T12:00:00.000Z",
  sizeBytes: 9_700_000,
  ...patch,
});

beforeEach(() => {
  mocks.list.mockResolvedValue([
    save({}),
    save({ id: "20261101T110000Z-bbbbbb", kind: "auto", name: "Autosave, turn 11", turn: 11 }),
  ]);
  mocks.saves.mockResolvedValue({ autosaveError: null });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function open(props: Partial<React.ComponentProps<typeof SavesDialog>> = {}) {
  const onLoad = vi.fn().mockResolvedValue(undefined);
  render(<SavesDialog slot="w1" worldName="Cold War" running onLoad={onLoad} onClose={vi.fn()} {...props} />);
  return { onLoad };
}

describe("SavesDialog", () => {
  it("lists saves with their kind, turn and size", async () => {
    open();
    expect(await screen.findByText("Before the vote")).toBeTruthy();
    expect(screen.getByText("Autosave, turn 11")).toBeTruthy();
    expect(screen.getByText(/Autosave · turn 11/)).toBeTruthy();
    expect(screen.getAllByText(/9\.3 MB/)).toHaveLength(2);
  });

  it("saves the running world under the typed name and refreshes the list", async () => {
    mocks.saveNow.mockResolvedValue({ save: save({}) });
    open();
    await screen.findByText("Before the vote");
    await userEvent.type(screen.getByLabelText("Save name"), "  Day one ");
    await userEvent.click(screen.getByRole("button", { name: "Save now" }));
    await waitFor(() => expect(mocks.saveNow).toHaveBeenCalledWith("Day one"));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  });

  it("cannot save while the world is stopped, but still lists and offers load", async () => {
    open({ running: false });
    await screen.findByText("Before the vote");
    expect(screen.queryByRole("button", { name: "Save now" })).toBeNull();
    expect(screen.getByText(/Open the world to save it/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Load" })).toHaveLength(2);
  });

  it("asks before loading and says the current state is kept", async () => {
    const { onLoad } = open();
    await screen.findByText("Before the vote");
    await userEvent.click(screen.getAllByRole("button", { name: "Load" })[0]!);
    expect(screen.getByText(/Go back to turn 12\? Where you are now is kept as a save first/)).toBeTruthy();
    expect(onLoad).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Load it" }));
    await waitFor(() => expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({ id: "20261101T120000Z-aaaaaa" })));
  });

  it("asks before deleting, and a keep changes nothing", async () => {
    mocks.remove.mockResolvedValue(undefined);
    open();
    await screen.findByText("Before the vote");
    await userEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(mocks.remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
    const row = screen.getByText("Delete this save for good?").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("w1", "20261101T120000Z-aaaaaa"));
  });

  it("shows why the last autosave failed and surfaces a refused save", async () => {
    mocks.saves.mockResolvedValue({ autosaveError: "There is not enough disk space." });
    mocks.saveNow.mockRejectedValue(new Error("A turn is running. Save again when it finishes."));
    open();
    expect(await screen.findByText(/last autosave did not work: There is not enough disk space/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Save now" }));
    expect(await screen.findByText("A turn is running. Save again when it finishes.")).toBeTruthy();
  });

  it("shows a failed load and lets the player try again", async () => {
    const { onLoad } = open();
    onLoad.mockRejectedValueOnce(new Error("Resume the world first."));
    await screen.findByText("Before the vote");
    await userEvent.click(screen.getAllByRole("button", { name: "Load" })[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Load it" }));
    expect(await screen.findByText("Resume the world first.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Load" }).length).toBeGreaterThan(0);
  });

  it("formats sizes plainly", () => {
    expect(formatSize(200)).toBe("1 KB");
    expect(formatSize(512 * 1024)).toBe("512 KB");
    expect(formatSize(9_700_000)).toBe("9.3 MB");
    expect(formatSize(120 * 1024 * 1024)).toBe("120 MB");
  });
});
