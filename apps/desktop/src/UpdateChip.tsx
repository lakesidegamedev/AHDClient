import { useEffect, useState } from "react";
import { getUpdaterSnapshot, subscribeUpdater, type UpdaterSnapshot } from "./updater.js";

interface Props {
  enabled?: boolean;
  /** Opens Settings, where the update can be downloaded or installed. */
  onClick: () => void;
}

function chipLabel(state: UpdaterSnapshot): string | null {
  switch (state.kind) {
    case "available":
    case "package":
      return "Update available";
    case "downloading":
      return "Downloading update";
    case "ready":
      return "Update ready";
    default:
      return null;
  }
}

/** Small toolbar reminder for screens where the full update card does not fit. */
export function UpdateChip({ enabled = true, onClick }: Props): JSX.Element | null {
  const [state, setState] = useState<UpdaterSnapshot>(getUpdaterSnapshot);
  useEffect(() => subscribeUpdater(() => setState(getUpdaterSnapshot())), []);
  const label = enabled ? chipLabel(state) : null;
  if (!label) return null;
  return (
    <button
      type="button"
      className="client-update-chip"
      onClick={onClick}
      title="Open Settings to manage this update."
    >
      {label}
    </button>
  );
}
