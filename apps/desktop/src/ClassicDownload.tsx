import { useEffect, useRef, useState } from "react";
import { useDialog } from "./useDialog.js";
import { listen } from "@tauri-apps/api/event";
import { classicGame } from "./worlds.js";
import type { ClassicInfo } from "./worlds.js";
import { useT } from "./i18n.js";

export function formatDownloadSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
}

interface Props {
  info: ClassicInfo;
  /** A world waiting on the download, or null when the player asked for Classic eras. */
  worldName: string | null;
  onDone: () => void;
  onClose: () => void;
}

/** One-time download of the Classic game: size, progress, cancel. */
export function ClassicDownload({ info, worldName, onDone, onClose }: Props): JSX.Element {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const subscription = listen<{ downloaded: number; total: number | null }>("game:download", (event) => {
      const { downloaded, total } = event.payload;
      setPercent(total ? Math.min(100, Math.round((downloaded * 100) / total)) : null);
    });
    return () => { void subscription.then((off) => off()).catch(() => undefined); };
  }, []);

  const start = async () => {
    if (!info.version) return;
    setBusy(true);
    setMessage("");
    try {
      await classicGame.install(info.version);
      onDone();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setBusy(false);
      setPercent(null);
    }
  };

  const dialogRef = useRef<HTMLElement>(null);
  // Escape is "Not now" when idle and "Cancel" while downloading.
  useDialog(dialogRef, () => { if (busy) void classicGame.cancel().catch(() => undefined); else onClose(); });

  const size = formatDownloadSize(info.sizeBytes);
  return (
    <aside ref={dialogRef} className="launcher-error" role="dialog" aria-modal="true" aria-label={t("classic.aria")}>
      <span>
        {worldName ? t("classic.forWorld", { name: worldName }) : t("classic.forEras")}{" "}
        {size ? t("classic.downloadSized", { size }) : t("classic.download")} {t("classic.othersSafe")}
      </span>
      {busy && <progress max={100} value={percent ?? undefined} aria-label={t("classic.progress")} />}
      {message && <span role="status">{message}</span>}
      <button type="button" disabled={busy || !info.version} onClick={() => void start()}>
        {busy ? (percent === null ? t("classic.downloading") : t("classic.downloadingPercent", { percent })) : t("classic.button")}
      </button>
      <button type="button" onClick={() => { if (busy) void classicGame.cancel().catch(() => undefined); else onClose(); }}>
        {busy ? t("common.cancel") : t("classic.notNow")}
      </button>
    </aside>
  );
}
