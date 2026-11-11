import { useEffect, useState } from "react";
import { gameRuntime } from "./capabilities.js";
import { gameVersions } from "./worlds.js";
import type { GameVersion } from "./worlds.js";
import { useT } from "./i18n.js";

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
export function GameVersionSetting(): JSX.Element {
  const t = useT();
  const active = useActiveGameVersion();
  const [versions, setVersions] = useState<GameVersion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const refresh = async () => {
    try {
      setVersions(await gameVersions.list());
    } catch {
      setVersions([]);
      setMessage(t("gameVersion.listError"));
    }
  };
  useEffect(() => { void refresh(); }, []);

  const selectedVersion = versions?.find((version) => version.selected)?.version ?? "bundled";
  const bundledLabel = active && selectedVersion === "bundled" ? active : null;
  const choose = async (version: string) => {
    setBusy(true);
    setMessage(version === "bundled" ? "" : t("gameVersion.preparing", { version }));
    try {
      const target = versions?.find((item) => item.version === version);
      if (version !== "bundled" && !target?.installed) await gameVersions.install(version);
      await gameVersions.select(version === "bundled" ? null : version);
      await refresh();
      setMessage(version === "bundled"
        ? t("gameVersion.usingBundled")
        : t("gameVersion.usingVersion", { version }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  return (
    <label className="client-settings-row">
      <span>
        <strong>{t("gameVersion.label")}</strong>
        <small>
          {t("gameVersion.detail")}
        </small>
        {message && <small role="status">{message}</small>}
      </span>
      <select
        aria-label={t("gameVersion.aria")}
        value={selectedVersion}
        disabled={busy || versions === null}
        onChange={(event) => void choose(event.target.value)}
      >
        <option value="bundled">
          {t("gameVersion.bundled")}{bundledLabel ? ` (${bundledLabel})` : ""}
        </option>
        {(versions ?? []).filter((version) => version.version !== active || version.selected).map((version) => {
          const size = formatSize(version.sizeBytes);
          const suffix = version.installed ? "" : ` · ${t("gameVersion.download")}${size ? ` ${size}` : ""}`;
          return <option key={version.version} value={version.version}>{version.version}{suffix}</option>;
        })}
      </select>
    </label>
  );
}
