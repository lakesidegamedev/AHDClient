#!/usr/bin/env node
// Writes the small manifest the Android app reads to learn that a newer direct
// download exists. Published next to the APK as AHDClient-android-latest.json.
// versionCode is derived the way Tauri derives it for the Android build, so the
// number here always matches the APK it describes.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DOWNLOAD_PAGE = "https://ops.lakesidegames.net/downloads/";

export function androidVersionCode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`not a plain x.y.z version: ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (minor > 999 || patch > 999) throw new Error(`version out of range: ${version}`);
  return major * 1_000_000 + minor * 1_000 + patch;
}

export function buildAndroidManifest(version, pageUrl = DOWNLOAD_PAGE) {
  if (!URL.canParse(pageUrl) || new URL(pageUrl).protocol !== "https:") {
    throw new Error(`download page must use HTTPS: ${pageUrl}`);
  }
  return { versionCode: androidVersionCode(version), versionName: version, pageUrl };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const output = process.argv[2] ?? "AHDClient-android-latest.json";
  const version = JSON.parse(
    readFileSync(path.join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
  ).version;
  writeFileSync(output, `${JSON.stringify(buildAndroidManifest(version), null, 2)}\n`);
}
