#!/usr/bin/env node
/**
 * Stage what the desktop bundle needs beyond its own code:
 *
 *   1. A Node runtime as a Tauri sidecar
 *      (apps/desktop/src-tauri/binaries/ahd-node-<triple>[.exe]).
 *   2. The game itself: the A House Divided singleplayer build
 *      (apps/desktop/src-tauri/resources/game/), produced from an AHDGame
 *      checkout with `npm run singleplayer:package`.
 *
 *   node scripts/prepare-game.mjs [--target <rust triple>] [--game-dir <path>]
 *                                 [--node-only] [--skip-game-build]
 *
 * `--game-dir` defaults to $AHDGAME_DIR. `--skip-game-build` reuses an
 * existing dist/singleplayer in that checkout.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export const NODE_VERSION = "v22.23.2";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI = path.join(ROOT, "apps", "desktop", "src-tauri");
export const BUILD_PROVENANCE_FILE = "build-provenance.json";
const BUILD_PROVENANCE_SCHEMA_VERSION = 1;

function unknownBuildProvenance() {
  return {
    schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION,
    sourceCommit: null,
    sourceDirty: null,
    status: "unknown",
  };
}

function isCommit(value) {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/i.test(value);
}

/** Read provenance emitted by the AHDGame packaging step. */
export function readBuildProvenance(dist) {
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(path.join(dist, BUILD_PROVENANCE_FILE), "utf8"));
  } catch {
    return unknownBuildProvenance();
  }
  if (!metadata || typeof metadata !== "object" || metadata.schemaVersion !== BUILD_PROVENANCE_SCHEMA_VERSION) {
    return unknownBuildProvenance();
  }

  const { sourceCommit, sourceDirty, status } = metadata;
  if (status === "clean" && isCommit(sourceCommit) && sourceDirty === false) {
    return { schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION, sourceCommit, sourceDirty, status };
  }
  if (status === "dirty" && isCommit(sourceCommit) && sourceDirty === true) {
    return { schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION, sourceCommit, sourceDirty, status };
  }
  if (status === "unknown" && (sourceCommit === null || isCommit(sourceCommit)) && sourceDirty === null) {
    return { schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION, sourceCommit, sourceDirty, status };
  }
  return unknownBuildProvenance();
}

export function buildInfoFromProvenance(dist, clientVersion) {
  const provenance = readBuildProvenance(dist);
  return {
    clientVersion,
    gameCommit: provenance.sourceCommit,
    gameCommitStatus: provenance.status,
  };
}

/** Rust target triple -> Node distribution name. */
export const NODE_DIST = {
  "x86_64-unknown-linux-gnu": { dist: "linux-x64", ext: "tar.xz", bin: "bin/node" },
  "aarch64-unknown-linux-gnu": { dist: "linux-arm64", ext: "tar.xz", bin: "bin/node" },
  "aarch64-apple-darwin": { dist: "darwin-arm64", ext: "tar.gz", bin: "bin/node" },
  "x86_64-apple-darwin": { dist: "darwin-x64", ext: "tar.gz", bin: "bin/node" },
  "x86_64-pc-windows-msvc": { dist: "win-x64", ext: "zip", bin: "node.exe" },
};

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

function hostTriple() {
  const out = spawnSync("rustc", ["-vV"], { encoding: "utf8" }).stdout ?? "";
  const m = out.match(/^host:\s*(\S+)/m);
  if (m) return m[1];
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "linux") return `${arch}-unknown-linux-gnu`;
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  if (process.platform === "win32") return "x86_64-pc-windows-msvc";
  throw new Error(`cannot infer a Rust target for ${process.platform}/${process.arch}`);
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

export async function stageNode(triple) {
  const spec = NODE_DIST[triple];
  if (!spec) throw new Error(`no Node distribution known for ${triple}`);
  const suffix = triple.includes("windows") ? ".exe" : "";
  // "ahd-node" rather than "node": Linux packages put sidecars in /usr/bin.
  const dest = path.join(TAURI, "binaries", `ahd-node-${triple}${suffix}`);
  if (existsSync(dest)) {
    console.log(`node sidecar present: ${dest}`);
    return dest;
  }
  const name = `node-${NODE_VERSION}-${spec.dist}`;
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${name}.${spec.ext}`;
  const tmp = mkdtempSync(path.join(tmpdir(), "ahdclient-node-"));
  const archive = path.join(tmp, `${name}.${spec.ext}`);
  console.log(`fetching ${url}`);
  await download(url, archive);
  // GNU tar (Linux) does not read zip; bsdtar (macOS, Windows) reads everything.
  const useUnzip = spec.ext === "zip" && process.platform !== "win32";
  const r = useUnzip
    ? spawnSync("unzip", ["-q", archive, "-d", tmp], { stdio: "inherit" })
    : spawnSync("tar", ["-xf", archive, "-C", tmp], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${useUnzip ? "unzip" : "tar"} failed while unpacking Node`);
  const extracted = path.join(tmp, name, spec.bin);
  if (!existsSync(extracted)) throw new Error(`${spec.bin} not found in ${name}`);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(extracted, dest);
  if (!suffix) chmodSync(dest, 0o755);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`node sidecar staged: ${dest}`);
  return dest;
}

/** Rust triple -> the npm os/cpu pair sharp publishes native builds for. */
const NATIVE_PLATFORM = {
  "x86_64-unknown-linux-gnu": "linux-x64",
  "aarch64-unknown-linux-gnu": "linux-arm64",
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64",
  "x86_64-pc-windows-msvc": "win32-x64",
};

/**
 * The game is built on Linux, so its node_modules carry Linux natives only.
 * For any other target, fetch that platform's sharp packages straight from
 * the npm registry into the staged tree and drop the ones that cannot load
 * there. sharp is the only native module the game ships.
 */
async function stageNativeVariants(staging, triple) {
  const want = NATIVE_PLATFORM[triple];
  if (!want) throw new Error(`no native platform mapping for ${triple}`);
  const imgDir = path.join(staging, "node_modules", "@img");
  const sharpManifest = path.join(staging, "node_modules", "sharp", "package.json");
  if (!existsSync(sharpManifest)) return;
  const optional = JSON.parse(readFileSync(sharpManifest, "utf8")).optionalDependencies ?? {};
  for (const [name, version] of Object.entries(optional)) {
    if (!name.startsWith("@img/")) continue;
    const short = name.slice("@img/".length);
    const dest = path.join(imgDir, short);
    if (!short.endsWith(`-${want}`)) {
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      continue;
    }
    if (existsSync(dest)) continue;
    const exact = version.replace(/^[\^~]/, "");
    const url = `https://registry.npmjs.org/${name}/-/${short}-${exact}.tgz`;
    const tmp = mkdtempSync(path.join(tmpdir(), "ahdclient-native-"));
    const archive = path.join(tmp, "pkg.tgz");
    console.log(`fetching ${url}`);
    await download(url, archive);
    const r = spawnSync("tar", ["-xzf", archive, "-C", tmp], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`tar failed for ${name}`);
    mkdirSync(imgDir, { recursive: true });
    cpSync(path.join(tmp, "package"), dest, { recursive: true });
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Drop even traced variants absent from sharp's current optional manifest. */
export function pruneForeignSharp(root, triple) {
  const want = NATIVE_PLATFORM[triple];
  if (!want) throw new Error(`no native platform mapping for ${triple}`);
  const dir = path.join(root, "node_modules", "@img");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith("sharp-") && name !== `sharp-${want}` && name !== `sharp-libvips-${want}`) {
      rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }
}

const STAGED_TOP_FILES = new Set([
  "server.js",
  "package.json",
  "launch.mjs",
  "README.txt",
  "LICENSE.md",
  "AHD_BUILD.json",
  BUILD_PROVENANCE_FILE,
]);
const STAGED_TOP_DIRS = new Set([".next", "public", "node_modules"]);

export function shouldKeepStagedGamePath(relPosix) {
  if (!relPosix || relPosix === ".") return true;
  if (relPosix.endsWith(".map") || relPosix.endsWith(".tsbuildinfo")) return false;
  if (/\.(md|markdown)$/i.test(relPosix) && !/(?:^|\/)LICENSE(?:\.[A-Za-z0-9]+)?$/i.test(relPosix) && relPosix !== "README.txt") return false;
  if (STAGED_TOP_FILES.has(relPosix)) return true;
  // Dynamic URL tracing can copy dependency documentation and test sources
  // into hashed server assets. Neither is read by the packaged game; keep
  // runtime assets such as SQL migrations while dropping these copies.
  if (relPosix.startsWith(".next/server/assets/") && (
    relPosix.endsWith(".md") || /(?:^|[/.])(?:test|spec)(?:\.[^/]+)?\.[cm]?[jt]sx?$/.test(relPosix)
  )) return false;

  const top = relPosix.split("/")[0];
  if (STAGED_TOP_DIRS.has(top)) return true;
  if (relPosix.startsWith("src/data/") && relPosix.endsWith(".json")) return true;
  if (relPosix.startsWith("content/changelog/public/") && relPosix.endsWith(".md")) return true;
  if (relPosix.startsWith("content/changelog/legacy/") && relPosix.endsWith(".md")) return true;
  return false;
}

function walkFiles(root) {
  const files = [];
  if (!existsSync(root)) return files;
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(full);
      else files.push(full.slice(root.length + 1).split(path.sep).join("/"));
    }
  };
  visit(root);
  return files;
}

function pruneEmptyDirs(root) {
  const visit = (dir) => {
    if (!existsSync(dir)) return true;
    let empty = true;
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!visit(full)) empty = false;
      } else empty = false;
    }
    if (empty && dir !== root) {
      rmSync(dir, { recursive: true, force: true });
      return true;
    }
    return false;
  };
  visit(root);
}

/** Drop source, docs, tests and plan markdown the file trace still copies. */
export function pruneStagedGame(root) {
  const dropped = [];
  for (const rel of walkFiles(root)) {
    if (shouldKeepStagedGamePath(rel)) continue;
    rmSync(path.join(root, ...rel.split("/")), { force: true });
    dropped.push(rel);
  }
  rmSync(path.join(root, ".next", "cache"), { recursive: true, force: true });
  pruneEmptyDirs(root);
  return dropped;
}

// Hashed server externals, optionally scoped and with a subpath, referenced by
// any Turbopack loader: require("mongodb-<hash>"),
// require("@sentry/server-runtime-injection-<hash>/register"), e.y("sharp-<hash>").
// A quoted hashed name counts when its base package is installed. A bundle
// missing one fails at runtime, so staging refuses it.
const ALIAS_PATTERN =
  /["']((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*-[a-f0-9]{16})(?:\/[^"']*)?["']/g;

export function assertStagedGame(root, triple) {
  const missing = [];
  for (const req of ["server.js", "launch.mjs", ".next/static", ".next/server", "public", "node_modules"]) {
    if (!existsSync(path.join(root, ...req.split("/")))) missing.push(req);
  }
  const chunkDir = path.join(root, ".next", "server", "chunks");
  if (existsSync(chunkDir)) {
    const aliases = new Set();
    for (const entry of readdirSync(chunkDir)) {
      if (!entry.endsWith(".js")) continue;
      const source = readFileSync(path.join(chunkDir, entry), "utf8");
      for (const match of source.matchAll(ALIAS_PATTERN)) {
        const base = match[1].replace(/-[a-f0-9]{16}$/, "");
        if (existsSync(path.join(root, "node_modules", ...base.split("/")))) aliases.add(match[1]);
      }
    }
    for (const alias of aliases) {
      if (!existsSync(path.join(root, "node_modules", ...alias.split("/")))) missing.push(`node_modules/${alias}`);
    }
  }
  if (!existsSync(path.join(root, "node_modules", "mongodb"))) missing.push("node_modules/mongodb");
  const want = NATIVE_PLATFORM[triple];
  if (existsSync(path.join(root, "node_modules", "sharp")) && want) {
    if (!existsSync(path.join(root, "node_modules", "@img", `sharp-${want}`))) {
      missing.push(`node_modules/@img/sharp-${want}`);
    }
  }
  let foreignSharp = [];
  const imgDir = path.join(root, "node_modules", "@img");
  if (want && existsSync(imgDir)) {
    foreignSharp = readdirSync(imgDir).filter((name) => name.startsWith("sharp-") && name !== `sharp-${want}` && name !== `sharp-libvips-${want}`);
  }
  let strayTs = 0;
  let tests = 0;
  let docs = 0;
  let plans = 0;
  for (const rel of walkFiles(root)) {
    if (rel.startsWith("node_modules/") || rel.startsWith(".next/node_modules/")) continue;
    if (rel.startsWith("src/") && /\.[cm]?tsx?$/.test(rel)) strayTs += 1;
    if (/(^|\/)(tests|e2e)(\/|$)/.test(rel) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(rel)) tests += 1;
    if (rel === "docs" || rel.startsWith("docs/")) docs += 1;
    if (
      rel.endsWith(".md") &&
      rel !== "LICENSE.md" &&
      !rel.startsWith("content/changelog/public/") &&
      !rel.startsWith("content/changelog/legacy/")
    ) {
      plans += 1;
    }
  }
  const budgetHits = [];
  if (foreignSharp.length) budgetHits.push(`foreign sharp variants remain: ${foreignSharp.join(", ")}`);
  if (strayTs > 0) budgetHits.push(`strayTs ${strayTs} > 0`);
  if (tests > 0) budgetHits.push(`tests ${tests} > 0`);
  if (docs > 0) budgetHits.push(`docs ${docs} > 0`);
  if (plans > 0) budgetHits.push(`plans ${plans} > 0`);
  if (missing.length || budgetHits.length) {
    throw new Error(
      `staged game payload allowlist failed: ${[...missing.map((m) => `missing ${m}`), ...budgetHits].join("; ")}`,
    );
  }
}

export async function stageGame(gameDir, triple, { skipBuild = false, destination } = {}) {
  if (!gameDir) throw new Error("pass --game-dir or set AHDGAME_DIR to an AHDGame checkout");
  gameDir = path.resolve(gameDir);
  if (!existsSync(path.join(gameDir, "scripts", "singleplayer", "package.mjs"))) {
    throw new Error(`${gameDir} does not look like an AHDGame checkout with singleplayer packaging`);
  }
  const dist = path.join(gameDir, "dist", "singleplayer");
  if (!skipBuild) {
    for (const [cmd, args] of [
      ["npm", ["ci", "--no-audit", "--no-fund"]],
      ["npm", ["run", "singleplayer:package"]],
    ]) {
      const r = spawnSync(cmd, args, { cwd: gameDir, stdio: "inherit", shell: process.platform === "win32" });
      if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed in ${gameDir}`);
    }
  }
  if (!existsSync(path.join(dist, "server.js")) || !existsSync(path.join(dist, "launch.mjs"))) {
    throw new Error(`${dist} is missing server.js or launch.mjs`);
  }
  const dest = destination || path.join(TAURI, "resources", "game");
  const staging = `${dest}.staging`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(dist, staging, { recursive: true });
  // Keep exactly the target platform's native modules. Foreign ones are dead
  // weight, and linuxdeploy refuses an AppDir holding an ELF linked to musl.
  await stageNativeVariants(staging, triple);
  pruneForeignSharp(staging, triple);
  const clientVersion = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  writeFileSync(
    path.join(staging, "AHD_BUILD.json"),
    `${JSON.stringify(buildInfoFromProvenance(staging, clientVersion), null, 2)}\n`,
  );
  pruneStagedGame(staging);
  assertStagedGame(staging, triple);
  mkdirSync(path.dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  renameSync(staging, dest);
  // tauri-build copies resources next to the binary at compile time and
  // tauri-bundler reuses a previous AppDir; both would keep files that are
  // no longer staged (linuxdeploy then trips over them). Purge both copies.
  for (const stale of [
    path.join(TAURI, "target", "release", "game"),
    path.join(TAURI, "target", "release", "bundle", "appimage", "AHDClient.AppDir"),
    path.join(TAURI, "target", "release", "bundle", "appimage_deb"),
  ]) {
    rmSync(stale, { recursive: true, force: true });
  }
  const perTarget = path.join(TAURI, "target");
  if (existsSync(perTarget)) {
    for (const entry of readdirSync(perTarget)) {
      const candidate = path.join(perTarget, entry, "release", "game");
      if (entry.includes("-") && existsSync(candidate)) rmSync(candidate, { recursive: true, force: true });
    }
  }
  console.log(`game staged: ${dest}`);
  return dest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const triple = arg("--target", hostTriple());
  await stageNode(triple);
  if (process.argv.includes("--node-only")) {
    // tauri-build refuses to compile when a declared resource directory is
    // missing, so CI that only needs `cargo test` gets an empty stand-in.
    // The app itself notices the missing launcher and says so at runtime.
    const stub = path.join(TAURI, "resources", "game");
    if (!existsSync(stub)) {
      mkdirSync(stub, { recursive: true });
      writeFileSync(path.join(stub, "NOT_STAGED.txt"), "Run scripts/prepare-game.mjs with --game-dir to stage the game.\n");
    }
  } else {
    await stageGame(arg("--game-dir", process.env.AHDGAME_DIR), triple, {
      skipBuild: process.argv.includes("--skip-game-build"),
    });
  }
}
