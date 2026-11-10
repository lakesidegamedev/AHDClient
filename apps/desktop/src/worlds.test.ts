import { describe, expect, it } from "vitest";
import { ERAS, eraById, eraForPreset, slugForWorld, uniqueWorldName } from "./worlds.js";

describe("eras", () => {
  it("includes the incoming 2027 game seed", () => {
    expect(eraById("2027")?.preset).toBe("2027-default");
  });
  it("map one to one onto AHDGame reset presets, oldest first", () => {
    expect(ERAS.map((e) => e.preset)).toEqual([
      "1953-default",
      "1979-default",
      "1991-default",
      "1999-default",
      "2007-default",
      "2019-default",
      "2023-default",
      "2027-default",
    ]);
    expect(eraById("1979")?.preset).toBe("1979-default");
    expect(eraForPreset("2019-default")?.id).toBe("2019");
    expect(eraForPreset("empty")).toBeUndefined();
  });
});

describe("slugForWorld", () => {
  it("turns a display name into a directory-safe slot", () => {
    expect(slugForWorld("Cold War, 1953", [])).toBe("cold-war-1953");
    expect(slugForWorld("  ...  ", [])).toBe("world");
    expect(slugForWorld("Ünïcode name", [])).toBe("u-ni-code-name");
  });

  it("never collides with an existing slot", () => {
    expect(slugForWorld("Cold War", ["cold-war"])).toBe("cold-war-2");
    expect(slugForWorld("Cold War", ["cold-war", "cold-war-2"])).toBe("cold-war-3");
  });

  it("keeps slots short enough for any filesystem", () => {
    expect(slugForWorld("x".repeat(200), []).length).toBeLessThanOrEqual(48);
  });
});

describe("uniqueWorldName", () => {
  it("keeps a free name", () => {
    expect(uniqueWorldName("2027", [])).toBe("2027");
  });
  it("numbers a taken name, ignoring case", () => {
    expect(uniqueWorldName("2027", ["2027"])).toBe("2027 2");
    expect(uniqueWorldName("2027", ["2027", "2027 2"])).toBe("2027 3");
    expect(uniqueWorldName("Cold War", ["cold war"])).toBe("Cold War 2");
  });
});
