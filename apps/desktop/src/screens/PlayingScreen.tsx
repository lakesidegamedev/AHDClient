import type { WorldMeta } from "../worlds.js";
import { useT } from "../i18n.js";

interface Props {
  world: WorldMeta | null;
  lines: string[];
  hosted: boolean;
  port: number | null;
  onResume: () => void;
  onStop: () => void;
}

/**
 * The launcher window while a game window is open. Small on purpose: the
 * game is in the other window, this one just keeps the server honest.
 */
export function PlayingScreen({ world, lines, hosted, port, onResume, onStop }: Props): JSX.Element {
  const t = useT();
  return (
    <main className="launcher-scope screen-scope">
      <div className="launcher-pattern" aria-hidden="true">
        <div className="launcher-nebula" />
      </div>
      <section className="launcher-stage screen-stage" aria-labelledby="playing-title">
        <header className="screen-head">
          <span className="launcher-live-dot" aria-hidden="true" />
          <h1 id="playing-title">{world ? world.name : t("playing.title")}</h1>
        </header>
        <div className="launcher-console screen-console">
          <p className="launcher-caption">
            {t("playing.body")}
          </p>
          {hosted && (
            <p className="launcher-caption" role="status">
              <strong>{t("playing.hostingOn")}</strong>{" "}
              {t("playing.hostingBody", { address: `http://<this-computer>:${port ?? "port"}` })}
            </p>
          )}
          <div className="launcher-actions">
            <button className="launcher-btn launcher-btn-primary" onClick={onResume}>
              {t("playing.back")} <span aria-hidden="true">&#8594;</span>
            </button>
            <button className="launcher-btn launcher-btn-secondary" onClick={onStop}>
              {t("playing.stop")}
            </button>
          </div>
          <details className="screen-details">
            <summary>{t("playing.log")}</summary>
            <pre className="screen-log">{lines.join("\n") || t("playing.quiet")}</pre>
          </details>
        </div>
      </section>
    </main>
  );
}
