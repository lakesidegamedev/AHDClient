import { describe, expect, it } from "vitest";
import { describeExit } from "./crash.js";

describe("describeExit", () => {
  it("hints at memory for a killed process", () => {
    expect(describeExit("game exited with code Some(137)")).toContain("run out of memory");
  });
  it("says crashed for a Windows access violation", () => {
    expect(describeExit("game exited with code Some(-1073741819)")).toContain("crashed");
  });
  it("never shows the raw code", () => {
    expect(describeExit("game exited with code Some(1)")).toBe("The world stopped unexpectedly.");
    expect(describeExit("")).toBe("The world stopped unexpectedly.");
  });
});
