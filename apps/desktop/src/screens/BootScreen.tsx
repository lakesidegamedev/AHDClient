import { useEffect, useRef, useState } from "react";
import { ERAS } from "../worlds.js";
import { ERA_PHOTOS } from "../launcher/eraPhotos.js";
import ahdLogo from "../assets/ahd-logo.png";
import { bootStep, formatElapsed } from "./bootStep.js";
import { useT, type TranslationKey } from "../i18n.js";

interface Props {
  title: string;
  lines: string[];
  onCancel: () => void;
  showDebug: boolean;
  progress?: {
    label: string;
    detail: string;
    progress: number;
    stalled: boolean;
  } | null;
  /** The start or setup failed: stay here and offer another try. */
  failure?: { message: string } | null;
  onRetry?: (() => void) | undefined;
  onBack?: () => void;
}

const TIPS: readonly TranslationKey[] = [
  "boot.tip1",
  "boot.tip2",
  "boot.tip3",
  "boot.tip4",
  "boot.tip5",
  "boot.tip6",
  "boot.tip7",
  "boot.tip8",
  "boot.tip9",
];

/** Shown while the local server (and on first run, MongoDB) comes up. */
export function BootScreen({
  title,
  lines,
  onCancel,
  showDebug,
  progress: liveProgress,
  failure,
  onRetry,
  onBack,
}: Props): JSX.Element {
  const t = useT();
  const [slide, setSlide] = useState(0);
  const [cardVisible, setCardVisible] = useState(true);
  useEffect(() => {
    let swapTimer: number | undefined;
    const timer = window.setInterval(() => {
      setCardVisible(false);
      swapTimer = window.setTimeout(() => {
        setSlide((value) => (value + 1) % TIPS.length);
        window.requestAnimationFrame(() => setCardVisible(true));
      }, 380);
    }, 5500);
    return () => {
      window.clearInterval(timer);
      if (swapTimer !== undefined) window.clearTimeout(swapTimer);
    };
  }, []);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (failure) return undefined;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed((Date.now() - started) / 1000), 1000);
    return () => window.clearInterval(timer);
  }, [failure]);
  const era = ERAS[slide % ERAS.length]!;
  const photo = ERA_PHOTOS[era.id]!;
  const highestProgress = useRef(0);
  // No invented percentages: the bar keeps moving without a number until the
  // game reports real setup progress.
  if (liveProgress) {
    highestProgress.current = Math.max(highestProgress.current, Math.min(100, Math.max(0, liveProgress.progress)));
  }
  const progress = highestProgress.current;
  const step = liveProgress ? { label: liveProgress.label, detail: liveProgress.detail } : (bootStep(lines, t) ?? { label: t("boot.startingLocal"), detail: t("boot.startingLocalText") });
  // A failed start ends with the game's own output after a first line. Players
  // see the first line; the rest is behind Details.
  const [failureHeadline, ...failureRest] = (failure?.message ?? "").split("\n");
  const failureDetails = failureRest.join("\n").trim();
  return (
    <main className="launcher-scope screen-scope">
      <div className="launcher-pattern" aria-hidden="true">
        <div className="launcher-nebula" />
      </div>
      <section
        className="launcher-stage screen-stage"
        aria-labelledby="boot-title"
        aria-busy="true"
      >
        <header className="screen-head boot-head">
          <img className="boot-logo" src={ahdLogo} alt="" />
          <div>
            <p className="boot-eyebrow">A House Divided</p>
            <h1 id="boot-title">{title}</h1>
          </div>
        </header>
        <div className="screen-console">
          {failure ? (
            <div className="boot-failure" role="alert">
              <strong>{failureHeadline}</strong>
              <span>{t("boot.failureText")}</span>
              {failureDetails && (
                <details className="screen-details">
                  <summary>{t("common.details")}</summary>
                  <pre className="screen-log">{failureDetails}</pre>
                </details>
              )}
            </div>
          ) : (
            <div className="boot-progress-wrap">
              <div className="boot-current" aria-live="polite">
                <strong>{step.label}</strong>
                <span>{step.detail}</span>
                {liveProgress?.stalled && (
                  <em>{t("boot.stalled")}</em>
                )}
              </div>
              <div
                className={`boot-progress${liveProgress ? "" : " indeterminate"}`}
                role="progressbar"
                aria-label={t("boot.progressLabel")}
                aria-valuemin={0}
                aria-valuemax={100}
                {...(liveProgress ? { "aria-valuenow": Math.round(progress) } : {})}
              >
                <span style={liveProgress ? { width: `${progress}%` } : undefined} />
              </div>
              <div className="boot-elapsed" aria-label={t("boot.elapsedLabel")}>{t("boot.elapsed", { time: formatElapsed(elapsed) })}</div>
            </div>
          )}
          <article
            className={`boot-story ${cardVisible ? "visible" : ""}`}
            aria-live="polite"
          >
            <img src={photo.src} alt={photo.alt} />
            <div>
              <p className="boot-kicker">
                {era.label} · {era.subtitle}
              </p>
              <h2>{era.subtitle}</h2>
              <span className="boot-hint-label">{t("boot.hint")}</span>
              <p>{t(TIPS[slide]!)}</p>
            </div>
          </article>
          <div className="boot-card-track" aria-label={t("boot.stories")}>
            {TIPS.map((_tip, index) => (
              <span
                key={index}
                className={index === slide ? "active" : ""}
                aria-current={index === slide ? "true" : undefined}
              >
                {index + 1}
              </span>
            ))}
          </div>
          {showDebug && (
            <details className="screen-details">
              <summary>{t("boot.log")}</summary>
              <pre className="screen-log" aria-live="polite">
                {lines.length === 0
                  ? t("boot.logEmpty")
                  : lines.join("\n")}
              </pre>
            </details>
          )}
          <div className="launcher-actions">
            {failure ? (
              <>
                {onRetry && (
                  <button className="launcher-btn launcher-btn-primary" onClick={onRetry}>
                    {t("boot.retry")}
                  </button>
                )}
                <button className="launcher-btn launcher-btn-secondary" onClick={onBack ?? onCancel}>
                  {t("common.back")}
                </button>
              </>
            ) : (
              <button
                className="launcher-btn launcher-btn-secondary"
                onClick={onCancel}
              >
                {t("common.cancel")}
              </button>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
