import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLanguage, useT } from "./i18n.js";

/** "Start when I sign in". The operating system holds the truth, so this reads it every time. */
export function AutostartControl(): JSX.Element {
  const t = useT();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    invoke<boolean>("get_autostart")
      .then((on) => { if (active) setEnabled(on); })
      .catch(() => { if (active) setEnabled(false); });
    return () => { active = false; };
  }, []);
  async function change(next: boolean) {
    setError(false);
    try { setEnabled(await invoke<boolean>("set_autostart", { enabled: next })); }
    catch { setError(true); }
  }
  return <label className="client-settings-row">
    <span>
      <strong>{t("settings.autostart")}</strong>
      <small>{error ? t("settings.autostartError") : t("settings.autostartDetail")}</small>
    </span>
    <input type="checkbox" role="switch" checked={enabled ?? false} disabled={enabled === null}
      onChange={(event) => void change(event.target.checked)} />
  </label>;
}

interface FolderInfo { worldsBytes: number; totalBytes: number }

/** Sizes as a player reads them: KB under a megabyte, then MB, then GB. */
export function formatDiskSize(bytes: number, language: "en" | "de" = "en"): string {
  const number = (value: number, digits: number) =>
    value.toLocaleString(language === "de" ? "de-DE" : "en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
  if (bytes < 1024 * 1024) return `${number(Math.max(1, Math.round(bytes / 1024)), 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${number(bytes / (1024 * 1024), bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${number(bytes / (1024 * 1024 * 1024), 1)} GB`;
}

/** How much room worlds take, plus a button that shows the folder. */
export function StorageControls(): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const [info, setInfo] = useState<FolderInfo | null | undefined>(undefined);
  const [openError, setOpenError] = useState(false);
  useEffect(() => {
    let active = true;
    invoke<FolderInfo>("data_folder_info")
      .then((next) => { if (active) setInfo(next); })
      .catch(() => { if (active) setInfo(null); });
    return () => { active = false; };
  }, []);
  async function open() {
    setOpenError(false);
    try { await invoke("open_data_folder"); } catch { setOpenError(true); }
  }
  const sizeText = info === null
    ? t("settings.worldsSizeUnknown")
    : info === undefined
      ? "…"
      : t("settings.worldsSizeDetail", { worlds: formatDiskSize(info.worldsBytes, language), total: formatDiskSize(info.totalBytes, language) });
  return <>
    <div className="client-support-control">
      <div><strong>{t("settings.worldsSize")}</strong><small role="status">{sizeText}</small></div>
    </div>
    <div className="client-support-control">
      <div><strong>{t("settings.openFolder")}</strong><small>{openError ? t("settings.openFolderError") : t("settings.openFolderDetail")}</small></div>
      <button type="button" onClick={() => void open()}>{t("settings.openFolderButton")}</button>
    </div>
  </>;
}
