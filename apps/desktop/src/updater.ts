/**
 * Desktop updater. The plugin is imported here so the webview pays the
 * load cost at startup, not on the first click.
 *
 * Windows: download() only fetches the installer. install() launches NSIS
 * and exits this process. Never call downloadAndInstall(); that would exit
 * as soon as the download finished, before Restart to update.
 * Linux/macOS: install() replaces files in place; relaunch() is required
 * after the player confirms.
 */
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import desktopPackage from "../package.json";
import { submitAutomaticDiagnostics } from "./diagnostics.js";
import { readSettings } from "./settings.js";

export const UPDATE_CHECK_TIMEOUT_MS = 15_000;
/** How often a running app looks for a new version. */
export const UPDATE_RECHECK_MS = 6 * 60 * 60 * 1000;

export type UpdaterSnapshot =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  /** A new version exists and nothing has been downloaded yet. */
  | { kind: "available"; version: string; notes: string; size: number | null }
  /** A new version exists but this install (deb, rpm) cannot update itself. */
  | { kind: "package"; version: string; notes: string }
  | {
      kind: "downloading";
      version: string;
      notes: string;
      received: number;
      total: number | null;
    }
  | { kind: "ready"; version: string; notes: string }
  | { kind: "installing"; version: string }
  | { kind: "error"; message: string };

type Listener = () => void;

const CHECK_OPTIONS = { timeout: UPDATE_CHECK_TIMEOUT_MS };
const UPDATE_RESTART_KEY = "ahdclient.update.restart";
const LAST_CHECK_KEY = "ahdclient.update.lastCheck";

let snapshot: UpdaterSnapshot = { kind: "idle" };
let pending: Update | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<Listener>();

export function isWindowsUserAgent(userAgent: string): boolean {
  return /\bWindows\b/i.test(userAgent);
}

function windowsHost(): boolean {
  return typeof navigator !== "undefined" && isWindowsUserAgent(navigator.userAgent);
}

function emit(next: UpdaterSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function getUpdaterSnapshot(): UpdaterSnapshot {
  return snapshot;
}

export function subscribeUpdater(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetUpdaterForTests(): void {
  snapshot = { kind: "idle" };
  pending = null;
  inFlight = null;
  listeners.clear();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Turn a raw plugin error into a sentence a player can act on. */
export function plainUpdateError(raw: string): string {
  const text = raw.toLowerCase();
  if (/signature|verif|pubkey|minisign/.test(text)) {
    return "The update could not be verified, so it was not installed. Try again later.";
  }
  if (/404|not found|status code 4|status code 5|release json|valid release/.test(text)) {
    return "The update is not available right now. Try again later.";
  }
  if (/network|offline|timed out|timeout|dns|connect|error sending request|unreachable|resolve/.test(text)) {
    return "Could not reach the update server. Check your connection and try again.";
  }
  return "The update did not finish. Try again from Settings.";
}

export function formatUpdateSize(bytes: number | null): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${Math.max(0.1, Math.round(mb * 10) / 10)} MB`;
}

/** The download size, when the release manifest carries one for this system. */
function sizeFor(update: Update): number | null {
  const platforms = (update.rawJson as { platforms?: Record<string, { size?: unknown }> } | undefined)?.platforms;
  if (!platforms || typeof navigator === "undefined") return null;
  const agent = navigator.userAgent;
  const os = /\bWindows\b/i.test(agent) ? "windows" : /\bMac/i.test(agent) ? "darwin" : "linux";
  for (const [key, value] of Object.entries(platforms)) {
    if (key.startsWith(`${os}-`) && typeof value?.size === "number") return value.size;
  }
  return null;
}

async function selfUpdates(): Promise<boolean> {
  try {
    return (await invoke<string>("update_install_kind")) !== "package";
  } catch {
    return true;
  }
}

function recordCheck(): void {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch {
    // Checking still works without storage.
  }
}

function lastCheckAge(): number {
  try {
    const at = Number(localStorage.getItem(LAST_CHECK_KEY));
    return at > 0 ? Date.now() - at : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function notesFor(update: Update): string {
  return update.body ?? "A new AHDClient and paired game build are ready.";
}

async function downloadUpdate(update: Update): Promise<void> {
  let received = 0;
  let total: number | null = null;
  emit({
    kind: "downloading",
    version: update.version,
    notes: notesFor(update),
    received: 0,
    total: null,
  });
  await update.download((event: DownloadEvent) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? null;
      received = 0;
    } else if (event.event === "Progress") {
      received += event.data.chunkLength;
    }
    emit({
      kind: "downloading",
      version: update.version,
      notes: notesFor(update),
      received,
      total,
    });
  });
  emit({ kind: "ready", version: update.version, notes: notesFor(update) });
}

async function runCheck(): Promise<void> {
  auditPreviousRestart();
  emit({ kind: "checking" });
  recordCheck();
  try {
    const update = await check(CHECK_OPTIONS);
    if (!update) {
      pending = null;
      emit({ kind: "current" });
      return;
    }
    pending = update;
    if (!(await selfUpdates())) {
      emit({ kind: "package", version: update.version, notes: notesFor(update) });
    } else if (readSettings().autoInstallUpdates) {
      await downloadUpdate(update);
    } else {
      emit({ kind: "available", version: update.version, notes: notesFor(update), size: sizeFor(update) });
    }
  } catch (error) {
    pending = null;
    emit({ kind: "error", message: plainUpdateError(errorMessage(error)) });
  }
}

/** Start the download the player agreed to. */
export async function downloadAvailableUpdate(): Promise<void> {
  if (snapshot.kind !== "available" || !pending) return;
  const update = pending;
  try {
    await downloadUpdate(update);
  } catch (error) {
    pending = null;
    emit({ kind: "error", message: plainUpdateError(errorMessage(error)) });
  }
}

/**
 * Re-check on a schedule while the app stays open. Returns a cleanup. The
 * first check runs soon after start; later ones wait for the 6 hour mark.
 */
export function startUpdateSchedule(firstCheckDelayMs = 400): () => void {
  const first = setTimeout(() => void startBackgroundUpdateCheck(), firstCheckDelayMs);
  const timer = setInterval(() => {
    if (lastCheckAge() >= UPDATE_RECHECK_MS - 60_000) void startBackgroundUpdateCheck();
  }, 10 * 60 * 1000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

export function startBackgroundUpdateCheck(): Promise<void> {
  if (inFlight) return inFlight;
  if (
    snapshot.kind === "downloading" ||
    snapshot.kind === "ready" ||
    snapshot.kind === "installing" ||
    snapshot.kind === "available" ||
    snapshot.kind === "package"
  ) {
    return Promise.resolve();
  }
  inFlight = runCheck().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function checkForUpdatesNow(): Promise<void> {
  if (snapshot.kind === "downloading" || snapshot.kind === "installing") {
    return inFlight ?? Promise.resolve();
  }
  if (snapshot.kind === "ready" || snapshot.kind === "available" || snapshot.kind === "package") {
    return Promise.resolve();
  }
  return startBackgroundUpdateCheck();
}

export async function confirmRestartToUpdate(): Promise<void> {
  if (snapshot.kind !== "ready" || !pending) {
    throw new Error("No downloaded update is ready to install.");
  }
  const update = pending;
  emit({ kind: "installing", version: update.version });
  try {
    try {
      localStorage.setItem(UPDATE_RESTART_KEY, JSON.stringify({
        from: desktopPackage.version,
        to: update.version,
        requestedAt: Date.now(),
      }));
    } catch {
      // The installer still works when webview storage is unavailable.
    }
    // Windows: this call starts the passive NSIS installer and then exits the
    // app. Its visible progress window closes the long blank interval, while
    // restartAfterInstall makes NSIS own the one reliable relaunch.
    // download() has already completed, so this is the first moment the
    // process is allowed to quit for an update.
    await update.install({ restartAfterInstall: true });
    pending = null;
    if (!windowsHost()) {
      await relaunch();
    }
  } catch (error) {
    pending = null;
    const message = errorMessage(error);
    emit({ kind: "error", message: plainUpdateError(message) });
    void submitAutomaticDiagnostics("error", `Desktop update install failed: ${message}`);
  }
}

function auditPreviousRestart(): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(UPDATE_RESTART_KEY);
    if (!raw) return;
    localStorage.removeItem(UPDATE_RESTART_KEY);
    const attempt = JSON.parse(raw) as { from?: string; to?: string; requestedAt?: number };
    if (attempt.to === desktopPackage.version) return;
    if (typeof attempt.requestedAt !== "number" || Date.now() - attempt.requestedAt > 7 * 86_400_000) return;
    void submitAutomaticDiagnostics(
      "error",
      `Desktop updater returned on ${desktopPackage.version} after requesting ${String(attempt.to ?? "unknown")}.`,
    );
  } catch {
    try { localStorage.removeItem(UPDATE_RESTART_KEY); } catch { /* unavailable */ }
  }
}
