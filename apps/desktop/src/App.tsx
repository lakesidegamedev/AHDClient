import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { Launcher } from "./launcher/Launcher.js";
import { classicCapabilities, gameRuntime, legacyCapabilities } from "./capabilities.js";
import { ClassicDownload, formatDownloadSize } from "./ClassicDownload.js";
import type { Capabilities } from "./capabilities.js";
import { NewWorldScreen } from "./screens/NewWorldScreen.js";
import { WorldsScreen } from "./screens/WorldsScreen.js";
import { BootScreen } from "./screens/BootScreen.js";
import { WorldsimScreen } from "./screens/WorldsimScreen.js";
import { defaultSetupOptions } from "./screens/setupOptions.js";
import type { SetupOptions } from "./screens/setupOptions.js";
import { PlayingScreen } from "./screens/PlayingScreen.js";
import { AUTOSAVES_KEPT, CLASSIC_REQUIRED, ask, classicGame, eraById, game, online, slugForWorld, uniqueWorldName, worldSaves, worlds } from "./worlds.js";
import type { Era } from "./worlds.js";
import type {
  ClassicInfo,
  GameInfo,
  LinkedAccount,
  OnlineTarget,
  SaveMeta,
  SetupProgress,
  WorldMeta,
} from "./worlds.js";
import "./screens/screens.css";
import {
  captureStatistics,
  flushStatistics,
  setStatisticsConsent,
} from "./statisticsDelivery.js";
import { LanguageProvider, useT, type ClientLanguage } from "./i18n.js";
import { SettingsMenu } from "./SettingsMenu.js";
import { applySettings, readSettings, syncOpenGameOnStart, writeSettings } from "./settings.js";
import type { ClientSettings } from "./settings.js";
import {
  cacheSingleplayerEntitlement,
  hasCachedSingleplayerEntitlement,
} from "./entitlement.js";
import { UpdateNotice } from "./UpdateNotice.js";
import { startUpdateSchedule } from "./updater.js";
import { AccountControl } from "./AccountControl.js";
import { clearCachedAskSession } from "./ask/session.js";
import { GameToolbar } from "./GameToolbar.js";
import { SavesDialog } from "./SavesDialog.js";
import { CloseDialog } from "./CloseDialog.js";
import { GameVersionLine } from "./GameVersionBar.js";
import { DiagnosticPrompt } from "./DiagnosticPrompt.js";
import { CrashDialog } from "./CrashDialog.js";
import { describeExit } from "./crash.js";
import { DiagnosticPanel } from "./DiagnosticPanel.js";
import { ShortcutsDialog } from "./ShortcutsDialog.js";
import { diagnosticRuntime, recordDiagnostic, submitAutomaticDiagnostics, submitDiagnostics, type DiagnosticReason } from "./diagnostics.js";
import { mobile, platform } from "./platform.js";
import { reportIssueRoute } from "./help.js";
import { Briefing } from "./briefing/Briefing.js";
import { briefing } from "./briefing/briefingApi.js";

type Screen =
  | "launcher"
  | "newWorld"
  | "worlds"
  | "booting"
  | "playing"
  | "online"
  | "linking"
  | "briefing"
  | "worldsim";

/** What the player was doing when we sent them to link their account. */
type LinkIntent =
  | { kind: "new"; eraId: string; worldsim: boolean; classic: boolean }
  | { kind: "quick"; eraId: string };

/** A failed start, kept on the boot screen so the player can try again. */
interface BootFailure {
  message: string;
  slot: string;
  fresh: { preset: string; displayName?: string; setup: SetupOptions } | null;
  hosted: boolean;
}

const IDLE: GameInfo = { running: false, hosted: false, port: null, slot: null, url: null };
const LOG_LINES = 14;
function accountNoticeSeen(): boolean {
  try {
    return localStorage.getItem("ahdclient.accountNotice") === "seen";
  } catch {
    return false;
  }
}
function rememberAccountNotice(): void {
  try {
    localStorage.setItem("ahdclient.accountNotice", "seen");
  } catch {
    /* Session state still remembers dismissal. */
  }
}

/** Holds the language for every screen below it (read from `useT`), fed by the settings inside. */
export function App(): JSX.Element {
  const [language, setLanguage] = useState<ClientLanguage>(() => readSettings().language);
  return (
    <LanguageProvider language={language}>
      <AppShell onLanguage={setLanguage} />
    </LanguageProvider>
  );
}

function AppShell({ onLanguage }: { onLanguage: (language: ClientLanguage) => void }): JSX.Element {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  // The in-game menu's Briefing item returns to the launcher with
  // ?screen=briefing (mobile.rs). Consumed once so a reload lands home.
  const [screen, setScreen] = useState<Screen>(() => {
    if (!mobile || new URLSearchParams(location.search).get("screen") !== "briefing") return "launcher";
    history.replaceState(null, "", location.pathname);
    return "briefing";
  });
  // The phone tab bar reads the page address to highlight Briefing or More,
  // so the Briefing screen marks itself with #briefing. A reload still lands
  // on the launcher: only ?screen=briefing opens the briefing.
  useEffect(() => {
    if (!mobile) return;
    const wanted = screen === "briefing" ? "#briefing" : "";
    if (location.hash !== wanted) history.replaceState(null, "", location.pathname + location.search + wanted);
  }, [screen]);
  const [allWorlds, setAllWorlds] = useState<WorldMeta[]>([]);
  const [info, setInfo] = useState<GameInfo>(IDLE);
  const [capabilities, setCapabilities] = useState<Capabilities | undefined>(undefined);
  useEffect(() => {
    if (mobile) return;
    let live = true;
    // The launcher and setup screen fall back to the older table on their own.
    void gameRuntime
      .capabilities()
      .then((next) => {
        if (live) setCapabilities(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  // The Classic game (last release before 1.20): older eras and pre-1.20 worlds.
  const [classic, setClassic] = useState<ClassicInfo | null>(null);
  const [classicPrompt, setClassicPrompt] = useState<{ slot: string | null; hosted: boolean } | null>(null);
  const [pendingClassic, setPendingClassic] = useState(false);
  const refreshClassic = useCallback(async () => {
    try {
      setClassic(await classicGame.info());
    } catch {
      setClassic(null);
    }
  }, []);
  useEffect(() => {
    if (!mobile) void refreshClassic();
  }, [refreshClassic]);
  const [pendingWorldsim, setPendingWorldsim] = useState(false);
  const [runningWorldsim, setRunningWorldsim] = useState(false);
  const [pendingEra, setPendingEra] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Refusal inside world setup: the form stays mounted, with a link CTA. */
  const [setupError, setSetupError] = useState<string | null>(null);
  /** Entry-gate refusal on the launcher: the error box offers Link account. */
  const [entitlementBlocked, setEntitlementBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const afterLink = useRef<LinkIntent | null>(null);
  const resumeAfterLink = useRef<(intent: LinkIntent) => void>(() => {});
  const [bootFailure, setBootFailure] = useState<BootFailure | null>(null);
  const [crash, setCrash] = useState<{ slot: string | null; message: string } | null>(null);
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const slotRef = useRef<string | null>(null);
  const closeRequestRef = useRef<() => Promise<void>>(async () => {});
  const [bootTitle, setBootTitle] = useState("Starting");
  const [bootProgress, setBootProgress] = useState<SetupProgress | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [diagnosticIncident, setDiagnosticIncident] = useState<{ reason: DiagnosticReason; message: string; lines: string[] } | null>(null);
  const [sendingDiagnostics, setSendingDiagnostics] = useState(false);
  const cancelled = useRef(false);
  const bootId = useRef(0);
  const creating = useRef(false);
  const [settings, setSettings] = useState(readSettings);
  slotRef.current = info.slot;
  const [account, setAccount] = useState<LinkedAccount | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [accountChecked, setAccountChecked] = useState(false);
  const [embedded, setEmbedded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Check for updates on every screen for as long as the app stays open.
  useEffect(() => (mobile ? undefined : startUpdateSchedule()), []);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** Slot whose saves dialog is open, if any. */
  const [savesFor, setSavesFor] = useState<string | null>(null);
  const [worldSizes, setWorldSizes] = useState<Record<string, number>>({});
  const [worldNotice, setWorldNotice] = useState<string | null>(null);
  /** Set while a save is being loaded, so the next boot can report how it went. */
  const loadingSave = useRef(false);
  /**
   * The embedded child webview sits above launcher DOM, so open launcher
   * dialogs (settings, diagnostics) must hide it to be usable. The view is
   * hidden, never closed or navigated, so the child keeps its current path
   * (including /profile) and session; it is shown again when the last dialog
   * closes. Derived from the union, so the settings to diagnostics handoff
   * never flashes the game back. Mobile has no embedded views to hide.
   */
  const [closing, setClosing] = useState<"confirm" | "saving" | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const dialogOpen = settingsOpen || diagnosticsOpen || shortcutsOpen || savesFor != null || closing != null || summaryOpen;
  useEffect(() => {
    if (mobile || !embedded) return;
    void game.setEmbeddedVisible(!dialogOpen).catch(() => {});
  }, [dialogOpen, embedded]);
  const [accountNotice, setAccountNotice] = useState(
    () => !accountNoticeSeen(),
  );
  useEffect(() => {
    onLanguage(settings.language);
  }, [settings.language]);
  useEffect(() => {
    applySettings(settings);
    if (mobile) {
      void syncOpenGameOnStart(settings.openGameOnStart);
      return;
    }
    void setStatisticsConsent(settings.shareStatistics)
      .then(() => flushStatistics())
      .catch(() => {});
  }, [settings]);
  useEffect(() => {
    const retry = () => {
      void flushStatistics();
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, []);
  // The autosave interval is a client setting but lives with each world, so
  // it is handed to whichever world is running whenever it starts or changes.
  useEffect(() => {
    if (mobile || !info.running) return;
    void game.setAutosaveEvery(settings.autosaveEvery).catch(() => {});
  }, [info.running, info.slot, settings.autosaveEvery]);
  const changeSettings = (next: ClientSettings) => {
    // Clear pending data before saving an opt-out so a storage error cannot
    // leave previously queued reports available for transmission.
    if (!next.shareStatistics) void setStatisticsConsent(false).catch(() => {});
    setSettings(next);
    try {
      writeSettings(next);
    } catch {
      setError(t("app.settingsNotSaved"));
    }
  };
  const checkAccount = useCallback(async () => {
    try {
      const linked = await online.account();
      if (linked?.singleplayer)
        cacheSingleplayerEntitlement(linked.singleplayer);
      setAccount(linked?.linked ? linked : null);
      setAccountChecked(true);
      return linked;
    } catch {
      return null;
    }
  }, []);
  /**
   * Pure entitlement check: no navigation, so callers decide what survives a
   * refusal. The setup screen keeps its form; the launcher keeps its place.
   */
  const checkSingleplayerEntitlement =
    useCallback(async (): Promise<
      { ok: true } | { ok: false; linked: boolean; offline: boolean }
    > => {
      try {
        const linked = await online.account();
        setAccount(linked?.linked ? linked : null);
        setAccountChecked(true);
        if (linked?.singleplayer.entitled) {
          cacheSingleplayerEntitlement(linked.singleplayer);
          return { ok: true };
        }
        return { ok: false, linked: Boolean(linked), offline: false };
      } catch {
        if (hasCachedSingleplayerEntitlement()) return { ok: true };
        return { ok: false, linked: false, offline: true };
      }
    }, []);
  const entitlementError = (
    result: { linked: boolean; offline: boolean },
  ): string => {
    if (result.offline)
      return t("app.entitlementOffline");
    return result.linked
      ? t("app.entitlementOff")
      : t("app.entitlementLink");
  };
  useEffect(() => {
    void checkAccount();
  }, [checkAccount]);
  useEffect(() => {
    if (screen !== "linking") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 10 * 60 * 1000;
    const poll = async () => {
      const linked = await checkAccount();
      if (!active) return;
      if (linked?.linked) {
        await game.closeEmbedded();
        if (!active) return;
        setEmbedded(false);
        setScreen("launcher");
        setAccountNotice(false);
        setEntitlementBlocked(false);
        rememberAccountNotice();
        const intent = afterLink.current;
        afterLink.current = null;
        if (intent) resumeAfterLink.current(intent);
      } else if (Date.now() < deadline)
        timer = setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [screen, checkAccount]);

  const refreshWorlds = useCallback(async () => {
    if (mobile) return;
    try {
      setAllWorlds(await worlds.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Ctrl or Cmd plus K opens Ask from the launcher too (the game has its own
  // copy of this shortcut, and the native menu carries the accelerator).
  useEffect(() => {
    if (mobile) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k" && !event.repeat) {
        event.preventDefault();
        void ask.open().catch(fail);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (mobile) return;
    void refreshWorlds();
    void game
      .status()
      .then(setInfo)
      .catch(() => setInfo(IDLE));
  }, [refreshWorlds]);

  useEffect(() => {
    const subscriptions = [
      listen<{ line: string }>("game:log", (event) => {
        recordDiagnostic("native", event.payload.line);
        setLog((lines) => [...lines, event.payload.line].slice(-LOG_LINES));
      }),
      listen<{ line: string }>("game:exited", (event) => {
        const slot = slotRef.current;
        const current = screenRef.current;
        setInfo(IDLE);
        if (current === "playing" || current === "worldsim") {
          // The world stopped by itself: offer a restart instead of a dead end.
          setEmbedded(false);
          setCrash({ slot, message: describeExit(event.payload.line, tRef.current) });
          setScreen("launcher");
        }
        // While booting, the start itself reports the failure with a retry.
        void refreshWorlds();
      }),
      // The online site redirected the account link page to its maintenance
      // screen. Never show that page as if single-player had failed: drop
      // back to the launcher with a local explanation.
      listen("account-link:maintenance", () => {
        afterLink.current = null;
        void game.closeEmbedded().catch(() => {});
        setEmbedded(false);
        setScreen("launcher");
        setError(t("app.linkMaintenance"));
      }),
      listen("game:window-closed", () => {
        void recordProgress();
      }),
      // The main window was closed with a world running (Rust kept it open).
      listen("app:close-requested", () => {
        void emit("app:close-handled");
        void closeRequestRef.current();
      }),
      // Open, never toggle: the menu accelerator and the in-game fallback
      // can both deliver the same keypress.
      listen("client:settings", () => setSettingsOpen(true)),
      listen("client:shortcuts", () => setShortcutsOpen(true)),
      listen("client:end-turn", () =>
        window.dispatchEvent(new CustomEvent("ahdclient:end-turn")),
      ),
    ];
    return () => {
      for (const subscription of subscriptions)
        void subscription.then((unlisten) => unlisten());
    };
    // recordProgress reads the latest info through a ref-free closure below;
    // re-subscribing on every info change would drop events mid-boot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshWorlds]);

  /** Pull turn and character off the running game and remember them. */
  const recordProgress = useCallback(async () => {
    try {
      const current = await game.status();
      if (!current.running || !current.slot) return;
      const status = await game.singleplayerStatus();
      await worlds.touch(current.slot, status.turn, status.characterName);
      await refreshWorlds();
    } catch {
      // Best effort: the world still plays without an up-to-date turn badge.
    }
  }, [refreshWorlds]);

  const fail = (e: unknown, keepOnBoot?: Omit<BootFailure, "message">) => {
    const message = e instanceof Error ? e.message : String(e);
    if (keepOnBoot) setBootFailure({ message, ...keepOnBoot });
    else setError(message);
    setDiagnosticIncident({
      reason: message.includes("stopped making progress") ? "stalled" : "error",
      message,
      lines: [...log],
    });
    void submitAutomaticDiagnostics(
      message.includes("stopped making progress") ? "stalled" : "error",
      message,
      diagnosticRuntime(screen, info.running ? "local-running" : "local-stopped"),
    );
    if (!keepOnBoot) setScreen("launcher");
  };

  /**
   * Boot the server for a slot, optionally seed a fresh world, then open the
   * game window. The boot screen shows the server's own log lines so a
   * first-run MongoDB download reads as progress rather than a hang.
   */
  const boot = async (
    slot: string,
    fresh: { preset: string; displayName?: string; setup: SetupOptions } | null,
    hosted = false,
  ) => {
    const generation = ++bootId.current;
    cancelled.current = false;
    setBusy(true);
    setError(null);
    setBootFailure(null);
    setLog([]);
    setBootProgress(null);
    setBootTitle(fresh ? t("boot.building") : t("app.startingWorld"));
    setScreen("booting");
    try {
      const started = await game.start(slot, hosted);
      if (cancelled.current || generation !== bootId.current) return;
      setInfo(started);
      if (fresh) {
        setLog((lines) =>
          [
            ...lines,
            t("app.seedingLog"),
          ].slice(-LOG_LINES),
        );
        let polling = true;
        let rejectStalledSetup: ((error: Error) => void) | null = null;
        const stalledSetup = new Promise<never>((_resolve, reject) => {
          rejectStalledSetup = reject;
        });
        const pollProgress = async () => {
          while (
            polling &&
            !cancelled.current &&
            generation === bootId.current
          ) {
            try {
              const nextProgress = await game.setupProgress();
              if (polling && generation === bootId.current) {
                setBootProgress(nextProgress);
                if (nextProgress.stalled) {
                  polling = false;
                  rejectStalledSetup?.(
                    new Error(t("app.setupStalled")),
                  );
                }
              }
            } catch {
              // The setup POST is authoritative; progress is supplemental.
            }
            await new Promise((resolve) => window.setTimeout(resolve, 750));
          }
        };
        void pollProgress();
        try {
          await Promise.race([
            game.setup(fresh.preset, fresh.setup, fresh.displayName),
            stalledSetup,
          ]);
        } finally {
          polling = false;
        }
        if (cancelled.current || generation !== bootId.current) return;
      }
      let status = await game.singleplayerStatus();
      if (!status.hasWorld) {
        const saved = allWorlds.find((world) => world.slot === slot);
        if (!saved?.setup)
          throw new Error(t("app.setupIncomplete"));
        await game.setup(saved.preset, saved.setup);
        status = await game.singleplayerStatus();
      }
      if (cancelled.current || generation !== bootId.current) return;
      if (loadingSave.current) {
        loadingSave.current = false;
        let outcome: Awaited<ReturnType<typeof game.saves>>["lastLoad"] = null;
        try {
          outcome = (await game.saves()).lastLoad;
        } catch {
          // No answer means no news; the world opened.
        }
        if (outcome && !outcome.ok) {
          try {
            setInfo(await game.stop());
          } catch {
            setInfo(IDLE);
          }
          throw new Error(outcome.message);
        }
      }
      await worlds.touch(slot, status.turn, status.characterName);
      const simulation =
        status.mode === "worldsim" || fresh?.setup.mode === "worldsim";
      setRunningWorldsim(simulation);
      if (simulation) {
        await refreshWorlds();
        setEmbedded(false);
        setScreen("worldsim");
        void captureStatistics(slot, true);
        return;
      }
      await game.openWindow(
        status.hasCharacter ? "/profile" : "/create-character",
        settings.separateWindow,
      );
      setEmbedded(!settings.separateWindow);
      await refreshWorlds();
      setScreen("playing");
      void captureStatistics(slot, true);
    } catch (e) {
      loadingSave.current = false;
      if (!cancelled.current && generation === bootId.current) {
        try {
          setInfo(await game.stop());
        } catch {
          setInfo(IDLE);
        }
        const message = e instanceof Error ? e.message : String(e);
        if (message.startsWith(CLASSIC_REQUIRED)) {
          // A Classic world needs its game first: offer the download, not an error.
          await refreshClassic();
          setClassicPrompt({ slot, hosted });
          setScreen("launcher");
        } else {
          fail(e, { slot, fresh, hosted });
        }
      }
    } finally {
      if (generation === bootId.current) setBusy(false);
    }
  };

  const cancelBoot = async () => {
    const diagnosticLines = [...log];
    cancelled.current = true;
    bootId.current += 1;
    try {
      setInfo(await game.stop());
    } catch {
      setInfo(IDLE);
    }
    setBusy(false);
    setBootProgress(null);
    setScreen("launcher");
    setDiagnosticIncident({
      reason: "cancelled",
      message: t("app.cancelledLoading"),
      lines: diagnosticLines,
    });
  };

  /**
   * Entitlement is checked BEFORE entering setup, so an unlinked player never
   * fills in a world they cannot create. The check runs again at creation in
   * case access changed mid-setup; that refusal keeps the form mounted.
   */
  const refuseEntitlement = (
    result: { linked: boolean; offline: boolean },
    intent: LinkIntent,
  ) => {
    // Not linked yet: sign in right here and carry on with the same era.
    if (!result.offline && !result.linked) {
      afterLink.current = intent;
      linkAccount();
      return;
    }
    setError(entitlementError(result));
    setEntitlementBlocked(true);
  };

  const handleNewWorld = (eraId: string, worldsim = false, classicWorld = false) => {
    void (async () => {
      setError(null);
      setEntitlementBlocked(false);
      const result = await checkSingleplayerEntitlement();
      if (!result.ok) {
        refuseEntitlement(result, { kind: "new", eraId, worldsim, classic: classicWorld });
        return;
      }
      setPendingWorldsim(worldsim);
      setPendingClassic(classicWorld);
      setPendingEra(eraId);
      setSetupError(null);
      setScreen("newWorld");
    })();
  };

  /** Save a new world and boot it. Shared by the setup screen and Quick start. */
  const startWorld = async (era: Era, name: string, displayName: string, setup: SetupOptions, classicWorld: boolean) => {
    creating.current = true;
    const slot = slugForWorld(
      name,
      allWorlds.map((w) => w.slot),
    );
    try {
      await worlds.create(slot, name.trim() || era.label, era.preset, setup, classicWorld);
      await refreshWorlds();
    } catch (e) {
      creating.current = false;
      return fail(e);
    }
    const trimmed = displayName.trim();
    try {
      await boot(slot, {
        preset: era.preset,
        setup,
        ...(trimmed ? { displayName: trimmed } : {}),
      });
    } finally {
      creating.current = false;
    }
  };

  /**
   * Quick start: the era as the game recommends it. Normal difficulty and the
   * defaults of the game that will run it, no setup screen, named for the era.
   */
  const handleQuickStart = (eraId: string) => {
    void (async () => {
      if (creating.current) return;
      setError(null);
      setEntitlementBlocked(false);
      const result = await checkSingleplayerEntitlement();
      if (!result.ok) {
        refuseEntitlement(result, { kind: "quick", eraId });
        return;
      }
      const era = eraById(eraId);
      if (!era) return fail(new Error(t("app.pickEra")));
      setPendingWorldsim(false);
      setPendingClassic(false);
      await startWorld(
        era,
        uniqueWorldName(era.label, allWorlds.map((w) => w.name)),
        "",
        defaultSetupOptions(capabilities ?? legacyCapabilities()),
        false,
      );
    })();
  };
  resumeAfterLink.current = (intent) =>
    intent.kind === "quick"
      ? handleQuickStart(intent.eraId)
      : handleNewWorld(intent.eraId, intent.worldsim, intent.classic);

  const handleCreate = async (
    name: string,
    displayName: string,
    setup: SetupOptions,
  ) => {
    if (creating.current) return;
    const entitled = await checkSingleplayerEntitlement();
    if (!entitled.ok) {
      // Stay on the setup screen: the form (also persisted to storage) is
      // preserved and the player gets an explicit link CTA. No bypass.
      setSetupError(entitlementError(entitled));
      return;
    }
    setSetupError(null);
    const era = eraById(pendingEra ?? "");
    if (!era) return fail(new Error(t("app.pickEra")));
    await startWorld(era, name, displayName, setup, pendingClassic);
  };

  const handleContinue = (slot: string) => {
    void (async () => {
      const entitled = await checkSingleplayerEntitlement();
      if (!entitled.ok) {
        setError(entitlementError(entitled));
        setScreen("launcher");
        return;
      }
      if (info.running && info.slot === slot) {
        if (runningWorldsim) {
          setScreen("worldsim");
          return;
        }
        void game
          .openWindow("/profile", settings.separateWindow)
          .then(() => {
            setEmbedded(!settings.separateWindow);
            setScreen("playing");
          })
          .catch(fail);
        return;
      }
      void boot(slot, null);
    })();
  };

  const handleHost = (slot: string) => {
    void (async () => {
      const entitled = await checkSingleplayerEntitlement();
      if (!entitled.ok) {
        setError(entitlementError(entitled));
        setScreen("launcher");
        return;
      }
      void boot(slot, null, true);
    })();
  };

  const handleDelete = async (slot: string) => {
    try {
      await worlds.remove(slot);
      await refreshWorlds();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const refreshSizes = useCallback(async () => {
    try {
      setWorldSizes(Object.fromEntries((await worlds.sizes()).map((entry) => [entry.slot, entry.sizeBytes])));
    } catch {
      // Sizes are a nicety; the list works without them.
    }
  }, []);

  useEffect(() => {
    if (mobile || screen !== "worlds") return;
    setWorldNotice(null);
    void refreshSizes();
  }, [screen, refreshSizes]);

  const reportWorldError = (e: unknown) => {
    setWorldNotice(null);
    setError(e instanceof Error ? e.message : String(e));
  };

  const handleRename = async (slot: string, name: string) => {
    try {
      await worlds.rename(slot, name);
      setError(null);
      await refreshWorlds();
    } catch (e) {
      reportWorldError(e);
      throw e;
    }
  };

  const handleExport = async (slot: string) => {
    try {
      const path = await worlds.exportTo(slot, t("worlds.exportDialog"));
      setError(null);
      if (path) {
        const name = allWorlds.find((world) => world.slot === slot)?.name ?? slot;
        setWorldNotice(t("worlds.exported", { name, path }));
      }
    } catch (e) {
      reportWorldError(e);
    }
  };

  const handleImport = async () => {
    try {
      const added = await worlds.importFrom(t("worlds.importDialog"));
      setError(null);
      if (added) {
        setWorldNotice(t("worlds.imported", { name: added.name }));
        await refreshWorlds();
        void refreshSizes();
      }
    } catch (e) {
      reportWorldError(e);
    }
  };

  const handleTidy = async (slot: string) => {
    try {
      const count = await worlds.tidyAutosaves(slot, AUTOSAVES_KEPT);
      setError(null);
      setWorldNotice(count > 0 ? t("worlds.tidied", { count, keep: AUTOSAVES_KEPT }) : t("worlds.tidiedNone"));
      void refreshSizes();
    } catch (e) {
      reportWorldError(e);
    }
  };

  /**
   * Load a save into a world: stop it if it is running, queue the load, then
   * start it again. The start applies the load before the game opens, so the
   * boot screen covers the wait. The world as it stood is kept by the game as
   * one extra save, so this can be undone.
   */
  const handleLoadSave = async (slot: string, save: SaveMeta) => {
    const entitled = await checkSingleplayerEntitlement();
    if (!entitled.ok) throw new Error(entitlementError(entitled));
    const wasRunning = info.running && info.slot === slot;
    const hosted = wasRunning && info.hosted;
    if (wasRunning) {
      try {
        await game.closeEmbedded();
      } catch {
        // Stopping the world below closes its windows anyway.
      }
      setEmbedded(false);
      setInfo(await game.stop());
    }
    await worldSaves.requestLoad(slot, save.id);
    setSavesFor(null);
    loadingSave.current = true;
    void boot(slot, null, hosted);
  };

  const saveAndQuit = async () => {
    setClosing("saving");
    try {
      if (info.slot) await captureStatistics(info.slot, true).catch(() => {});
      await recordProgress();
      // Rust stops the world, waits for it to finish writing, then quits.
      await game.stop(true);
    } catch (e) {
      setClosing(null);
      fail(e);
    }
  };
  const requestClose = async () => {
    if (closing === "saving") return;
    let playing = false;
    try {
      playing = (await game.batchStatus()).batch?.status === "running";
    } catch {
      // No answer from the game: nothing known to confirm, just save and close.
    }
    if (playing) setClosing("confirm");
    else await saveAndQuit();
  };
  closeRequestRef.current = requestClose;

  const handleStop = async () => {
    if (info.slot) await captureStatistics(info.slot, true);
    await recordProgress();
    try {
      setInfo(await game.stop());
    } catch {
      setInfo(IDLE);
    }
    setScreen("launcher");
  };

  // On mobile the site replaces the launcher in the same webview, so there
  // is no embedded state to track: the page unloads as soon as it navigates.
  const showOnline = () => {
    if (mobile) return;
    setEmbedded(!settings.separateWindow);
    if (!settings.separateWindow) setScreen("online");
  };
  const handlePlayOnline = (target: OnlineTarget) => {
    setError(null);
    if (target === "sandbox") {
      void online
        .account()
        .then((linked) => {
          setAccount(linked?.linked ? linked : null);
          setAccountChecked(true);
          if (!linked?.linked || !linked.supporter) return;
          return online.open(target, settings.separateWindow).then(showOnline);
        })
        .catch(() =>
          setError(t("app.sandboxOffline")),
        );
      return;
    }
    void online
      .open(target, settings.separateWindow)
      .then(showOnline)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const linkAccount = () => {
    setError(null);
    void online
      .link(settings.separateWindow)
      .then(() => {
        if (mobile) return;
        setEmbedded(!settings.separateWindow);
        setScreen("linking");
      })
      .catch((e) => {
        afterLink.current = null;
        fail(e);
      });
  };
  const signOut = () => {
    if (signingOut) return;
    setError(null);
    setSigningOut(true);
    void online
      .signOut()
      .then(() => {
        setAccount(null);
        clearCachedAskSession();
        cacheSingleplayerEntitlement({ entitled: false, expiresAt: null });
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSigningOut(false));
  };
  const returnToLauncher = async () => {
    afterLink.current = null;
    if (info.slot) await captureStatistics(info.slot, true);
    await game.closeEmbedded();
    setEmbedded(false);
    await recordProgress();
    setScreen("launcher");
  };
  const askControl = (
    <button
      className="client-settings-trigger"
      type="button"
      onClick={() => void ask.open().catch(fail)}
      title={t("app.askTitle")}
    >
      {t("app.ask")}
    </button>
  );
  const briefingControl = (
    <button className="client-settings-trigger" type="button" onClick={() => setScreen("briefing")}>
      {t("app.briefing")}
    </button>
  );
  const settingsControl = (
    <button
      className="client-settings-trigger"
      type="button"
      onClick={() => setSettingsOpen(true)}
    >
      {t("settings.title")}
    </button>
  );
  const accountControl = (
    <AccountControl
      checked={accountChecked}
      linked={Boolean(account)}
      displayName={account?.displayName}
      avatarUrl={account?.avatarUrl}
      supporter={account?.supporter}
      onLink={linkAccount}
      onProfile={() => void online.help("help.profile").catch(fail)}
      onManage={() => void online.help("help.account").catch(fail)}
      onSignOut={signOut}
      signingOut={signingOut}
    />
  );
  const settingsMenu = (
    <SettingsMenu
      mobile={mobile}
      open={settingsOpen}
      settings={settings}
      onChange={changeSettings}
      onClose={() => setSettingsOpen(false)}
      onReportIssue={() =>
        void online.help(reportIssueRoute(mobile)).catch(fail)
      }
      onOpenDiagnostics={() => {
        setSettingsOpen(false);
        setDiagnosticsOpen(true);
      }}
    />
  );
  const diagnosticPanel = (
    <DiagnosticPanel
      open={diagnosticsOpen}
      screen={screen}
      game={mobile ? "remote only" : info.running ? "local game running" : "local game stopped"}
      onClose={() => setDiagnosticsOpen(false)}
    />
  );
  const diagnosticPrompt = (
    <DiagnosticPrompt
      incident={diagnosticIncident}
      sending={sendingDiagnostics}
      onDismiss={() => setDiagnosticIncident(null)}
      onSend={() => {
        if (!diagnosticIncident || sendingDiagnostics) return;
        setSendingDiagnostics(true);
        void submitDiagnostics(
          diagnosticIncident.reason,
          diagnosticIncident.message,
          diagnosticIncident.lines,
        ).then(() => setDiagnosticIncident(null)).catch(() => {
          setError(t("app.diagnosticsFailed"));
        }).finally(() => setSendingDiagnostics(false));
      }}
    />
  );
  const crashDialog = crash ? (
    <CrashDialog
      message={crash.message}
      canRestart={crash.slot != null && allWorlds.some((w) => w.slot === crash.slot)}
      onRestart={() => {
        const slot = crash.slot;
        setCrash(null);
        if (slot) handleContinue(slot);
      }}
      onReport={() => {
        setCrash(null);
        setDiagnosticIncident({ reason: "error", message: crash.message, lines: log.slice(-LOG_LINES) });
      }}
      onBack={() => setCrash(null)}
    />
  ) : null;
  const savesWorld = savesFor ? allWorlds.find((w) => w.slot === savesFor) : null;
  const savesDialog = savesFor ? (
    <SavesDialog
      slot={savesFor}
      worldName={savesWorld?.name ?? savesFor}
      running={info.running && info.slot === savesFor}
      onLoad={(save) => handleLoadSave(savesFor, save)}
      onClose={() => setSavesFor(null)}
    />
  ) : null;
  const closeDialog = closing ? <CloseDialog mode={closing} onKeepPlaying={() => setClosing(null)} onSaveAndClose={() => void saveAndQuit()} /> : null;
  const withSettings = (content: JSX.Element) => (
    <>
      {content}
      <UpdateNotice enabled={!mobile} />
      {savesDialog}
      {settingsMenu}
      {shortcutsOpen ? <ShortcutsDialog onClose={() => setShortcutsOpen(false)} /> : null}
      {diagnosticPanel}
      {diagnosticPrompt}
      {crashDialog}
      {closeDialog}
    </>
  );
  const latest = allWorlds[0] ?? null;
  const sandboxGate = !accountChecked
    ? null
    : !account
      ? "unlinked"
      : !account.supporter
        ? "upgrade"
        : null;
  if (
    embedded &&
    (screen === "playing" || screen === "online" || screen === "linking")
  ) {
    if (screen === "playing") {
      const world = allWorlds.find((w) => w.slot === info.slot) ?? null;
      return (
        <>
          <main>
            <GameToolbar
              worldName={world?.name ?? "A House Divided"}
              worldsim={runningWorldsim}
              onLauncher={() => void returnToLauncher().catch(fail)}
              onSaveAndStop={() => void handleStop().catch(fail)}
              onDialogOpenChange={setSummaryOpen}
              onOpenSaves={() => setSavesFor(info.slot)}
              onOpenAsk={() => void ask.open().catch(fail)}
              onOpenUpdates={mobile ? undefined : () => setSettingsOpen(true)}
              onViewStats={
                runningWorldsim
                  ? () => {
                      void game.closeEmbedded().then(() => {
                        setEmbedded(false);
                        setScreen("worldsim");
                      });
                    }
                  : undefined
              }
              onTurnAdvanced={() =>
                void (async () => {
                  await recordProgress().catch(() => {});
                  if (info.slot) await captureStatistics(info.slot);
                  // Refresh the child webview on its current path so funds,
                  // map, country and briefing pages show the turn that just
                  // advanced instead of the pre-turn snapshot.
                  try {
                    await game.refreshView();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  }
                })()
              }
            />
          </main>
          {savesDialog}
          {settingsMenu}
          {diagnosticPanel}
          {diagnosticPrompt}
          {closeDialog}
        </>
      );
    }
    return (
      <>
        <main>
          <nav className="client-game-toolbar" aria-label="Client controls">
            <button onClick={() => void returnToLauncher().catch(fail)}>
              {t("worldsim.launcher")}
            </button>
            <strong>
              {screen === "linking"
                ? t("app.linkTitle")
                : "A House Divided"}
            </strong>
            <button title={t("app.pipTitle")} onClick={() => void briefing.popOut().catch(fail)}>PiP</button>
            <button onClick={() => setSettingsOpen(true)}>{t("settings.title")}</button>
          </nav>
        </main>
        {settingsMenu}
        {diagnosticPanel}
        {diagnosticPrompt}
        {closeDialog}
      </>
    );
  }
  if (screen === "linking") {
    return withSettings(
      <main className="launcher-scope screen-scope">
        <h1>{t("app.linkTitle")}</h1>
        <p>{t("app.linkText")}</p>
        <button
          onClick={() => {
            afterLink.current = null;
            setScreen("launcher");
          }}
        >
          {t("app.backLauncher")}
        </button>
      </main>,
    );
  }

  if (screen === "briefing") return <Briefing mobile={mobile} onBack={() => setScreen("launcher")} />;

  if (screen === "newWorld" && pendingEra) {
    const era = eraById(pendingEra);
    if (era) {
      return withSettings(
        <NewWorldScreen
          language={settings.language}
          era={era}
          capabilities={pendingClassic ? classicCapabilities(classic?.version ?? null) : capabilities}
          initialWorldsim={pendingWorldsim}
          shareStatistics={settings.shareStatistics}
          onStatisticsChange={(shareStatistics) =>
            changeSettings({ ...settings, shareStatistics })
          }
          taken={allWorlds.map((w) => w.name)}
          error={setupError}
          onLinkAccount={setupError && !account ? linkAccount : undefined}
          onBack={() => {
            setSetupError(null);
            setScreen("launcher");
          }}
          onCreate={handleCreate}
        />,
      );
    }
  }

  if (screen === "worldsim" && info.running && info.slot) {
    return withSettings(
      <WorldsimScreen
        name={
          allWorlds.find((world) => world.slot === info.slot)?.name ??
          t("app.worldSimulation")
        }
        onBack={() => setScreen("launcher")}
        onStop={handleStop}
        onTurnCompleted={() => captureStatistics(info.slot!)}
        onView={() => {
          void game
            .openWindow("/singleplayer/worldsim", settings.separateWindow)
            .then(() => {
              setEmbedded(!settings.separateWindow);
              if (!settings.separateWindow) setScreen("playing");
            })
            .catch(fail);
        }}
      />,
    );
  }
  if (screen === "worlds") {
    return withSettings(
      <WorldsScreen
        worlds={allWorlds}
        runningSlot={info.running ? info.slot : null}
        busy={busy}
        error={error}
        onPlay={handleContinue}
        onHost={handleHost}
        onDelete={handleDelete}
        onSaves={setSavesFor}
        onRename={handleRename}
        onExport={(slot) => void handleExport(slot)}
        onImport={() => void handleImport()}
        onTidy={(slot) => void handleTidy(slot)}
        sizes={worldSizes}
        notice={worldNotice}
        onBack={() => setScreen("launcher")}
      />,
    );
  }

  if (screen === "booting") {
    return withSettings(
      <BootScreen
        title={bootTitle}
        lines={log}
        onCancel={cancelBoot}
        showDebug={settings.showBootLogs}
        progress={bootProgress}
        failure={bootFailure}
        onRetry={
          bootFailure
            ? () => void boot(bootFailure.slot, bootFailure.fresh, bootFailure.hosted)
            : undefined
        }
        onBack={() => {
          setBootFailure(null);
          setScreen("launcher");
        }}
      />,
    );
  }

  if (screen === "playing" && info.running) {
    const world = allWorlds.find((w) => w.slot === info.slot) ?? null;
    return withSettings(
      <PlayingScreen
        world={world}
        hosted={info.hosted}
        port={info.port}
        lanUrl={info.lanUrl}
        lines={log}
        onResume={() => handleContinue(info.slot!)}
        onStop={handleStop}
      />,
    );
  }

  return (
    <>
      <UpdateNotice enabled={!mobile} />
      {!mobile && accountChecked && accountNotice && !account && (
        <aside className="client-account-notice">
          <span>{t("app.accountNotice")}</span>
          <button onClick={linkAccount}>{t("common.linkAccount")}</button>
          <button
            onClick={() => {
              setAccountNotice(false);
              rememberAccountNotice();
            }}
          >
            {t("common.later")}
          </button>
        </aside>
      )}
      {classicPrompt && classic && (
        <ClassicDownload
          info={classic}
          worldName={allWorlds.find((w) => w.slot === classicPrompt.slot)?.name ?? null}
          onClose={() => setClassicPrompt(null)}
          onDone={() => {
            const waiting = classicPrompt;
            setClassicPrompt(null);
            void refreshClassic();
            if (waiting.slot) void boot(waiting.slot, null, waiting.hosted);
          }}
        />
      )}
      <Launcher
        language={settings.language}
        mobile={mobile}
        settingsControl={settingsControl}
        accountControl={accountControl}
        askControl={askControl}
        briefingControl={briefingControl}
        capabilities={capabilities}
        classicAvailable={!mobile && classic?.version != null}
        classicInstalled={classic?.installed === true}
        classicSizeLabel={formatDownloadSize(classic?.sizeBytes)}
        onClassicEras={() => setClassicPrompt({ slot: null, hosted: false })}
        onClassicEra={(eraId) => handleNewWorld(eraId, false, true)}
        gameVersionControl={mobile ? undefined : <GameVersionLine />}
        onPhotoSource={(eraId) => {
          void online.help(`help.era-photo-${eraId}`).catch(fail);
        }}
        onNewWorld={handleNewWorld}
        onQuickStart={handleQuickStart}
        onContinue={handleContinue}
        onLoad={() => setScreen("worlds")}
        onPlayOnline={handlePlayOnline}
        error={error}
        errorOffersLink={entitlementBlocked && !account}
        onClearError={() => {
          setError(null);
          setEntitlementBlocked(false);
        }}
        latestWorld={latest}
        runningSlot={info.running ? info.slot : null}
        continueBusy={busy}
        sandboxGate={sandboxGate}
        // Supporter perk bought outside the App Store: never on iPhone (3.1.1).
        // Android ships outside Google Play and keeps it for linked supporters.
        sandboxAvailable={platform !== "ios"}
        onLinkAccount={linkAccount}
        // Store builds may not point players at an outside purchase.
        onUpgradeSupporter={
          mobile
            ? undefined
            : () => {
                void online.help("help.patreon").catch(fail);
              }
        }
      />
      {settingsMenu}
      {diagnosticPanel}
      {diagnosticPrompt}
      {crashDialog}
    </>
  );
}
