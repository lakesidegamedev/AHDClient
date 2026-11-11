import { translate, type Translator } from "../i18n.js";

const english: Translator = (key, vars) => translate("en", key, vars);

/**
 * What the game is doing right now, in plain words, read from its own log.
 * The first run downloads the database program, which can take minutes, so
 * that step says so and gives the size or percent when the game reports it.
 */
export function bootStep(lines: readonly string[], t: Translator = english): { label: string; detail: string } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const percent = /MongoDB download: (\d+)%/.exec(line);
    if (percent) return { label: t("boot.dbDownload"), detail: t("boot.dbPercent", { percent: percent[1]! }) };
    const size = /fetching [^\s(]*mongod[^\s(]* \((\d+) MB\)/i.exec(line);
    if (size) return { label: t("boot.dbDownload"), detail: t("boot.dbSize", { mb: size[1]! }) };
    if (/is not installed; fetching it once/i.test(line)) {
      return { label: t("boot.dbDownload"), detail: t("boot.dbMinutes") };
    }
    if (/loading your saved game/i.test(line)) {
      return { label: t("boot.loadSave"), detail: t("boot.loadSaveText") };
    }
    if (/Seeding countries/i.test(line)) {
      return { label: t("boot.building"), detail: t("boot.buildingText") };
    }
    if (/MongoDB ready|using cached MongoDB|using MongoDB already installed/i.test(line)) {
      return { label: t("boot.starting"), detail: t("boot.dbReady") };
    }
  }
  return null;
}

/** 75 seconds as "1:15". */
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
