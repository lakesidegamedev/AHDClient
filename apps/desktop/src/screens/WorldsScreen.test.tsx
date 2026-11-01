/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorldsScreen } from "./WorldsScreen.js";

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
