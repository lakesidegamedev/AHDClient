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
import { online } from "./worlds.js";

function messageFor(state: UpdaterSnapshot): string {
  switch (state.kind) {
    case "current":
      return "AHDClient is up to date.";
    case "available": {
      const size = formatUpdateSize(state.size);
      return `AHDClient ${state.version} is available${size ? ` (${size})` : ""}. Nothing is downloaded until you choose.`;
    }
    case "package":
      return `AHDClient ${state.version} is available. This copy was installed from a package, so get the new package from the download page.`;
    case "downloading":
      return state.total
        ? `Downloading AHDClient ${state.version} (${Math.min(100, Math.round((state.received / state.total) * 100))}%).`
        : `Downloading AHDClient ${state.version} in the background.`;
    case "ready":
      return `AHDClient ${state.version} is downloaded. Restart to install it.`;
    case "installing":
      return "Installing the downloaded update.";
    case "error":
      return state.message;
    case "checking":
      return "Looking for a new version.";
    default:
      return "Check whether a new version is out.";
  }
}

export function UpdateControl(): JSX.Element {
  const [state, setState] = useState<UpdaterSnapshot>(getUpdaterSnapshot);
  useEffect(() => subscribeUpdater(() => setState(getUpdaterSnapshot())), []);

  const busy = state.kind === "checking" || state.kind === "downloading" || state.kind === "installing";
  const label =
    state.kind === "available"
      ? "Download update"
      : state.kind === "package"
        ? "Open download page"
        : state.kind === "ready"
      ? "Restart to update"
      : state.kind === "checking"
        ? "Checking…"
        : state.kind === "downloading"
          ? "Downloading…"
          : state.kind === "installing"
            ? "Installing…"
            : "Check for updates";

  return (
    <section className="client-update-control" aria-live="polite">
      <div>
        <strong>Desktop updates</strong>
        <small>{messageFor(state)}</small>
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
