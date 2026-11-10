/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), install: vi.fn(), select: vi.fn(), bundledInfo: vi.fn() }));

vi.mock("./worlds.js", () => ({ gameVersions: { list: mocks.list, install: mocks.install, select: mocks.select } }));
vi.mock("./capabilities.js", () => ({ gameRuntime: { bundledInfo: mocks.bundledInfo } }));

import { GameVersionLine, GameVersionSetting } from "./GameVersionBar.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GameVersionLine", () => {
  it("shows the real version the game reports", async () => {
    mocks.bundledInfo.mockResolvedValue({ gameVersion: "1.20.0", gameCommit: null, clientVersion: null });
    render(<GameVersionLine />);
    expect(await screen.findByText("Game 1.20.0")).toBeTruthy();
  });

  it("shows nothing when the version is unknown", async () => {
    mocks.bundledInfo.mockResolvedValue({ gameVersion: null, gameCommit: null, clientVersion: null });
    const { container } = render(<GameVersionLine />);
    await waitFor(() => expect(mocks.bundledInfo).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});

describe("GameVersionSetting", () => {
  it("lists other versions with their size and never installs or selects on its own", async () => {
    mocks.bundledInfo.mockResolvedValue({ gameVersion: "1.20.0", gameCommit: null, clientVersion: null });
    mocks.list.mockResolvedValue([
      { version: "1.20.0", installed: false, selected: false, sizeBytes: 90_000_000 },
      { version: "1.19.2", installed: false, selected: false, sizeBytes: 84_000_000 },
    ]);
    render(<GameVersionSetting />);

    expect(await screen.findByRole("option", { name: "1.19.2 · download 80 MB" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Included with the app (1.20.0)" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /^1\.20\.0/ })).toBeNull();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("keeps a newer published version out of the way until it is chosen, then installs and selects it", async () => {
    mocks.bundledInfo.mockResolvedValue({ gameVersion: "1.20.0", gameCommit: null, clientVersion: null });
    mocks.list.mockResolvedValue([{ version: "1.21.0", installed: false, selected: false, sizeBytes: null }]);
    mocks.install.mockResolvedValue(undefined);
    mocks.select.mockResolvedValue(undefined);
    render(<GameVersionSetting />);

    const picker = await screen.findByRole("combobox");
    await screen.findByRole("option", { name: "1.21.0 · download" });
    fireEvent.change(picker, { target: { value: "1.21.0" } });

    await waitFor(() => expect(mocks.install).toHaveBeenCalledWith("1.21.0"));
    expect(mocks.select).toHaveBeenCalledWith("1.21.0");
  });

  it("goes back to the included game with a null selection", async () => {
    mocks.bundledInfo.mockResolvedValue({ gameVersion: "1.19.2", gameCommit: null, clientVersion: null });
    mocks.list.mockResolvedValue([{ version: "1.19.2", installed: true, selected: true, sizeBytes: null }]);
    mocks.select.mockResolvedValue(undefined);
    render(<GameVersionSetting />);

    const picker = await screen.findByRole("combobox");
    await waitFor(() => expect((picker as HTMLSelectElement).value).toBe("1.19.2"));
    fireEvent.change(picker, { target: { value: "bundled" } });
    await waitFor(() => expect(mocks.select).toHaveBeenCalledWith(null));
  });

  it("says so when the list cannot be fetched", async () => {
    mocks.bundledInfo.mockResolvedValue({ gameVersion: "1.20.0", gameCommit: null, clientVersion: null });
    mocks.list.mockRejectedValue(new Error("offline"));
    render(<GameVersionSetting />);
    expect(await screen.findByText(/Could not check for other versions/)).toBeTruthy();
  });
});
