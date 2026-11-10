import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertStagedGame,
  buildInfoFromProvenance,
  readBuildProvenance,
  pruneStagedGame,
  pruneForeignSharp,
  stageGame,
  shouldKeepStagedGamePath,
} from "./prepare-game.mjs";

const scratch = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function touch(root, rel, body = "x") {
  const full = path.join(root, ...rel.split("/"));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
}

describe("prepare-game payload allowlist", () => {
  it("keeps runtime files and drops source, docs, tests and plans", () => {
    expect(shouldKeepStagedGamePath("server.js")).toBe(true);
    expect(shouldKeepStagedGamePath("launch.mjs")).toBe(true);
    expect(shouldKeepStagedGamePath("build-provenance.json")).toBe(true);
    expect(shouldKeepStagedGamePath(".next/static/app.js")).toBe(true);
    expect(shouldKeepStagedGamePath("node_modules/mongodb-438b504308ffa4be/index.js")).toBe(true);
    expect(shouldKeepStagedGamePath("src/data/npp-images.json")).toBe(true);
    expect(shouldKeepStagedGamePath(".next/static/app.js.map")).toBe(false);
    expect(shouldKeepStagedGamePath("node_modules/mongodb/README.md")).toBe(false);
    expect(shouldKeepStagedGamePath("AGENTS.md")).toBe(false);
    expect(shouldKeepStagedGamePath("src/app/route.ts")).toBe(false);
    expect(shouldKeepStagedGamePath("src/app/route.test.ts")).toBe(false);
    expect(shouldKeepStagedGamePath("content/changelog/unreleased/plan.md")).toBe(false);
  });

  it("prunes a staged tree and requires the target sharp native", () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "ahd-stage-"));
    scratch.push(root);
    touch(root, "server.js");
    touch(root, "launch.mjs");
    touch(root, "package.json", "{}");
    touch(root, ".next/static/app.js");
    touch(root, ".next/server/app.js");
    touch(root, ".next/node_modules/mongodb-traced/README.md");
    touch(root, ".next/server/chunks/ssr.js", 'require("mongodb-438b504308ffa4be");\n');
    touch(root, "public/ahd-logo.png");
    touch(root, "node_modules/mongodb/package.json", "{}");
    touch(root, "node_modules/mongodb-438b504308ffa4be/package.json", "{}");
    touch(root, "node_modules/sharp/package.json", "{}");
    touch(root, "node_modules/@img/sharp-linux-x64/package.json", "{}");
    touch(root, "node_modules/@img/sharp-wasm32/package.json", "{}");
    touch(root, "src/data/npp-images.json", "[]");
    touch(root, "AGENTS.md");
    touch(root, "src/app/route.ts");
    touch(root, "docs/DESIGN.md");
    touch(root, ".next/server/assets/reservation.27cowm2fu60ac.md");
    touch(root, ".next/server/assets/proof-admission.test.1nm4z3uugc29n.mjs");
    touch(root, ".next/server/assets/schema-002.abc123.sql");
    pruneStagedGame(root);
    expect(() => assertStagedGame(root, "x86_64-unknown-linux-gnu")).toThrow(/foreign sharp/);
    pruneForeignSharp(root, "x86_64-unknown-linux-gnu");
    expect(existsSync(path.join(root, "node_modules/@img/sharp-wasm32"))).toBe(false);
    expect(existsSync(path.join(root, "AGENTS.md"))).toBe(false);
    expect(existsSync(path.join(root, "src", "app"))).toBe(false);
    expect(existsSync(path.join(root, "docs"))).toBe(false);
    expect(existsSync(path.join(root, ".next/server/assets/reservation.27cowm2fu60ac.md"))).toBe(false);
    expect(existsSync(path.join(root, ".next/server/assets/proof-admission.test.1nm4z3uugc29n.mjs"))).toBe(false);
    expect(existsSync(path.join(root, ".next/server/assets/schema-002.abc123.sql"))).toBe(true);
    expect(existsSync(path.join(root, "server.js"))).toBe(true);
    assertStagedGame(root, "x86_64-unknown-linux-gnu");
  });

  it("fails when a scoped server external alias is missing", () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "ahd-stage-alias-"));
    scratch.push(root);
    touch(root, "server.js");
    touch(root, "launch.mjs");
    touch(root, ".next/static/app.js");
    touch(
      root,
      ".next/server/chunks/ssr.js",
      'require("mongodb-438b504308ffa4be");require("@sentry/server-runtime-injection-e7acc8d92084955d/register");'
    );
    touch(root, "public/logo.png");
    touch(root, "node_modules/mongodb/package.json", "{}");
    touch(root, "node_modules/mongodb-438b504308ffa4be/package.json", "{}");
    touch(root, "node_modules/@sentry/server-runtime-injection/package.json", "{}");
    // The ff6c015c bundle shipped exactly this gap and failed every request.
    expect(() => assertStagedGame(root, "x86_64-unknown-linux-gnu")).toThrow(
      /@sentry\/server-runtime-injection-e7acc8d92084955d/
    );
    touch(root, "node_modules/@sentry/server-runtime-injection-e7acc8d92084955d/register.js");
    assertStagedGame(root, "x86_64-unknown-linux-gnu");
  });

  it("fails when the Windows sharp native is missing", () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "ahd-stage-win-"));
    scratch.push(root);
    touch(root, "server.js");
    touch(root, "launch.mjs");
    touch(root, ".next/static/app.js");
    touch(root, ".next/server/app.js");
    touch(root, ".next/node_modules/mongodb-traced/README.md");
    touch(root, "public/logo.png");
    touch(root, "node_modules/mongodb/package.json", "{}");
    touch(root, "node_modules/sharp/package.json", "{}");
    touch(root, "node_modules/@img/sharp-linux-x64/package.json", "{}");
    expect(() => assertStagedGame(root, "x86_64-pc-windows-msvc")).toThrow(/sharp-win32-x64/);
  });
});

describe("singleplayer build provenance", () => {
  it("keeps the revision produced by a reused bundle when the checkout moved on", () => {
    const dist = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "ahd-provenance-stale-"));
    scratch.push(dist);
    touch(
      dist,
      "build-provenance.json",
      JSON.stringify({ schemaVersion: 1, sourceCommit: "a".repeat(40), sourceDirty: false, status: "clean" }),
    );

    expect(buildInfoFromProvenance(dist, "2.3.5")).toEqual({
      clientVersion: "2.3.5",
      gameVersion: null,
      gameCommit: "a".repeat(40),
      gameCommitStatus: "clean",
    });
  });

  it("marks an old artifact without provenance as unknown", () => {
    const dist = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "ahd-provenance-missing-"));
    scratch.push(dist);

    expect(readBuildProvenance(dist)).toEqual({
      schemaVersion: 1,
      sourceCommit: null,
      sourceDirty: null,
      status: "unknown",
    });
    expect(buildInfoFromProvenance(dist, "2.3.5")).toEqual({
      clientVersion: "2.3.5",
      gameVersion: null,
      gameCommit: null,
      gameCommitStatus: "unknown",
    });
  });

  it("rejects invalid metadata instead of preserving a false verified claim", () => {
    const dist = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "ahd-provenance-invalid-"));
    scratch.push(dist);
    touch(
      dist,
      "build-provenance.json",
      JSON.stringify({ schemaVersion: 1, sourceCommit: "b".repeat(40), sourceDirty: true, status: "clean" }),
    );

    expect(buildInfoFromProvenance(dist, "2.3.5").gameCommit).toBe(null);
    expect(buildInfoFromProvenance(dist, "2.3.5").gameCommitStatus).toBe("unknown");
  });

  it("accepts metadata emitted for a clean newly built artifact", () => {
    const dist = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "ahd-provenance-valid-"));
    scratch.push(dist);
    touch(
      dist,
      "build-provenance.json",
      JSON.stringify({ schemaVersion: 1, sourceCommit: "c".repeat(40), sourceDirty: false, status: "clean" }),
    );

    expect(readBuildProvenance(dist)).toEqual({
      schemaVersion: 1,
      sourceCommit: "c".repeat(40),
      sourceDirty: false,
      status: "clean",
    });
  });

  it("stages the reused bundle revision instead of the checkout HEAD", async () => {
    const game = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "ahd-provenance-game-"));
    const destinationRoot = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "ahd-provenance-stage-"));
    scratch.push(game, destinationRoot);
    const dist = path.join(game, "dist", "singleplayer");
    touch(game, "scripts/singleplayer/package.mjs");
    touch(dist, "server.js");
    touch(dist, "launch.mjs");
    touch(dist, "package.json", JSON.stringify({ name: "game", version: "1.20.0" }));
    touch(dist, ".next/static/app.js");
    touch(dist, ".next/server/app.js");
    touch(dist, "public/logo.png");
    touch(dist, "node_modules/mongodb/package.json", "{}");
    touch(
      dist,
      "build-provenance.json",
      JSON.stringify({ schemaVersion: 1, sourceCommit: "a".repeat(40), sourceDirty: false, status: "clean" }),
    );

    const staged = path.join(destinationRoot, "game");
    await stageGame(game, "x86_64-unknown-linux-gnu", { skipBuild: true, destination: staged });

    expect(JSON.parse(readFileSync(path.join(staged, "AHD_BUILD.json"), "utf8"))).toEqual({
      clientVersion: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
      gameVersion: "1.20.0",
      gameCommit: "a".repeat(40),
      gameCommitStatus: "clean",
    });
  });
});
