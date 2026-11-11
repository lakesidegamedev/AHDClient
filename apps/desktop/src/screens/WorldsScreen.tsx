import { useState } from "react";
import type { WorldMeta } from "../worlds.js";
import { eraForPreset } from "../worlds.js";
import { themeForEra } from "../launcher/CommandGlobe.js";
import { useT } from "../i18n.js";

interface Props {
  worlds: WorldMeta[];
  runningSlot: string | null;
  busy: boolean;
  error: string | null;
  onPlay: (slot: string) => void;
  onHost: (slot: string) => void;
  onDelete: (slot: string) => void;
  onSaves: (slot: string) => void;
  onBack: () => void;
}

function whenLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

export function WorldsScreen({ worlds, runningSlot, busy, error, onPlay, onHost, onDelete, onSaves, onBack }: Props): JSX.Element {
  const t = useT();
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <main className="launcher-scope screen-scope">
      <div className="launcher-pattern" aria-hidden="true">
        <div className="launcher-nebula" />
      </div>
      <section className="launcher-stage screen-stage" aria-labelledby="worlds-title">
        <header className="screen-head">
          <button className="launcher-btn launcher-btn-secondary screen-back" onClick={onBack}>
            <span aria-hidden="true">&#8592;</span> {t("common.back")}
          </button>
          <h1 id="worlds-title">{t("worlds.title")}</h1>
        </header>

        <div className="launcher-console screen-console">
          {error && (
            <div className="launcher-error" role="alert">
              <span>{error}</span>
            </div>
          )}
          {worlds.length === 0 ? (
            <p className="launcher-caption">{t("worlds.empty")}</p>
          ) : (
            <ul className="worlds-list">
              {worlds.map((world) => {
                const era = eraForPreset(world.preset);
                const theme = themeForEra(era?.id ?? "1953");
                const running = runningSlot === world.slot;
                return (
                  <li key={world.slot} className="worlds-row" data-running={running || undefined}>
                    <span className="launcher-era-swatch" style={{ backgroundColor: theme.phosphor }} aria-hidden="true" />
                    <div className="worlds-meta">
                      <strong>{world.name}{world.classic ? <span className="worlds-classic-tag"> {t("worlds.classic")}</span> : null}</strong>
                      <small>
                        {era?.label ?? world.preset}
                        {world.turn != null ? ` · ${t("world.turn", { turn: world.turn })}` : ""}
                        {world.character ? ` · ${world.character}` : ""}
                        {running ? ` · ${t("worlds.running")}` : ""}
                      </small>
                      <small>{t("worlds.lastPlayed", { when: whenLabel(world.lastPlayedAt) })}</small>
                    </div>
                    <div className="worlds-actions">
                      {confirming === world.slot ? (
                        <>
                          <button
                            className="launcher-btn launcher-btn-danger"
                            onClick={() => {
                              setConfirming(null);
                              onDelete(world.slot);
                            }}
                            disabled={running}
                          >
                            {t("worlds.deleteForGood")}
                          </button>
                          <button className="launcher-btn launcher-btn-secondary" onClick={() => setConfirming(null)}>
                            {t("common.keep")}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="launcher-btn launcher-btn-primary"
                            onClick={() => onPlay(world.slot)}
                            disabled={busy}
                          >
                            {running ? t("launcher.resume") : t("worlds.play")}
                          </button>
                          {!running && (
                            <button
                              className="launcher-btn launcher-btn-secondary"
                              onClick={() => onHost(world.slot)}
                              disabled={busy}
                              title={t("worlds.hostTitle")}
                            >
                              {t("worlds.host")}
                            </button>
                          )}
                          <button
                            className="launcher-btn launcher-btn-secondary"
                            onClick={() => onSaves(world.slot)}
                            disabled={busy}
                            title={t("toolbar.savesTitle")}
                          >
                            {t("worlds.saves")}
                          </button>
                          <button
                            className="launcher-btn launcher-btn-secondary"
                            onClick={() => setConfirming(world.slot)}
                            disabled={busy || running}
                            title={running ? t("worlds.deleteRunningTitle") : t("worlds.deleteTitle")}
                          >
                            {t("common.delete")}
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}
