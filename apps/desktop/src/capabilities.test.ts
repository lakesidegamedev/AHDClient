import { describe, expect, it } from "vitest";
import { legacyCapabilities, resolveCapabilities } from "./capabilities.js";
import { ERAS } from "./worlds.js";
import { FEATURE_OPTIONS } from "./screens/featureOptions.js";

// PROVISIONAL: this fixture is built from the G2 schema frozen in the 2.11 plan
// (section 4), not from a real game build. Replace it with the manifest the
// 1.20 game emits once G2 lands, and keep the shape assertions below.
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
