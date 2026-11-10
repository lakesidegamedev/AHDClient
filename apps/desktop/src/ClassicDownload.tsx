import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { classicGame } from "./worlds.js";
import type { ClassicInfo } from "./worlds.js";

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

  const size = formatDownloadSize(info.sizeBytes);
  return (
    <aside className="launcher-error" role="dialog" aria-label="Classic game download">
      <span>
        {worldName
          ? `${worldName} was made before game 1.20 and stays on the Classic game. `
          : "Classic eras are played on the game as it was before 1.20. "}
        It is a one-time download{size ? ` of ${size}` : ""}. Your other worlds are not affected.
      </span>
      {busy && <progress max={100} value={percent ?? undefined} aria-label="Download progress" />}
      {message && <span role="status">{message}</span>}
      <button type="button" disabled={busy || !info.version} onClick={() => void start()}>
        {busy ? (percent === null ? "Downloading…" : `Downloading ${percent}%`) : "Download"}
      </button>
      <button type="button" onClick={() => { if (busy) void classicGame.cancel().catch(() => undefined); else onClose(); }}>
        {busy ? "Cancel" : "Not now"}
      </button>
    </aside>
  );
}
