/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorldsScreen } from "./WorldsScreen.js";
import { LanguageProvider } from "../i18n.js";

vi.mock("../launcher/CommandGlobe.js", () => ({
  themeForEra: () => ({ phosphor: "#0f0" }),
}));

afterEach(cleanup);

describe("WorldsScreen private hosting", () => {
  it("starts an existing world in host mode", async () => {
    const onHost = vi.fn();
    render(
      <WorldsScreen
        worlds={[{
          slot: "private-1953",
          name: "Private 1953",
          preset: "1953-default",
          createdAt: "2026-09-14T00:00:00Z",
          lastPlayedAt: "2026-09-14T00:00:00Z",
          turn: 1,
          character: null,
        }]}
        runningSlot={null}
        busy={false}
        error={null}
        onPlay={vi.fn()}
        onHost={onHost}
        onDelete={vi.fn()}
        onSaves={vi.fn()}
        onRename={vi.fn()}
        onExport={vi.fn()}
        onImport={vi.fn()}
        onTidy={vi.fn()}
        sizes={{}}
        notice={null}
        onBack={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Host" }));
    expect(onHost).toHaveBeenCalledWith("private-1953");
  });

  it("opens the saves for a world", async () => {
    const onSaves = vi.fn();
    render(
      <WorldsScreen
        worlds={[{
          slot: "private-1953",
          name: "Private 1953",
          preset: "1953-default",
          createdAt: "2026-09-14T00:00:00Z",
          lastPlayedAt: "2026-09-14T00:00:00Z",
          turn: 1,
          character: null,
        }]}
        runningSlot={null}
        busy={false}
        error={null}
        onPlay={vi.fn()}
        onHost={vi.fn()}
        onDelete={vi.fn()}
        onSaves={onSaves}
        onRename={vi.fn()} onExport={vi.fn()} onImport={vi.fn()} onTidy={vi.fn()} sizes={{}} notice={null} 
        onBack={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Saves" }));
    expect(onSaves).toHaveBeenCalledWith("private-1953");
  });
});

describe("WorldsScreen Classic tag", () => {
  const base = { preset: "1979-default", createdAt: "2026-09-14T00:00:00Z", lastPlayedAt: "2026-09-14T00:00:00Z", turn: 1, character: null };
  it("tags Classic worlds and only those", () => {
    render(
      <WorldsScreen
        worlds={[
          { ...base, slot: "old", name: "Old World", classic: true },
          { ...base, slot: "new", name: "New World", classic: false, gameVersion: "1.20.0" },
        ]}
        runningSlot={null}
        busy={false}
        error={null}
        onPlay={vi.fn()}
        onHost={vi.fn()}
        onDelete={vi.fn()}
        onSaves={vi.fn()}
        onRename={vi.fn()}
        onExport={vi.fn()}
        onImport={vi.fn()}
        onTidy={vi.fn()}
        sizes={{}}
        notice={null}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getAllByText("Classic")).toHaveLength(1);
    expect(screen.getByText("Old World").parentElement?.textContent).toContain("Classic");
  });
});

describe("WorldsScreen in German", () => {
  it("shows German copy when the language is German", () => {
    render(
      <LanguageProvider language="de">
        <WorldsScreen worlds={[]} runningSlot={null} busy={false} error={null} onPlay={vi.fn()} onHost={vi.fn()} onDelete={vi.fn()} onSaves={vi.fn()} onRename={vi.fn()} onExport={vi.fn()} onImport={vi.fn()} onTidy={vi.fn()} sizes={{}} notice={null} onBack={vi.fn()} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("heading", { name: "Deine Welten" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Zurück/ })).toBeTruthy();
  });
});

describe("WorldsScreen managing worlds", () => {
  const world = {
    slot: "cold-war",
    name: "Cold War",
    preset: "1953-default",
    createdAt: "2026-09-14T00:00:00Z",
    lastPlayedAt: "2026-09-14T00:00:00Z",
    turn: 1,
    character: null,
    classic: true,
  };
  const base = {
    worlds: [world],
    runningSlot: null,
    busy: false,
    error: null,
    onPlay: vi.fn(),
    onHost: vi.fn(),
    onDelete: vi.fn(),
    onSaves: vi.fn(),
    onTidy: vi.fn(),
    onBack: vi.fn(),
    notice: null,
  };

  it("shows size on disk and exports, imports and clears autosaves", async () => {
    const onExport = vi.fn();
    const onImport = vi.fn();
    const onTidy = vi.fn();
    render(
      <LanguageProvider language="en">
        <WorldsScreen {...base} onRename={vi.fn()} onExport={onExport} onImport={onImport} onTidy={onTidy} sizes={{ "cold-war": 5 * 1024 * 1024 }} />
      </LanguageProvider>,
    );
    expect(screen.getByText(/5\.0 MB/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(onExport).toHaveBeenCalledWith("cold-war");
    await userEvent.click(screen.getByRole("button", { name: "Import world" }));
    expect(onImport).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Clear old autosaves" }));
    expect(onTidy).toHaveBeenCalledWith("cold-war");
  });

  it("renames a world in place and closes on success", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    render(
      <LanguageProvider language="en">
        <WorldsScreen {...base} onRename={onRename} onExport={vi.fn()} onImport={vi.fn()} sizes={{}} />
      </LanguageProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("World name");
    await userEvent.clear(input);
    await userEvent.type(input, "Berlin Crisis");
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(onRename).toHaveBeenCalledWith("cold-war", "Berlin Crisis");
    await vi.waitFor(() => expect(screen.queryByLabelText("World name")).toBeNull());
  });

  it("will not export, rename or clear a running world", () => {
    render(
      <LanguageProvider language="en">
        <WorldsScreen {...base} runningSlot="cold-war" onRename={vi.fn()} onExport={vi.fn()} onImport={vi.fn()} sizes={{}} />
      </LanguageProvider>,
    );
    for (const name of ["Rename", "Export", "Clear old autosaves"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
