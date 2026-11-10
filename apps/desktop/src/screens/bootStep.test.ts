import { describe, expect, it } from "vitest";
import { bootStep, formatElapsed } from "./bootStep.js";

describe("bootStep", () => {
  it("says nothing before the game reports anything", () => {
    expect(bootStep([])).toBeNull();
    expect(bootStep(["[ahd] something unrelated"])).toBeNull();
  });
  it("explains the first-run download with a percent", () => {
    expect(bootStep(["[ahd] MongoDB 8.0.12 is not installed; fetching it once from a mirror", "[ahd] MongoDB download: 40%"])).toEqual({
      label: "Downloading the database",
      detail: "First time only. 40% done.",
    });
  });
  it("explains the first-run download before a percent arrives", () => {
    expect(bootStep(["[ahd] MongoDB 8.0.12 is not installed; fetching it once from a mirror"])?.detail).toContain("few minutes");
  });
  it("reads the size on Windows", () => {
    expect(bootStep(["[ahd] fetching mongod.exe (62 MB)"])?.detail).toContain("62 MB");
  });
  it("moves on once the database is ready", () => {
    expect(bootStep(["[ahd] MongoDB download: 90%", "[ahd] MongoDB ready at /x/mongod"])?.label).toBe("Starting the game");
  });
});

describe("formatElapsed", () => {
  it("formats minutes and seconds", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(75)).toBe("1:15");
  });
});
