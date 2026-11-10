/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewWorldScreen } from "./NewWorldScreen.js";
import type { Era } from "../worlds.js";
import { SETUP_OPTIONS_STORAGE_KEY } from "./setupOptions.js";
import { resolveCapabilities } from "../capabilities.js";

vi.mock("../launcher/CommandGlobe.js", () => ({ themeForEra: () => ({ phosphor: "#0f0" }) }));

const era: Era = { id: "1953", preset: "1953-default", label: "1953", subtitle: "Cold War dawn", startDate: "January 1953" };

describe("NewWorldScreen", () => {
  afterEach(() => {
    cleanup();
    localStorage.removeItem(SETUP_OPTIONS_STORAGE_KEY);
  });

  it("submits the normal setup with authored defaults", async () => {
    const onCreate = vi.fn();
    render(<NewWorldScreen era={era} taken={[]} onBack={vi.fn()} onCreate={onCreate} />);

    await userEvent.click(screen.getByRole("button", { name: /Create and play/ }));
    expect(onCreate).toHaveBeenCalledWith("Cold War dawn, 1953", "", expect.objectContaining({
      mode: "normal", difficulty: "normal", autonomyLevel: "v6",
    }));
    expect(onCreate.mock.calls[0]?.[2].featureFlags).toMatchObject({ forexEnabled: true, autoSectorSeedEnabled: false, nppCorpStrategyEnabled: true });
  });

  it("supports permanent head of state and every real difficulty", async () => {
    const onCreate = vi.fn();
    const { container } = render(<NewWorldScreen era={era} taken={[]} onBack={vi.fn()} onCreate={onCreate} />);

    await userEvent.click(screen.getByRole("radio", { name: /Permanent head of state/ }));
    await userEvent.selectOptions(screen.getByLabelText("Difficulty"), "hard");
    // Older tiers live under disclosure (outside the accessibility tree while
    // closed), so reach the input through the DOM.
    fireEvent.click(container.querySelector('input[name="autonomy"][value="v3"]')!);
    await userEvent.click(screen.getByRole("button", { name: /Create and play/ }));

    expect(onCreate.mock.calls[0]?.[2]).toMatchObject({ mode: "head-of-state", difficulty: "hard", autonomyLevel: "v3" });
    expect(screen.getByRole("option", { name: /Easy/ })).toBeTruthy();
    // Only tiers the game's setup route accepts are offered. v6 is now one of
    // them; v7 is the guard that this list is not just "whatever we typed".
    expect(screen.queryByRole("radio", { name: /v7/i })).toBeNull();
  });

  it("defaults to v6 and still offers and submits v5", async () => {
    const onCreate = vi.fn();
    render(<NewWorldScreen era={era} taken={[]} onBack={vi.fn()} onCreate={onCreate} />);

    expect((screen.getByRole("radio", { name: /V6/ }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: /V5/ }));
    await userEvent.click(screen.getByRole("button", { name: /Create and play/ }));
    expect(onCreate.mock.calls[0]?.[2]).toMatchObject({ autonomyLevel: "v5" });
  });

  it("restores a stored v5 preference instead of silently downgrading it", async () => {
    const onCreate = vi.fn();
    localStorage.setItem(
      SETUP_OPTIONS_STORAGE_KEY,
      JSON.stringify({ mode: "normal", difficulty: "normal", autonomyLevel: "v5", featureFlags: {} })
    );
    render(<NewWorldScreen era={era} taken={[]} onBack={vi.fn()} onCreate={onCreate} />);
    expect((screen.getByRole("radio", { name: /V5/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("describes v0 through v3 as one sentence of activities each", () => {
    render(<NewWorldScreen era={era} taken={[]} onBack={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByText(/Chair elections, stalled prime minister cover/)).toBeTruthy();
    expect(screen.getByText(/governing brain in non-player countries/)).toBeTruthy();
    expect(screen.getByText(/into player countries and player-owned companies/)).toBeTruthy();
    expect(screen.getByText(/campaign, fundraise, run for and win office/)).toBeTruthy();
  });

  it("keeps older tiers under disclosure with v6 recommended up front", () => {
    const { container } = render(<NewWorldScreen era={era} taken={[]} onBack={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /V6.*Recommended/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^V4/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /V5/ })).toBeTruthy();
    const disclosure = screen.getByText("Older autonomy tiers").closest("details")!;
    expect(disclosure.querySelector('input[value="v0"]')).toBeTruthy();
    expect(disclosure.querySelector('input[value="off"]')).toBeTruthy();
    const v0 = container.querySelector('input[name="autonomy"][value="v0"]') as HTMLInputElement;
    fireEvent.click(v0);
    expect(v0.checked).toBe(true);
  });

  /**
   * Autonomy is what the politicians may do; difficulty is how well they do it.
   * The resource advantage is stated as a resource advantage, never dressed up
   * as skill.
   */
  it("tells the player which axis is which, and discloses the resource bonus", () => {
    render(<NewWorldScreen era={era} taken={[]} onBack={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByText(/allowed to do\. Each step adds activities, not skill/)).toBeTruthy();
    expect(screen.getByText(/never changes what they are allowed to do/)).toBeTruthy();
    expect(screen.getByText(/same action points and funding as you do/)).toBeTruthy();
  });

  it("opens singleplayer setup on Normal even when Worldsim was stored last", async () => {
    const onCreate = vi.fn();
    localStorage.setItem(
      SETUP_OPTIONS_STORAGE_KEY,
      JSON.stringify({ mode: "worldsim", difficulty: "normal", autonomyLevel: "v4", featureFlags: {} })
    );
    render(<NewWorldScreen era={era} taken={[]} onBack={vi.fn()} onCreate={onCreate} />);
    expect((screen.getByRole("radio", { name: /^Normal/ }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: /Create and play/ }));
    expect(onCreate.mock.calls[0]?.[2]).toMatchObject({ mode: "normal" });
  });

  it("starts worldsim mode when requested and does not show a character field", () => {
    render(<NewWorldScreen era={era} taken={[]} onBack={vi.fn()} onCreate={vi.fn()} initialWorldsim />);

    expect((screen.getByRole("radio", { name: /Worldsim/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText(/Your name/)).toBeNull();
    expect(screen.getByText(/does not create a character/)).toBeTruthy();
  });

  it("keeps anonymous statistics consent controlled and reports opt out", async () => {
    const onStatisticsChange = vi.fn();
    render(<NewWorldScreen era={era} taken={[]} onBack={vi.fn()} onCreate={vi.fn()} shareStatistics onStatisticsChange={onStatisticsChange} />);

    const checkbox = screen.getByRole("checkbox", { name: /Share anonymous setup statistics/ });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    await userEvent.click(checkbox);
    expect(onStatisticsChange).toHaveBeenCalledWith(false);
  });

  it("persists feature choices and restores only valid values", async () => {
    const first = vi.fn();
    const { unmount } = render(<NewWorldScreen era={era} taken={[]} onBack={vi.fn()} onCreate={first} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /Foreign exchange/ }));
    unmount();
    render(<NewWorldScreen era={era} taken={[]} onBack={vi.fn()} onCreate={first} />);
    expect((screen.getByRole("checkbox", { name: /Foreign exchange/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("marks head of state Beta with a real explanation of the trade", () => {
    render(<NewWorldScreen era={era} taken={[]} onBack={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /Permanent head of state.*Beta/ })).toBeTruthy();
    expect(screen.getByText(/remain head of state\. You do not play the normal climb/)).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Normal/ })).toBeTruthy();
  });

  it("labels v4 as the live standard and keeps v5 goal follow-through", async () => {
    render(<NewWorldScreen era={era} taken={[]} onBack={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByText(/what the live multiplayer world runs/)).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: /V5/ }));
    expect(screen.getByText(/Governments hold long-term goals and follow through/)).toBeTruthy();
  });

  it("keeps difficulty labels short with the sentences beside them", () => {
    render(<NewWorldScreen era={era} taken={[]} onBack={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getAllByRole("option").map((option) => option.textContent))
      .toEqual(["Easy", "Normal", "Hard"]);
  });

  it("hides the onboarding checklist in worldsim with a note, but still sends it", async () => {
    const onCreate = vi.fn();
    render(<NewWorldScreen era={era} taken={[]} onBack={vi.fn()} onCreate={onCreate} initialWorldsim />);
    expect(screen.queryByRole("checkbox", { name: /Onboarding checklist/ })).toBeNull();
    expect(screen.getByText(/no player to onboard/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Create and play/ }));
    expect(onCreate.mock.calls[0]?.[2].featureFlags).toMatchObject({ onboardingChecklistEnabled: true });
  });

  it("keeps the form mounted on an entitlement refusal with a link CTA", async () => {
    const onLinkAccount = vi.fn();
    render(
      <NewWorldScreen
        era={era}
        taken={[]}
        onBack={vi.fn()}
        onCreate={vi.fn()}
        error="Link an entitled game account to use singleplayer."
        onLinkAccount={onLinkAccount}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Link an entitled game account");
    // The setup the player entered is still there, not discarded.
    expect((screen.getByLabelText(/World name/) as HTMLInputElement).value).toContain("1953");
    await userEvent.click(screen.getByRole("button", { name: "Link account" }));
    expect(onLinkAccount).toHaveBeenCalledTimes(1);
  });

  it("only offers flags the bundled game implements", async () => {
    const { FEATURE_OPTIONS } = await import("./featureOptions.js");
    // The exact boolean keys of the game's DEFAULT_GAME_STATE_FLAGS. A flag
    // added here without a bundled-game reader is a dead toggle; a reader
    // added there without a toggle here is a hidden setting. Sort both sides:
    // this guards the set, not the display order.
    const bundled = [
      "forexEnabled", "playerRandomEventsEnabled", "crisisInteractionEnabled",
      "autoDisastersEnabled", "crisisAidBillsEnabled", "rpgStatsEnabled",
      "autoSectorSeedEnabled", "sectorTechTreesEnabled", "onboardingChecklistEnabled",
      "worldEventsEnabled", "legislationDemographicEffectsV2Enabled", "granularPollEnabled",
      "demographicsLayer1PositionsEnabled", "eraSystemEnabled", "conflictsEnabled",
      "coldWarEnabled", "redistrictingEnabled", "subsidiaryCorporationsEnabled",
      "embargoTradeExposureEnabled", "liveElectionResultsEnabled", "extractionAutoStrategyEnabled",
      "seasonRecapEnabled", "corpDealsEnabled", "intOrgAlignmentEnabled",
      "nppCorpStrategyEnabled", "livingConflictsEnabled", "nppOffensiveInitiationEnabled",
      "nppOffensiveJoinEnabled",
    ];
    expect(FEATURE_OPTIONS.map((option) => option.key).sort()).toEqual([...bundled].sort());
  });
});

describe("NewWorldScreen with a runtime manifest", () => {
  afterEach(() => {
    cleanup();
    localStorage.removeItem(SETUP_OPTIONS_STORAGE_KEY);
  });

  const caps = resolveCapabilities({
    schemaVersion: 1,
    defaultPreset: "2027-default",
    presets: [{ preset: "1953-default", era: "1953", seedable: true, playerCountries: [{ id: "US", name: "United States" }], computerCountries: [], backgroundCountries: [] }],
    modes: ["normal", "head-of-state"],
    difficulties: ["normal"],
    autonomyLevels: ["v5", "v6"],
    defaultAutonomyLevel: "v6",
    featureFlags: [{ key: "forexEnabled", label: "Foreign exchange", description: "Currency.", defaultEnabled: true }],
  });

  it("sends only keys the runtime knows and drops stale stored ones", async () => {
    localStorage.setItem(SETUP_OPTIONS_STORAGE_KEY, JSON.stringify({ mode: "worldsim", difficulty: "hard", autonomyLevel: "v3", featureFlags: { forexEnabled: false, coldWarEnabled: true } }));
    const onCreate = vi.fn();
    render(<NewWorldScreen era={era} capabilities={caps} taken={[]} onBack={vi.fn()} onCreate={onCreate} />);
    expect(screen.queryByRole("radio", { name: /Worldsim/ })).toBeNull();
    expect(screen.getByRole("radio", { name: /Start as President of the United States/ })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Create and play/ }));
    expect(onCreate.mock.calls[0]?.[2]).toEqual({ mode: "normal", difficulty: "normal", autonomyLevel: "v6", featureFlags: { forexEnabled: false } });
  });
});
