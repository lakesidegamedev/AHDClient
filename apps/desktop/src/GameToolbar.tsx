import { useCallback, useEffect, useRef, useState } from "react";
import { game } from "./worlds.js";
import { useT, type TranslationKey, type Translator } from "./i18n.js";
import { UpdateChip } from "./UpdateChip.js";
import { useDialog } from "./useDialog.js";
import type { BatchDigest, SingleplayerStatus, TurnBatch } from "./worlds.js";

/** Turn counts the End turn control offers in a normal world. */
export const BATCH_TURN_CHOICES = [1, 3, 5, 10] as const;

interface Props {
  worldName: string;
  /** Worldsim is playerless: End turn skips the character gate and advances one turn. */
  worldsim: boolean;
  onLauncher: () => void;
  onSaveAndStop: () => void;
  /** Open the saves dialog for this world. */
  onOpenSaves: () => void;
  /** Open the player Q&A panel beside the game. */
  onOpenAsk: () => void;
  /** Open Settings from the update chip. Omit to hide the chip. */
  onOpenUpdates?: (() => void) | undefined;
  /** Worldsim only: return to the world statistics screen. */
  onViewStats?: (() => void) | undefined;
  onTurnAdvanced?: (turn: number) => void;
  /** Tells the shell a toolbar dialog is open, so it can hide the embedded game view. */
  onDialogOpenChange?: ((open: boolean) => void) | undefined;
}

interface TurnState {
  hasCharacter: boolean;
  characterName: string | null;
  turn: number | null;
  mode: SingleplayerStatus["mode"];
}

async function readTurnState(): Promise<TurnState | null> {
  try {
    const status: SingleplayerStatus = await game.singleplayerStatus();
    return {
      hasCharacter: status.hasCharacter,
      characterName: status.characterName,
      turn: status.turn,
      mode: status.mode,
    };
  } catch {
    return null;
  }
}

/** How often the toolbar re-reads turn and pause state while the game runs. */
const STATUS_POLL_MS = 10_000;
/** How often a running multi-turn advance is checked for progress. */
const BATCH_POLL_MS = 1_000;
/** A batch is given up on after this many unanswered progress checks in a row. */
const BATCH_POLL_MAX_FAILURES = 5;

const signed = (value: number) => `${value >= 0 ? "+" : ""}${value.toLocaleString()}`;

const CATEGORY_KEYS: Record<string, TranslationKey> = {
  crisis: "toolbar.catCrisis",
  legislation: "toolbar.catLegislation",
  election: "toolbar.catElection",
  party: "toolbar.catParty",
  standing: "toolbar.catStanding",
  treasury: "toolbar.catTreasury",
  system: "toolbar.catSystem",
};

const turnsLabel = (count: number, t: Translator) => t(count === 1 ? "toolbar.turnOne" : "toolbar.turnMany", { count });

/** One calm line for the toolbar: what the batch did and, if it ended early, why. */
function batchLine(batch: TurnBatch, t: Translator): string {
  const played = t("toolbar.played", { done: batch.completed, total: turnsLabel(batch.requested, t) });
  return batch.stop && batch.stop.kind !== "requested" ? `${played}. ${batch.stop.message}` : `${played}.`;
}

/** The batch digest as a dialog, so it is never trapped inside the 48 px strip or hidden under the game view. */
function BatchDigestDialog({ batch, onClose, onDismiss }: { batch: TurnBatch; onClose: () => void; onDismiss: () => void }): JSX.Element {
  const t = useT();
  const digest: BatchDigest | null = batch.digest;
  const dialogRef = useRef<HTMLElement>(null);
  useDialog(dialogRef, onClose);
  return (
    <div className="client-settings-backdrop" role="presentation">
      <section ref={dialogRef} className="client-diagnostic-dialog client-toolbar-digest" role="dialog" aria-modal="true" aria-labelledby="turn-summary-title">
        <h2 id="turn-summary-title">{t("toolbar.summaryTitle")}</h2>
        <p><b>{batchLine(batch, t)}</b></p>
        {batch.stop && batch.stop.details.length > 0 && (
          <ul>
            {batch.stop.details.map((detail) => <li key={detail}>{detail}</li>)}
          </ul>
        )}
        {digest && (
          <>
            <p>
              {t("toolbar.turnsRange", { start: digest.startTurn ?? "?", end: digest.endTurn ?? "?", funds: signed(digest.funds.delta), actions: signed(digest.actions.delta) })}
            </p>
            {(digest.officesWon.length > 0 || digest.officesLost.length > 0) && (
              <p>
                {digest.officesWon.length > 0 && <>{t("toolbar.won", { list: digest.officesWon.join(", ") })} </>}
                {digest.officesLost.length > 0 && <>{t("toolbar.lost", { list: digest.officesLost.join(", ") })}</>}
              </p>
            )}
            {digest.inbox.total > 0 && (
              <>
                <p>
                  {digest.inbox.total === 1 ? t("toolbar.inboxOne") : t("toolbar.inboxMany", { count: digest.inbox.total })}
                  {digest.inbox.actionRequired > 0 ? t("toolbar.inboxWaiting", { count: digest.inbox.actionRequired }) : ""}.
                </p>
                <ul>
                  {digest.inbox.groups.map((group) => (
                    <li key={group.category}>
                      {CATEGORY_KEYS[group.category] ? t(CATEGORY_KEYS[group.category]!) : group.category}: {group.count}
                      {group.titles.length > 0 ? ` (${group.titles.join("; ")})` : ""}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {digest.worldEvents.length > 0 && (
              <>
                <p>{t("toolbar.inWorld")}</p>
                <ul>
                  {digest.worldEvents.map((event) => <li key={`${event.turn}-${event.title}`}>{t("toolbar.worldEvent", { turn: event.turn, title: event.title })}</li>)}
                </ul>
              </>
            )}
          </>
        )}
        <div>
          <button className="secondary" type="button" onClick={onDismiss}>{t("toolbar.dismiss")}</button>
          <button type="button" onClick={onClose}>{t("common.close")}</button>
        </div>
      </section>
    </div>
  );
}

/**
 * The singleplayer shell: Launcher | End turn | world name | overflow. End
 * turn sits next to Launcher; everything destructive or rare lives behind
 * More. Identity, Settings and Diagnostics are deliberately absent here: the
 * game below owns identity and settings, and both dialogs stay reachable
 * through the launcher and the Escape shortcut. Briefing PiP is absent too:
 * it is the multiplayer briefing, and this bar only ever fronts the local
 * game.
 */
export function GameToolbar({
  worldName,
  worldsim,
  onLauncher,
  onSaveAndStop,
  onOpenSaves,
  onOpenAsk,
  onOpenUpdates,
  onViewStats,
  onTurnAdvanced,
  onDialogOpenChange,
}: Props): JSX.Element {
  const t = useT();
  const [turnState, setTurnState] = useState<TurnState | null>(null);
  const [availability, setAvailability] = useState<"open" | "sealed" | null>(null);
  const [endingTurn, setEndingTurn] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [turnBriefing, setTurnBriefing] = useState<string | null>(null);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [batchCount, setBatchCount] = useState<number>(1);
  const [batch, setBatch] = useState<TurnBatch | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  /** Guards the interval against overlapping reads on a slow local server. */
  const refreshing = useRef(false);
  const lastTurn = useRef<number | null>(null);

  const refreshTurn = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const next = await readTurnState();
      const previous = lastTurn.current;
      setTurnState(next);
      if (next?.turn != null) {
        // In-game End turn never hits the client button. Detect an
        // increased turn from the status poll so anonymous stats still upload.
        if (previous != null && next.turn > previous) onTurnAdvanced?.(next.turn);
        if (previous == null || next.turn >= previous) lastTurn.current = next.turn;
      }
    } finally {
      refreshing.current = false;
    }
  }, [onTurnAdvanced]);

  const refreshAvailability = useCallback(async () => {
    try {
      setAvailability((await game.worldAvailability()).availability);
    } catch {
      setAvailability(null);
    }
  }, []);

  useEffect(() => {
    void refreshTurn();
    void refreshAvailability();
    const refreshBoth = () => {
      void refreshTurn();
      void refreshAvailability();
    };
    window.addEventListener("focus", refreshBoth);
    // Character creation and death both happen inside the child game webview,
    // where the launcher window gets no focus event, and the server can be
    // paused out from under the toolbar. Keep polling at a sane interval for
    // as long as the bar is mounted; the interval dies with the toolbar when
    // the game stops.
    const timer = window.setInterval(refreshBoth, STATUS_POLL_MS);
    return () => {
      window.removeEventListener("focus", refreshBoth);
      window.clearInterval(timer);
    };
  }, [refreshTurn, refreshAvailability]);

  const advancedRef = useRef(onTurnAdvanced);
  advancedRef.current = onTurnAdvanced;
  const summaryShown = summaryOpen && batch != null && batch.status !== "running";
  useEffect(() => {
    onDialogOpenChange?.(summaryShown);
    return () => { if (summaryShown) onDialogOpenChange?.(false); };
  }, [summaryShown, onDialogOpenChange]);
  const batchRunning = batch?.status === "running";
  const batchId = batch?.id ?? null;

  // Watch a running batch. The game does the work in the background; this only
  // reads progress, so a toolbar that remounts mid-batch picks it back up below.
  useEffect(() => {
    if (!batchRunning) return;
    let failures = 0;
    let stopped = false;
    const timer = window.setInterval(async () => {
      try {
        const { batch: next } = await game.batchStatus();
        failures = 0;
        if (stopped || !next) return;
        setBatch(next);
        for (const done of next.turns) {
          if (lastTurn.current == null || done.turn > lastTurn.current) {
            lastTurn.current = done.turn;
            advancedRef.current?.(done.turn);
          }
        }
        if (next.status === "finished") {
          setEndingTurn(false);
          await refreshTurn();
          await refreshAvailability();
        }
      } catch (error) {
        failures += 1;
        if (failures >= BATCH_POLL_MAX_FAILURES && !stopped) {
          setEndingTurn(false);
          setBatch(null);
          setTurnError(error instanceof Error ? error.message : String(error));
        }
      }
    }, BATCH_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [batchRunning, batchId, refreshTurn, refreshAvailability]);

  useEffect(() => {
    if (worldsim) return;
    void (async () => {
      try {
        const { batch: current } = await game.batchStatus();
        if (current?.status === "running") {
          setBatch(current);
          setEndingTurn(true);
        }
      } catch {
        // No batch to resume, or the game is not answering yet.
      }
    })();
  }, [worldsim]);

  const startBatch = async () => {
    setBatch(null);
    try {
      const { batch: started } = await game.startBatch(batchCount);
      setBatch(started);
    } catch (error) {
      setEndingTurn(false);
      setTurnError(error instanceof Error ? error.message : String(error));
    }
  };

  const stopBatch = async () => {
    try {
      const { batch: stopping } = await game.stopBatch();
      setBatch(stopping);
    } catch {
      // It finished while the request was on its way; the next progress check shows the result.
    }
  };

  const endTurn = async () => {
    if (endingTurn) return;
    setEndingTurn(true);
    setTurnError(null);
    if (!worldsim && batchCount > 1) {
      await startBatch();
      return;
    }
    try {
      const result = worldsim ? await game.advanceWorldsim() : await game.advanceTurn();
      const briefing = result.briefing;
      setTurnBriefing(briefing
        ? t("toolbar.turnBriefing", { turn: result.turn, funds: signed(briefing.fundsDelta), actions: signed(briefing.actionsDelta) })
        : t("toolbar.turnDone", { turn: result.turn }));
      onTurnAdvanced?.(result.turn);
      lastTurn.current = result.turn;
      await refreshTurn();
      await refreshAvailability();
    } catch (error) {
      setTurnError(error instanceof Error ? error.message : String(error));
    } finally {
      setEndingTurn(false);
    }
  };

  const togglePause = async () => {
    if (pauseBusy || availability == null) return;
    setPauseBusy(true);
    setTurnError(null);
    try {
      const next = await game.setWorldAvailability(availability === "open" ? "sealed" : "open");
      setAvailability(next.availability);
    } catch (error) {
      setTurnError(error instanceof Error ? error.message : String(error));
    } finally {
      setPauseBusy(false);
    }
  };

  const paused = availability === "sealed";
  // Worldsim is exempt from the character gate only. Paused, busy and
  // not-yet-loaded disable End turn for both modes: the server answers 409
  // while paused, and an unknown state must not offer a turn that fails.
  const canEndTurn =
    !endingTurn && availability === "open" && turnState != null && (worldsim || turnState.hasCharacter);
  // The Game menu's End turn (Ctrl or Cmd+E) arrives as a window event. It
  // does exactly what the button does, including doing nothing when the
  // button is disabled.
  const pressEndTurn = useRef<() => void>(() => {});
  pressEndTurn.current = () => { if (canEndTurn) void endTurn(); };
  useEffect(() => {
    const onKey = () => pressEndTurn.current();
    window.addEventListener("ahdclient:end-turn", onKey);
    return () => window.removeEventListener("ahdclient:end-turn", onKey);
  }, []);

  const endTurnTitle = endingTurn
    ? t("toolbar.turnRunning")
    : paused
      ? t("toolbar.resumeToAdvance")
      : turnState == null
        ? t("toolbar.checkingCharacter")
        : !worldsim && !turnState.hasCharacter
          ? t("toolbar.needCharacter")
          : !worldsim && batchCount > 1
            ? t("toolbar.advanceMany", { count: batchCount })
            : t("toolbar.advanceOne");
  const batchTurnNumber = batch && batchRunning ? Math.min(batch.completed + 1, batch.requested) : null;
  const headOfState = turnState?.mode === "head-of-state";

  return (
    <nav className="client-game-toolbar" aria-label={t("toolbar.aria")}>
      <button type="button" className="client-toolbar-quiet" onClick={onLauncher}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m14 6-6 6 6 6M8 12h12" /></svg>
        {t("toolbar.launcher")}
      </button>
      <button
        type="button"
        className="client-toolbar-end-turn"
        disabled={!canEndTurn}
        title={turnError ?? endTurnTitle}
        onClick={() => void endTurn()}
      >
        {endingTurn ? <span className="client-toolbar-spinner" aria-hidden="true" /> : <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m5 5 10 7L5 19ZM19 5v14" /></svg>}
        {endingTurn ? t("toolbar.runningTurn") : batchCount > 1 && !worldsim ? t("toolbar.endMany", { count: batchCount }) : t("toolbar.endTurn")}
      </button>
      {!worldsim && (
        <select
          className="client-toolbar-count"
          aria-label={t("toolbar.turnsToPlay")}
          value={batchCount}
          disabled={endingTurn}
          onChange={(event) => setBatchCount(Number(event.target.value))}
        >
          {BATCH_TURN_CHOICES.map((count) => (
            <option key={count} value={count}>{turnsLabel(count, t)}</option>
          ))}
        </select>
      )}
      <button
        type="button"
        className="client-toolbar-quiet client-toolbar-ask"
        onClick={onOpenAsk}
        title={t("toolbar.askTitle")}
        aria-label={t("toolbar.askAria")}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>
        {t("toolbar.ask")}
      </button>
      <strong title={worldName}>{worldName}</strong>
      {onOpenUpdates && <UpdateChip onClick={onOpenUpdates} />}
      {endingTurn && (
        <span className="client-toolbar-progress" role="status" aria-label={t("toolbar.runningTurn")}>
          <span className="client-toolbar-spinner" aria-hidden="true" />
          <span>
            <b>{t("toolbar.simulating")}</b>
            <small className="client-toolbar-turn">
              {batchTurnNumber != null && batch ? t("toolbar.turnOfBatch", { turn: batchTurnNumber, total: batch.requested }) : t("toolbar.turnNow", { turn: turnState?.turn ?? "" })}
            </small>
          </span>
        </span>
      )}
      {batchRunning && (
        <button type="button" className="client-toolbar-quiet" disabled={batch?.stopRequested} onClick={() => void stopBatch()}>
          {batch?.stopRequested ? t("toolbar.stopping") : t("toolbar.stopAfter")}
        </button>
      )}
      {batch && !batchRunning && <small className="client-toolbar-briefing" role="status" title={batchLine(batch, t)}>{batchLine(batch, t)}</small>}
      {batch && !batchRunning && (
        <button type="button" className="client-toolbar-quiet" onClick={() => setSummaryOpen(true)}>{t("toolbar.summary")}</button>
      )}
      {batch && !batchRunning && summaryOpen && (
        <BatchDigestDialog batch={batch} onClose={() => setSummaryOpen(false)} onDismiss={() => { setSummaryOpen(false); setBatch(null); }} />
      )}
      {turnBriefing && <small className="client-toolbar-briefing" role="status" title={turnBriefing}>{turnBriefing}</small>}
      {headOfState && (
        <small
          className="client-toolbar-mode"
          title={t("toolbar.headOfStateTitle")}
        >
          {t("toolbar.headOfState")} <span className="client-beta">{t("toolbar.beta")}</span>
        </small>
      )}
      {paused && (
        <small title={t("toolbar.pausedTitle")}>
          {t("toolbar.paused")}
        </small>
      )}
      {worldsim && onViewStats && (
        <button type="button" className="client-toolbar-quiet" onClick={onViewStats}>
          {t("toolbar.worldStats")}
        </button>
      )}
      {turnError && (
        <span className="client-toolbar-error" role="alert">
          {turnError}
        </span>
      )}
      <details className="client-toolbar-overflow" onToggle={(event) => setMenuOpen(event.currentTarget.open)}>
        <summary aria-label={menuOpen ? t("toolbar.closeActions") : t("toolbar.moreActions")}>{menuOpen ? "×" : "···"}</summary>
        <div role="menu">
          <button role="menuitem" type="button" className="client-toolbar-ask-menu" onClick={onOpenAsk}>
            {t("toolbar.askMenu")}
          </button>
          <button
            role="menuitem"
            type="button"
            disabled={availability == null || pauseBusy}
            title={
              paused
                ? t("toolbar.resumeTitle")
                : t("toolbar.pauseTitle")
            }
            onClick={() => void togglePause()}
          >
            {pauseBusy ? t("toolbar.working") : paused ? t("toolbar.resumeWorld") : t("toolbar.pauseWorld")}
          </button>
          <button
            role="menuitem"
            type="button"
            disabled={endingTurn}
            title={endingTurn ? t("toolbar.savesBusy") : t("toolbar.savesTitle")}
            onClick={onOpenSaves}
          >
            {t("saves.title")}
          </button>
          <button role="menuitem" type="button" onClick={onSaveAndStop}>
            {t("toolbar.saveStop")}
          </button>
        </div>
      </details>
    </nav>
  );
}
