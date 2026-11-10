import { useEffect, useRef, useState } from "react";
import { ERAS } from "../worlds.js";
import { ERA_PHOTOS } from "../launcher/eraPhotos.js";
import ahdLogo from "../assets/ahd-logo.png";
import { bootStep, formatElapsed } from "./bootStep.js";

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

const TIPS = [
  "Build political capital before proposing contentious legislation. A failed vote can cost more than waiting one turn.",
  "Check inflation alongside growth. A booming economy can still punish households and weaken approval.",
  "State and regional politics can diverge sharply from national polling. Local organization matters.",
  "Corporations create jobs and tax revenue, but concentrated market power can become a political liability.",
  "High leverage amplifies both growth and losses. Review liquidity before expanding through debt.",
  "Coalition partners have their own priorities. Keep enough common ground to survive confidence votes.",
  "Energy shortages travel through production chains. Strategic reserves buy time, not a permanent solution.",
  "Your cabinet is more than decoration. Strong appointments improve the government’s ability to deliver policy.",
  "Read the election calendar before spending campaign resources. Timing can matter as much as total spending.",
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
  const step = liveProgress ? { label: liveProgress.label, detail: liveProgress.detail } : (bootStep(lines) ?? { label: "Starting the local game", detail: "Loading the server and database" });
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
              <span>Your world is kept. You can try again or go back.</span>
              {failureDetails && (
                <details className="screen-details">
                  <summary>Details</summary>
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
                  <em>
                    Still waiting. The last setup step has not reported progress
                    for 30 seconds.
                  </em>
                )}
              </div>
              <div
                className={`boot-progress${liveProgress ? "" : " indeterminate"}`}
                role="progressbar"
                aria-label="Building world"
                aria-valuemin={0}
                aria-valuemax={100}
                {...(liveProgress ? { "aria-valuenow": Math.round(progress) } : {})}
              >
                <span style={liveProgress ? { width: `${progress}%` } : undefined} />
              </div>
              <div className="boot-elapsed" aria-label="Time so far">Time so far {formatElapsed(elapsed)}</div>
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
              <span className="boot-hint-label">Gameplay hint</span>
              <p>{TIPS[slide]}</p>
            </div>
          </article>
          <div className="boot-card-track" aria-label="Loading stories">
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
              <summary>Technical startup log</summary>
              <pre className="screen-log" aria-live="polite">
                {lines.length === 0
                  ? "Starting the game server"
                  : lines.join("\n")}
              </pre>
            </details>
          )}
          <div className="launcher-actions">
            {failure ? (
              <>
                {onRetry && (
                  <button className="launcher-btn launcher-btn-primary" onClick={onRetry}>
                    Try again
                  </button>
                )}
                <button className="launcher-btn launcher-btn-secondary" onClick={onBack ?? onCancel}>
                  Back
                </button>
              </>
            ) : (
              <button
                className="launcher-btn launcher-btn-secondary"
                onClick={onCancel}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
