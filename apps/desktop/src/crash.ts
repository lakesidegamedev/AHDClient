import { translate, type Translator } from "./i18n.js";

/**
 * Plain words for a local game that stopped by itself. The game reports
 * "game exited with code Some(137)"; players get a sentence, not the code.
 * The code mapping is a hint, so it says "may".
 */
const english: Translator = (key, vars) => translate("en", key, vars);

export function describeExit(line: string, t: Translator = english): string {
  const code = /code Some\((-?\d+)\)/.exec(line)?.[1];
  if (code === "137" || code === "9") {
    return t("exit.memory");
  }
  if (code === "-1073741819") {
    return t("exit.crashed");
  }
  return t("exit.plain");
}
