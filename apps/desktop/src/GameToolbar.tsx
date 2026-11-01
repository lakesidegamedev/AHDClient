import { useCallback, useEffect, useRef, useState } from "react";
import { game } from "./worlds.js";
import type { SingleplayerStatus } from "./worlds.js";

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
  /** Worldsim only: return to the world statistics screen. */
  onViewStats?: (() => void) | undefined;
  onTurnAdvanced?: (turn: number) => void;
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
  onViewStats,
  onTurnAdvanced,
}: Props): JSX.Element {
  const [turnState, setTurnState] = useState<TurnState | null>(null);
  const [availability, setAvailability] = useState<"open" | "sealed" | null>(null);
  const [endingTurn, setEndingTurn] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [turnBriefing, setTurnBriefing] = useState<string | null>(null);
  const [turnError, setTurnError] = useState<string | null>(null);
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

  const endTurn = async () => {
    if (endingTurn) return;
    setEndingTurn(true);
    setTurnError(null);
    try {
      const result = worldsim ? await game.advanceWorldsim() : await game.advanceTurn();
      const briefing = result.briefing;
      const signed = (value: number) => `${value >= 0 ? "+" : ""}${value.toLocaleString()}`;
      setTurnBriefing(briefing
        ? `Turn ${result.turn}: funds ${signed(briefing.fundsDelta)}, actions ${signed(briefing.actionsDelta)}`
        : `Turn ${result.turn} complete`);
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
  const endTurnTitle = endingTurn
    ? "The turn is running"
    : paused
      ? "Resume the world to advance the turn"
      : turnState == null
        ? "Checking for your character"
        : !worldsim && !turnState.hasCharacter
          ? "Create a character in the game to enable End turn"
          : "Advance the world by one turn";
  const headOfState = turnState?.mode === "head-of-state";

  return (
    <nav className="client-game-toolbar" aria-label="Client controls">
      <button type="button" className="client-toolbar-quiet" onClick={onLauncher}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m14 6-6 6 6 6M8 12h12" /></svg>
        Launcher
      </button>
      <button
        type="button"
        className="client-toolbar-end-turn"
        disabled={!canEndTurn}
        title={turnError ?? endTurnTitle}
        onClick={() => void endTurn()}
      >
        {endingTurn ? <span className="client-toolbar-spinner" aria-hidden="true" /> : <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m5 5 10 7L5 19ZM19 5v14" /></svg>}
        {endingTurn ? "Running turn" : "End turn"}
      </button>
      <button
        type="button"
        className="client-toolbar-quiet"
        onClick={onOpenAsk}
        title="Ask questions about the game. Opens beside play and signs you in with your game account."
        aria-label="Ask about the game"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>
        Ask
      </button>
      <strong title={worldName}>{worldName}</strong>
      {endingTurn && <span className="client-toolbar-progress" role="status" aria-label="Running turn"><span className="client-toolbar-spinner" aria-hidden="true" /><span><b>Simulating</b><small className="client-toolbar-turn">Turn {turnState?.turn ?? ""}</small></span></span>}
      {turnBriefing && <small className="client-toolbar-briefing" role="status" title={turnBriefing}>{turnBriefing}</small>}
      {headOfState && (
        <small
          className="client-toolbar-mode"
          title="Permanent head of state. You entered as head of state and remain head of state; this mode is in beta."
        >
          Head of state <span className="client-beta">Beta</span>
        </small>
      )}
      {paused && (
        <small title="Paused: the current turn finishes, the next one waits until you resume.">
          Paused
        </small>
      )}
      {worldsim && onViewStats && (
        <button type="button" className="client-toolbar-quiet" onClick={onViewStats}>
          World statistics
        </button>
      )}
      {turnError && (
        <span className="client-toolbar-error" role="alert">
          {turnError}
        </span>
      )}
      <details className="client-toolbar-overflow" onToggle={(event) => setMenuOpen(event.currentTarget.open)}>
        <summary aria-label={menuOpen ? "Close actions" : "More actions"}>{menuOpen ? "×" : "···"}</summary>
        <div role="menu">
          <button
            role="menuitem"
            type="button"
            disabled={availability == null || pauseBusy}
            title={
              paused
                ? "Resume the world so turns can advance again."
                : "Pause the world. The current turn finishes; the next one waits until you resume."
            }
            onClick={() => void togglePause()}
          >
            {pauseBusy ? "Working" : paused ? "Resume world" : "Pause world"}
          </button>
          <button
            role="menuitem"
            type="button"
            disabled={endingTurn}
            title={endingTurn ? "Saves are available when the turn finishes." : "Save the world, or go back to an earlier save."}
            onClick={onOpenSaves}
          >
            Saves
          </button>
          <button role="menuitem" type="button" onClick={onSaveAndStop}>
            Save and stop
          </button>
        </div>
      </details>
    </nav>
  );
}
