import { useEffect, useState } from "react";
import { gameRuntime } from "./capabilities.js";
import { gameVersions } from "./worlds.js";
import type { GameVersion } from "./worlds.js";
import type { ClientLanguage } from "./i18n.js";

function formatSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
}

/** The game version the app would start now, or null when it cannot tell. */
function useActiveGameVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    gameRuntime.bundledInfo()
      .then((info) => { if (live) setVersion(info.gameVersion); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  return version;
}

/** Launcher footer: one quiet line naming the game version in use. */
export function GameVersionLine(): JSX.Element | null {
  const version = useActiveGameVersion();
  if (!version) return null;
  return <span className="client-game-version-line">Game {version}</span>;
}

/** Settings, Singleplayer: choose which game version singleplayer runs. Nothing changes until the player picks. */
export function GameVersionSetting({ language = "en" }: { language?: ClientLanguage }): JSX.Element {
  const de = language === "de";
  const active = useActiveGameVersion();
  const [versions, setVersions] = useState<GameVersion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const refresh = async () => {
    try {
      setVersions(await gameVersions.list());
    } catch {
      setVersions([]);
      setMessage(de ? "Versionsliste nicht verfügbar. Prüfe deine Internetverbindung." : "Could not check for other versions. Check your connection.");
    }
  };
  useEffect(() => { void refresh(); }, []);

  const selectedVersion = versions?.find((version) => version.selected)?.version ?? "bundled";
  const bundledLabel = active && selectedVersion === "bundled" ? active : null;
  const choose = async (version: string) => {
    setBusy(true);
    setMessage(version === "bundled" ? "" : de ? `Spiel ${version} wird vorbereitet…` : `Getting game ${version} ready…`);
    try {
      const target = versions?.find((item) => item.version === version);
      if (version !== "bundled" && !target?.installed) await gameVersions.install(version);
      await gameVersions.select(version === "bundled" ? null : version);
      await refresh();
      setMessage(version === "bundled"
        ? (de ? "Das mitgelieferte Spiel wird verwendet." : "Using the game that came with the app.")
        : (de ? `Spiel ${version} wird beim nächsten Start verwendet.` : `Game ${version} will be used the next time you start a world.`));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  return (
    <label className="client-settings-row">
      <span>
        <strong>{de ? "Spielversion" : "Game version"}</strong>
        <small>
          {de
            ? "Neuere Versionen bringen neue Funktionen und Korrekturen. Das mitgelieferte Spiel passt zu dieser App. Deine gespeicherten Welten werden beim Wechsel nicht gelöscht."
            : "Newer versions add features and fixes. The game that came with the app always matches this app. Switching never deletes your saved worlds."}
        </small>
        {message && <small role="status">{message}</small>}
      </span>
      <select
        aria-label={de ? "Einzelspieler-Spielversion" : "Singleplayer game version"}
        value={selectedVersion}
        disabled={busy || versions === null}
        onChange={(event) => void choose(event.target.value)}
      >
        <option value="bundled">
          {de ? "Mitgeliefert" : "Included with the app"}{bundledLabel ? ` (${bundledLabel})` : ""}
        </option>
        {(versions ?? []).filter((version) => version.version !== active || version.selected).map((version) => {
          const size = formatSize(version.sizeBytes);
          const suffix = version.installed ? "" : ` · ${de ? "Download" : "download"}${size ? ` ${size}` : ""}`;
          return <option key={version.version} value={version.version}>{version.version}{suffix}</option>;
        })}
      </select>
    </label>
  );
}
