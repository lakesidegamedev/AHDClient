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
        <WorldsScreen worlds={[]} runningSlot={null} busy={false} error={null} onPlay={vi.fn()} onHost={vi.fn()} onDelete={vi.fn()} onSaves={vi.fn()} onBack={vi.fn()} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("heading", { name: "Deine Welten" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Zurück/ })).toBeTruthy();
  });
});
