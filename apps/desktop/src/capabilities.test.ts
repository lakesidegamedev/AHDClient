import { describe, expect, it } from "vitest";
import { classicCapabilities, legacyCapabilities, resolveCapabilities } from "./capabilities.js";
import { ERAS } from "./worlds.js";
import { FEATURE_OPTIONS } from "./screens/featureOptions.js";
import real120 from "./fixtures/singleplayer-capabilities-1.20.json";

// Hand-built manifest for edge cases. The real file the 1.20 game writes is
// fixtures/singleplayer-capabilities-1.20.json, tested at the bottom.
const manifest120 = {
  schemaVersion: 1,
  gameVersion: "1.20.0",
  rulesVersion: "1.0.0",
  defaultPreset: "2027-default",
  presets: [
    {
      preset: "2027-default",
      era: "2027",
      seedable: true,
      playerCountries: [{ id: "US", name: "United States" }],
      computerCountries: [{ id: "UK", name: "United Kingdom" }],
      backgroundCountries: [{ id: "IE", name: "Ireland" }],
    },
    { preset: "1953-default", era: "1953", seedable: false, playerCountries: [], computerCountries: [], backgroundCountries: [] },
  ],
  modes: ["normal", "head-of-state", "worldsim"],
  difficulties: ["easy", "normal", "hard"],
  autonomyLevels: ["off", "v0", "v1", "v2", "v3", "v4", "v5", "v6"],
  defaultAutonomyLevel: "v6",
  featureFlags: [{ key: "forexEnabled", label: "Foreign exchange", description: "Currency markets.", defaultEnabled: true }],
};

describe("legacyCapabilities", () => {
  it("is built from the client's era table and feature list", () => {
    const legacy = legacyCapabilities();
    expect(legacy.source).toBe("legacy");
    expect(legacy.presets.map((p) => p.preset)).toEqual(ERAS.map((e) => e.preset));
    expect(legacy.presets.every((p) => p.seedable)).toBe(true);
    expect(legacy.featureFlags.map((f) => f.key)).toEqual(FEATURE_OPTIONS.map((o) => o.key));
    expect(legacy.defaultAutonomyLevel).toBe("v6");
    expect(legacy.diagnostic).toBeNull();
  });
});

describe("resolveCapabilities", () => {
  it("uses the legacy table, quietly, when there is no manifest", () => {
    const caps = resolveCapabilities(null);
    expect(caps.source).toBe("legacy");
    expect(caps.diagnostic).toBeNull();
  });

  it("reads a 1.20 manifest", () => {
    const caps = resolveCapabilities(manifest120);
    expect(caps.source).toBe("manifest");
    expect(caps.gameVersion).toBe("1.20.0");
    expect(caps.defaultPreset).toBe("2027-default");
    expect(caps.presets.filter((p) => p.seedable).map((p) => p.preset)).toEqual(["2027-default"]);
    expect(caps.presets[0]!.playerCountries).toEqual([{ id: "US", name: "United States" }]);
    expect(caps.featureFlags).toHaveLength(1);
    expect(caps.diagnostic).toBeNull();
  });

  it("falls back to legacy with a diagnostic on an unknown schema version", () => {
    const caps = resolveCapabilities({ ...manifest120, schemaVersion: 2 });
    expect(caps.source).toBe("legacy");
    expect(caps.diagnostic).toContain("schema 2");
  });

  it("falls back to legacy with a diagnostic on a malformed manifest", () => {
    expect(resolveCapabilities({ ...manifest120, presets: "nope" }).diagnostic).toContain("malformed");
    expect(resolveCapabilities({ ...manifest120, modes: [1] }).source).toBe("legacy");
    expect(resolveCapabilities("text").diagnostic).toContain("not an object");
  });
});

describe("the manifest a real 1.20 game build writes", () => {
  it("offers only the 2027 world, played as the United States", () => {
    const caps = resolveCapabilities(real120);
    expect(caps.source).not.toBe("legacy");
    expect(caps.defaultPreset).toBe("2027-default");
    const seedable = caps.presets.filter((p) => p.seedable);
    expect(seedable.map((p) => p.preset)).toEqual(["2027-default"]);
    expect(seedable[0]!.playerCountries.map((c) => c.id)).toEqual(["US"]);
    expect(caps.featureFlags).toHaveLength(10);
  });
});

describe("runtimes older than autonomy v6", () => {
  it("never offers v6 to a pre-1.16 runtime that ships no manifest", () => {
    const old = resolveCapabilities({ legacy: true, gameVersion: "1.8.3" });
    expect(old.autonomyLevels).not.toContain("v6");
    expect(old.defaultAutonomyLevel).toBe("v5");
    expect(old.gameVersion).toBe("1.8.3");
  });

  it("keeps v6 for a 1.16+ runtime that ships no manifest", () => {
    const current = resolveCapabilities({ legacy: true, gameVersion: "1.19.0" });
    expect(current.autonomyLevels).toContain("v6");
    expect(current.defaultAutonomyLevel).toBe("v6");
  });

  it("offers a Classic world v6 only when its runtime is known to take it", () => {
    expect(classicCapabilities("1.8.3").defaultAutonomyLevel).toBe("v5");
    expect(classicCapabilities(null).defaultAutonomyLevel).toBe("v5");
    expect(classicCapabilities("1.19.0").defaultAutonomyLevel).toBe("v6");
  });
});
