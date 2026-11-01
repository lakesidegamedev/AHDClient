import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readGameRef } from "./game-ref.mjs";

const root = resolve(import.meta.dirname, "..");
// Git for Windows can check text files out with CRLF. Normalize once so every
// metadata expression behaves identically on the release matrix.
const read = (path) => readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n");
const json = (path) => JSON.parse(read(path));

const rootPackage = json("package.json");
const desktopPackage = json("apps/desktop/package.json");
const workspacePackages = [desktopPackage];
const packageLock = json("package-lock.json");
const tauriConfig = json("apps/desktop/src-tauri/tauri.conf.json");
const cargoManifest = read("apps/desktop/src-tauri/Cargo.toml");
const cargoLock = read("apps/desktop/src-tauri/Cargo.lock");
const changelog = read("CHANGELOG.md");

const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const cargoLockVersion = cargoLock.match(/\[\[package\]\]\nname = "ahdclient-desktop"\nversion = "([^"]+)"/)?.[1];
const expected = rootPackage.version;
const versions = {
  "root package": rootPackage.version,
  "desktop package": desktopPackage.version,
  "package lock root": packageLock.version,
  "package lock workspace root": packageLock.packages?.[""]?.version,
  "package lock desktop": packageLock.packages?.["apps/desktop"]?.version,
  "Tauri config": tauriConfig.version,
  "Rust crate": cargoVersion,
  "Cargo lock crate": cargoLockVersion,
};

const errors = [];
for (const [surface, version] of Object.entries(versions)) {
  if (version !== expected) errors.push(`${surface} is ${version ?? "missing"}; expected ${expected}`);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected)) {
  errors.push(`root package version is not release-shaped: ${expected}`);
}
if (!changelog.includes(`## [${expected}]`)) {
  errors.push(`CHANGELOG.md has no ## [${expected}] section`);
}
if (tauriConfig.identifier !== "net.lakesidegames.ahdclient") {
  errors.push(`unexpected application identifier: ${tauriConfig.identifier}`);
}
if (tauriConfig.productName !== "AHDClient") {
  errors.push(`unexpected product name: ${tauriConfig.productName}`);
}
if (rootPackage.license !== "UNLICENSED") {
  errors.push(`root package license is ${rootPackage.license ?? "missing"}; expected UNLICENSED`);
}
for (const workspacePackage of workspacePackages) {
  if (workspacePackage.private !== true || workspacePackage.license !== "UNLICENSED") {
    errors.push(`${workspacePackage.name} must be private and UNLICENSED`);
  }
}
if (!/^publish\s*=\s*false$/m.test(cargoManifest) || !/^license-file\s*=\s*"\.\.\/\.\.\/\.\.\/LICENSE\.md"$/m.test(cargoManifest)) {
  errors.push("Rust crate must be unpublished and use the repository proprietary license");
}

errors.push(...readGameRef(resolve(root, "game-ref.json")).errors);

if (errors.length > 0) {
  console.error("Release check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Release metadata is synchronized at ${expected}.`);
}
