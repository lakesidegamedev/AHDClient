/**
 * What the game is doing right now, in plain words, read from its own log.
 * The first run downloads the database program, which can take minutes, so
 * that step says so and gives the size or percent when the game reports it.
 */
export function bootStep(lines: readonly string[]): { label: string; detail: string } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const percent = /MongoDB download: (\d+)%/.exec(line);
    if (percent) return { label: "Downloading the database", detail: `First time only. ${percent[1]}% done.` };
    const size = /fetching [^\s(]*mongod[^\s(]* \((\d+) MB\)/i.exec(line);
    if (size) return { label: "Downloading the database", detail: `First time only. About ${size[1]} MB.` };
    if (/is not installed; fetching it once/i.test(line)) {
      return { label: "Downloading the database", detail: "First time only. This can take a few minutes." };
    }
    if (/loading your saved game/i.test(line)) {
      return { label: "Loading your saved game", detail: "This can take a minute on a big world." };
    }
    if (/Seeding countries/i.test(line)) {
      return { label: "Building the world", detail: "Setting up countries, parties and markets." };
    }
    if (/MongoDB ready|using cached MongoDB|using MongoDB already installed/i.test(line)) {
      return { label: "Starting the game", detail: "The database is ready." };
    }
  }
  return null;
}

/** 75 seconds as "1:15". */
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
