import { invoke } from "@tauri-apps/api/core";
import desktopPackage from "../package.json";
import { platform, type ClientPlatform } from "./platform.js";

export type DiagnosticReason = "cancelled" | "error" | "manual" | "stalled";
export type DiagnosticLevel = "debug" | "info" | "log" | "native" | "warn" | "error";

export interface DiagnosticEntry {
  at: string;
  level: DiagnosticLevel;
  message: string;
}

export interface DiagnosticRuntime {
  clientVersion: string;
  platform: ClientPlatform;
  screen: string;
  game: string;
  online: boolean;
  viewport: string;
  language: string;
  userAgent: string;
}

const MAX_ENTRIES = 200;
const entries: DiagnosticEntry[] = [];
const subscribers = new Set<() => void>();
let installed = false;
let automaticReports = 0;
const automaticFingerprints = new Set<string>();
const MAX_AUTOMATIC_REPORTS_PER_SESSION = 5;

export const redact = (line: string): string => line
  .replace(/C:\\Users\\[^\\\s]+/gi, "C:\\Users\\[redacted]")
  .replace(/\/Users\/[^/\s]+/g, "/Users/[redacted]")
  .replace(/\/home\/[^/\s]+/g, "/home/[redacted]")
  .replace(/(worlds[\\/])[^\\/\s]+/gi, "$1[world]")
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
  .replace(/(["'])(displayName|userName|characterName|worldName|access[_-]?token|refresh[_-]?token|session[_-]?token|id[_-]?token|token|password|secret|cookie|authorization|api[_-]?key)\1(\s*:\s*)(["'])[^"']*\4/gi, "$1$2$1$3$4[redacted]$4")
  .replace(/\b(displayName|userName|characterName|worldName)(["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, "$1$2[redacted]")
  .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]")
  .replace(/\b(access[_-]?token|refresh[_-]?token|session[_-]?token|id[_-]?token|token|password|secret|cookie|authorization|api[_-]?key)(["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, "$1$2[redacted]")
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[jwt]")
  .slice(0, 500);

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, nested) => {
      if (typeof nested === "object" && nested !== null) {
        if (seen.has(nested)) return "[circular]";
        seen.add(nested);
      }
      return nested;
    });
  } catch {
    return String(value);
  }
}

export function recordDiagnostic(level: DiagnosticLevel, ...values: unknown[]): void {
  entries.push({
    at: new Date().toISOString(),
    level,
    message: redact(values.map(printable).join(" ")),
  });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  for (const subscriber of subscribers) subscriber();
}

export function diagnosticEntries(): readonly DiagnosticEntry[] {
  return [...entries];
}

export function diagnosticLines(): string[] {
  return entries.map((entry) => `${entry.at} ${entry.level.toUpperCase()} ${entry.message}`);
}

export function clearDiagnostics(): void {
  entries.length = 0;
  for (const subscriber of subscribers) subscriber();
}

export function subscribeDiagnostics(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function installDiagnosticCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  for (const level of ["debug", "info", "log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...values: unknown[]) => {
      recordDiagnostic(level, ...values);
      original(...values);
    };
  }
  window.addEventListener("error", (event) => {
    recordDiagnostic("error", event.message, event.filename, event.lineno);
    void submitAutomaticDiagnostics("error", event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    recordDiagnostic("error", "Unhandled promise rejection", event.reason);
    void submitAutomaticDiagnostics("error", `Unhandled promise rejection: ${printable(event.reason)}`);
  });
  recordDiagnostic("info", "Diagnostic capture started");
}

export function diagnosticRuntime(screen: string, game: string): DiagnosticRuntime {
  return {
    clientVersion: desktopPackage.version,
    platform,
    screen,
    game,
    online: typeof navigator === "undefined" ? false : navigator.onLine,
    viewport: typeof window === "undefined"
      ? "unavailable"
      : `${window.innerWidth}x${window.innerHeight} @ ${window.devicePixelRatio || 1}x`,
    language: typeof navigator === "undefined" ? "unavailable" : navigator.language,
    userAgent: typeof navigator === "undefined" ? "unavailable" : redact(navigator.userAgent),
  };
}

export function buildDiagnosticReport(reason: DiagnosticReason, message: string, lines: readonly string[], runtime?: DiagnosticRuntime) {
  return {
    schemaVersion: 1,
    clientVersion: desktopPackage.version,
    reason,
    message: redact(message),
    logLines: lines.slice(-60).map(redact),
    occurredAt: new Date().toISOString(),
    ...(runtime ? { runtime } : {}),
  } as const;
}

export function formatDiagnosticBundle(runtime: DiagnosticRuntime, lines = diagnosticLines()): string {
  return JSON.stringify(buildDiagnosticReport("manual", "Copied from Diagnostics.", lines, runtime), null, 2);
}

export async function submitDiagnostics(reason: DiagnosticReason, message: string, lines: readonly string[], runtime?: DiagnosticRuntime): Promise<void> {
  await invoke("submit_diagnostics", { report: buildDiagnosticReport(reason, message, lines, runtime) });
}

/**
 * Send bounded, redacted failure reports without interrupting the player.
 * Repeated copies of the same failure are suppressed for this process.
 */
export async function submitAutomaticDiagnostics(
  reason: Exclude<DiagnosticReason, "manual">,
  message: string,
  runtime?: DiagnosticRuntime,
): Promise<boolean> {
  const fingerprint = `${reason}:${redact(message)}`;
  if (
    automaticReports >= MAX_AUTOMATIC_REPORTS_PER_SESSION ||
    automaticFingerprints.has(fingerprint)
  ) return false;
  automaticReports += 1;
  automaticFingerprints.add(fingerprint);
  try {
    await submitDiagnostics(reason, message, diagnosticLines(), runtime);
    return true;
  } catch {
    return false;
  }
}
