// The AHDGame commit every desktop bundle ships as its singleplayer game.
//
// The pin is a committed file so a game bump is a reviewed change with a
// changelog line, not a repository variable nobody sees. 2.6.2 and 2.7.0 both
// shipped a 14 September game because a variable kept pointing there.
//
//   node scripts/game-ref.mjs            validate and print the commit
//   node scripts/game-ref.mjs --fresh    also require the commit to be on the
//                                        game's main and no more than
//                                        maxAgeDays older than its tip
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

export function readGameRef(path = resolve(root, "game-ref.json")) {
  const ref = JSON.parse(readFileSync(path, "utf8"));
  const errors = [];
  if (ref.repository !== "lakesidegamedev/AHDGame") {
    errors.push(`game-ref.json repository is ${ref.repository ?? "missing"}; expected lakesidegamedev/AHDGame`);
  }
  if (typeof ref.commit !== "string" || !/^[0-9a-f]{40}$/.test(ref.commit)) {
    errors.push("game-ref.json commit must be a full 40-character commit hash");
  }
  if (!Number.isInteger(ref.maxAgeDays) || ref.maxAgeDays < 1) {
    errors.push("game-ref.json maxAgeDays must be a positive whole number");
  }
  return { ref, errors };
}

/**
 * Compares the pinned commit with the game's main through the GitHub API.
 * Returns a list of problems; empty means the pin is fresh.
 */
export async function checkFresh(ref, { token, fetchImpl = fetch, now = Date.now() } = {}) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "ahdclient-release" };
  if (token) headers.authorization = `Bearer ${token}`;
  const api = `https://api.github.com/repos/${ref.repository}`;
  const [compareResponse, tipResponse] = await Promise.all([
    fetchImpl(`${api}/compare/${ref.commit}...main`, { headers }),
    fetchImpl(`${api}/commits/main`, { headers }),
  ]);
  for (const response of [compareResponse, tipResponse]) {
    if (!response.ok) return [`could not compare the pinned game commit with main (HTTP ${response.status})`];
  }
  const compare = await compareResponse.json();
  const tipCommit = await tipResponse.json();
  const problems = [];
  if (compare.status !== "ahead" && compare.status !== "identical") {
    problems.push(`pinned game commit ${ref.commit.slice(0, 10)} is not on the game's main (${compare.status})`);
  }
  // compare.commits stops at 250 entries, so the tip date comes from main itself.
  const pinned = Date.parse(compare.base_commit?.commit?.committer?.date ?? "");
  const tip = Date.parse(tipCommit?.commit?.committer?.date ?? "");
  if (Number.isFinite(pinned) && Number.isFinite(tip)) {
    const ageDays = (Math.min(tip, now) - pinned) / 86_400_000;
    if (ageDays > ref.maxAgeDays) {
      problems.push(
        `pinned game commit is ${Math.floor(ageDays)} days behind the game's main ` +
          `(${compare.ahead_by} commits); update game-ref.json before releasing`
      );
    }
  } else {
    problems.push("could not read commit dates from the comparison");
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, "game-ref.mjs")) {
  const { ref, errors } = readGameRef();
  if (errors.length === 0 && process.argv.includes("--fresh")) {
    errors.push(...(await checkFresh(ref, { token: process.env.GITHUB_TOKEN })));
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(ref.commit);
}
