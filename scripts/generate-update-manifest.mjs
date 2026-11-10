#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM_NAMES = new Set([
  "windows-x86_64",
  "linux-x86_64",
  "linux-aarch64",
  "darwin-x86_64",
  "darwin-aarch64",
]);

function artifactSize(signatureFile) {
  if (!signatureFile.endsWith(".sig")) return null;
  try {
    return statSync(signatureFile.slice(0, -4)).size;
  } catch {
    return null;
  }
}

export function buildManifest(entries, publishedAt = new Date()) {
  const version = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  ).version;
  const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const escaped = version.replaceAll(".", "\\.");
  const notes = changelog
    .match(
      new RegExp(
        `## \\[${escaped}\\](?:[^\\n]*)\\n\\n([\\s\\S]*?)(?=\\n## |$)`,
      ),
    )?.[1]
    ?.trim();
  if (!notes) throw new Error(`CHANGELOG.md has no notes for ${version}`);

  const platforms = {};
  for (const { platform, url, signatureFile } of entries) {
    if (!PLATFORM_NAMES.has(platform))
      throw new Error(`unsupported updater platform: ${platform}`);
    if (!URL.canParse(url) || new URL(url).protocol !== "https:") {
      throw new Error(`updater URL must use HTTPS: ${url}`);
    }
    const signature = readFileSync(signatureFile, "utf8").trim();
    if (!signature)
      throw new Error(`empty updater signature: ${signatureFile}`);
    // The app shows the download size before it fetches anything. The artifact
    // sits next to its signature file; leave size out if it is not there.
    const size = artifactSize(signatureFile);
    platforms[platform] = size == null ? { url, signature } : { url, signature, size };
  }
  if (Object.keys(platforms).length === 0)
    throw new Error("at least one updater platform is required");
  return { version, notes, pub_date: publishedAt.toISOString(), platforms };
}

function parseArguments(args) {
  // Preserve the Windows-only command used by the 2.0.2 and 2.0.3 release process.
  if (args[0] && !args[0].startsWith("--")) {
    const [url, signatureFile, output = "latest.json"] = args;
    if (!url || !signatureFile)
      throw new Error("missing Windows updater artifact or signature");
    return {
      entries: [{ platform: "windows-x86_64", url, signatureFile }],
      output,
    };
  }

  const entries = [];
  let output = "latest.json";
  for (let index = 0; index < args.length;) {
    if (args[index] === "--output") {
      output = args[index + 1];
      if (!output) throw new Error("--output requires a path");
      index += 2;
    } else if (args[index] === "--platform") {
      const [platform, url, signatureFile] = args.slice(index + 1, index + 4);
      if (!platform || !url || !signatureFile) {
        throw new Error(
          "--platform requires <name> <artifact-url> <signature-file>",
        );
      }
      entries.push({ platform, url, signatureFile });
      index += 4;
    } else {
      throw new Error(`unknown argument: ${args[index]}`);
    }
  }
  return { entries, output };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { entries, output } = parseArguments(process.argv.slice(2));
  writeFileSync(output, `${JSON.stringify(buildManifest(entries), null, 2)}\n`);
}
