import { useEffect, useState } from "react";
import {
  checkForUpdatesNow,
  confirmRestartToUpdate,
  downloadAvailableUpdate,
  formatUpdateSize,
  getUpdaterSnapshot,
  subscribeUpdater,
  type UpdaterSnapshot,
} from "./updater.js";
import { useT, type Translator } from "./i18n.js";
import { online } from "./worlds.js";

function messageFor(state: UpdaterSnapshot, t: Translator): string {
  switch (state.kind) {
    case "current":
      return t("update.current");
    case "available": {
      const size = formatUpdateSize(state.size);
      return t("update.available", { version: state.version, size: size ? ` (${size})` : "" });
    }
    case "package":
      return t("update.package", { version: state.version });
    case "downloading":
      return state.total
        ? t("update.downloadingPercent", { version: state.version, percent: Math.min(100, Math.round((state.received / state.total) * 100)) })
        : t("update.downloading", { version: state.version });
    case "ready":
      return t("update.ready", { version: state.version });
    case "installing":
      return t("update.installing");
    case "error":
      return state.message;
    case "checking":
      return t("update.checking");
    default:
      return t("update.idle");
  }
}

export function UpdateControl(): JSX.Element {
  const t = useT();
  const [state, setState] = useState<UpdaterSnapshot>(getUpdaterSnapshot);
  useEffect(() => subscribeUpdater(() => setState(getUpdaterSnapshot())), []);

  const busy = state.kind === "checking" || state.kind === "downloading" || state.kind === "installing";
  const label =
    state.kind === "available"
      ? t("update.btnDownload")
      : state.kind === "package"
        ? t("update.btnPackage")
        : state.kind === "ready"
          ? t("update.btnRestart")
          : state.kind === "checking"
            ? t("update.btnChecking")
            : state.kind === "downloading"
              ? t("update.btnDownloading")
              : state.kind === "installing"
                ? t("update.btnInstalling")
                : t("update.btnCheck");

  return (
    <section className="client-update-control" aria-live="polite">
      <div>
        <strong>{t("update.title")}</strong>
        <small>{messageFor(state, t)}</small>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (state.kind === "available") void downloadAvailableUpdate();
          else if (state.kind === "package") void online.help("help.download-client").catch(() => {});
          else if (state.kind === "ready") void confirmRestartToUpdate();
          else void checkForUpdatesNow();
        }}
      >
        {label}
      </button>
    </section>
  );
}
