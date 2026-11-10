/**
 * Plain words for a local game that stopped by itself. The game reports
 * "game exited with code Some(137)"; players get a sentence, not the code.
 * The code mapping is a hint, so it says "may".
 */
export function describeExit(line: string): string {
  const code = /code Some\((-?\d+)\)/.exec(line)?.[1];
  if (code === "137" || code === "9") {
    return "The world stopped unexpectedly. The computer may have run out of memory.";
  }
  if (code === "-1073741819") {
    return "The world stopped unexpectedly. The game crashed.";
  }
  return "The world stopped unexpectedly.";
}
