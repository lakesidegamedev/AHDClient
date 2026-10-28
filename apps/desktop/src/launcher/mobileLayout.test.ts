import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./launcher.css", import.meta.url), "utf8");

describe("mobile launcher layout", () => {
  it("gives account and settings controls their own top bar row", () => {
    expect(css).toMatch(/\.launcher-topbar\s*\{[^}]*display:\s*flex;/);
    expect(css).not.toMatch(/\.launcher-settings\s*\{/);
    const phone = css.slice(css.lastIndexOf("@media (max-width: 700px)"));
    expect(phone).toMatch(/\.launcher-topbar\s*\{[^}]*justify-content:\s*space-between;/);
  });

  it("lets the backdrop reach the screen edges and keeps content in the safe areas", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 700px)"));
    expect(phone).toMatch(/\.launcher-footer\s*\{[^}]*position:\s*static;[^}]*background:\s*transparent;/);
    expect(phone).toMatch(/\.launcher-footer\s*\{[^}]*env\(safe-area-inset-bottom\)/);
    expect(phone).toMatch(/\.launcher-stage\s*\{[^}]*env\(safe-area-inset-left\)[^}]*\}/);
  });
});
