import { useEffect, useState } from "react";
import { useT, type Translator } from "./i18n.js";
import { getUpdaterSnapshot, subscribeUpdater, type UpdaterSnapshot } from "./updater.js";

interface Props {
  enabled?: boolean;
  /** Opens Settings, where the update can be downloaded or installed. */
  onClick: () => void;
}

function chipLabel(state: UpdaterSnapshot, t: Translator): string | null {
  switch (state.kind) {
    case "available":
    case "package":
      return t("update.chipAvailable");
    case "downloading":
      return t("update.chipDownloading");
    case "ready":
      return t("update.chipReady");
    default:
      return null;
  }
}

/** Small toolbar reminder for screens where the full update card does not fit. */
export function UpdateChip({ enabled = true, onClick }: Props): JSX.Element | null {
  const t = useT();
  const [state, setState] = useState<UpdaterSnapshot>(getUpdaterSnapshot);
  useEffect(() => subscribeUpdater(() => setState(getUpdaterSnapshot())), []);
  const label = enabled ? chipLabel(state, t) : null;
  if (!label) return null;
  return (
    <button
      type="button"
      className="client-update-chip"
      onClick={onClick}
      title={t("update.chipTitle")}
    >
      {label}
    </button>
  );
}
