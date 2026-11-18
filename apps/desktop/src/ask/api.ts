import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface AskUsage {
  used: number;
  limit: number;
  remaining: number;
  mcpUsed: number;
  mcpLimit: number;
  mcpRemaining: number;
  vizUsed?: number;
  vizLimit?: number;
  vizRemaining?: number;
  /** Milliseconds since epoch, UTC midnight reset. */
  resetAt: number;
  tier?: string | null;
  maxFollowups?: number;
  followupCost?: number;
}

/** An outside company that may receive a question, from /api/me. */
export interface AskProvider {
  id?: string;
  name: string;
  detail?: string;
  url?: string | null;
}

export interface AskMe {
  identity?: { username?: string | null } | null;
  entitlement?: { allowed?: boolean; label?: string | null } | null;
  usage: AskUsage | null;
  aiProviders?: AskProvider[];
}

export interface AskConversation {
  id: string;
  title?: string | null;
  created?: number;
  updated?: number;
  private?: boolean;
}

export interface AskCitation {
  path?: string;
  label?: string;
  url?: string;
}

export interface AskLiveSource {
  label: string;
}

export interface AskAnswer {
  answer: string;
  areas?: unknown[];
  citations?: AskCitation[];
  followups?: string[];
  followupsLeft?: number;
  model?: string;
  modelName?: string;
  providerName?: string;
  cached?: boolean;
  usedMcp?: boolean;
  liveSources?: AskLiveSource[];
  liveHint?: string | null;
  vizBlocked?: boolean;
  reportUrl?: string | null;
  usage?: AskUsage | null;
  convId?: string;
}

export interface AskTurn extends AskAnswer {
  question: string;
}

export interface AskMeta {
  convId?: string;
  reqId?: string;
  followupsLeft?: number;
  usedMcp?: boolean;
  model?: string;
  modelName?: string;
  status?: string;
}

export type AskStreamKind =
  | "meta"
  | "status"
  | "action"
  | "delta"
  | "done"
  | "final"
  | "error"
  | "stopped";

export interface AskStreamEvent {
  reqId: string;
  kind: AskStreamKind | string;
  data: unknown;
}

export class AskError extends Error {
  readonly status: number;
  readonly signedOut: boolean;
  readonly quota: boolean;
  readonly usage: AskUsage | null;

  constructor(status: number, message: string, usage: AskUsage | null) {
    super(message);
    this.status = status;
    this.signedOut = status === 401;
    this.quota = status === 429;
    this.usage = usage;
  }
}

interface AskApiResult {
  status: number;
  body: string;
}

function errorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const message = (body as { error?: unknown }).error;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (status === 401) return "Please sign in to Ask first.";
  if (status === 429) return "You have used today's questions. Try again after midnight UTC.";
  return "Something went wrong. Try again.";
}

function usageOf(body: unknown): AskUsage | null {
  return usageIn(body);
}

/**
 * Sanitized quota summary off any `{ usage }` shaped payload: answers,
 * conversation lists, stream events, and error bodies. Unknown fields are
 * dropped so a wider service response can never leak into the UI.
 */
export function usageIn(value: unknown): AskUsage | null {
  if (value && typeof value === "object" && "usage" in value) {
    const usage = (value as { usage?: unknown }).usage;
    if (!usage || typeof usage !== "object") return null;
    const record = usage as Record<string, unknown>;
    const num = (field: unknown): number | null =>
      typeof field === "number" && Number.isFinite(field) ? field : null;
    // used/limit/remaining identify the quota; live-data counters and the
    // reset timestamp default when a refusal carries only the headline
    // numbers, so a 429 still updates the visible allowance.
    const used = num(record.used);
    const limit = num(record.limit);
    const remaining = num(record.remaining);
    if (used === null || limit === null || remaining === null) return null;
    const clean: AskUsage = {
      used,
      limit,
      remaining,
      mcpUsed: num(record.mcpUsed) ?? 0,
      mcpLimit: num(record.mcpLimit) ?? 0,
      mcpRemaining: num(record.mcpRemaining) ?? 0,
      resetAt: num(record.resetAt) ?? 0,
    };
    if (typeof record.tier === "string") clean.tier = record.tier;
    const vizUsed = num(record.vizUsed);
    if (vizUsed !== null) clean.vizUsed = vizUsed;
    const vizLimit = num(record.vizLimit);
    if (vizLimit !== null) clean.vizLimit = vizLimit;
    const vizRemaining = num(record.vizRemaining);
    if (vizRemaining !== null) clean.vizRemaining = vizRemaining;
    const maxFollowups = num(record.maxFollowups);
    if (maxFollowups !== null) clean.maxFollowups = maxFollowups;
    const followupCost = num(record.followupCost);
    if (followupCost !== null) clean.followupCost = followupCost;
    return clean;
  }
  return null;
}

/** True when the failure means the Ask session is gone (401 or missing cookie). */
export function isSignedOutError(error: unknown): boolean {
  if (error && typeof error === "object" && "signedOut" in error) {
    return (error as { signedOut?: unknown }).signedOut === true;
  }
  return typeof error === "string" && /sign in/i.test(error);
}

/** Quota summary carried by a 429 failure, or null. */
export function usageFromError(error: unknown): AskUsage | null {
  if (error && typeof error === "object" && "usage" in error) {
    return usageIn(error);
  }
  return null;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Proxied Ask API call. HTTP statuses pass through; transport failure throws. */
export async function askApi(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const result = await invoke<AskApiResult>("ask_api", {
    method,
    path,
    body: body === undefined ? null : JSON.stringify(body),
  });
  const parsed = parseBody(result.body);
  if (result.status < 200 || result.status >= 300) {
    throw new AskError(result.status, errorMessage(result.status, parsed), usageOf(parsed));
  }
  return { status: result.status, text: result.body };
}

export async function askApiJson<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const { text } = await askApi(method, path, body);
  return (parseBody(text) ?? {}) as T;
}

export async function askMe(): Promise<AskMe> {
  const json = await askApiJson<AskMe>("GET", "/api/me");
  return json ?? { usage: null };
}

export async function askConversations(): Promise<{ conversations: AskConversation[]; usage: AskUsage | null }> {
  const json = await askApiJson<{ conversations?: AskConversation[]; usage?: AskUsage | null }>("GET", "/api/conversations");
  return { conversations: json?.conversations ?? [], usage: json?.usage ?? null };
}

export async function askConversation(id: string): Promise<AskTurn[]> {
  const json = await askApiJson<{ turns?: AskTurn[] }>("GET", `/api/conversation?id=${encodeURIComponent(id)}`);
  const turns = Array.isArray(json?.turns) ? json.turns : [];
  return turns.filter((turn) => typeof turn?.question === "string");
}

export function askSend(question: string, convId: string | null, useMcp: boolean, reqId: string): Promise<void> {
  return invoke<void>("ask_send", { question, convId, useMcp, reqId });
}

export async function askStop(reqId: string): Promise<void> {
  await invoke<void>("ask_stop", { reqId });
}

export async function askRenderMap(spec: object): Promise<string> {
  const { text } = await askApi("POST", "/api/map/render", spec);
  return text;
}

export function onAskStream(handler: (event: AskStreamEvent) => void): Promise<() => void> {
  return listen<AskStreamEvent>("ask-stream", (event) => handler(event.payload));
}

/** "2h 14m" / "38m" until the daily allowance resets. */
export function resetIn(resetAt: number, now: number = Date.now()): string {
  const mins = Math.max(0, Math.round((resetAt - now) / 60000));
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${mins}m`;
}

/** "7 of 10 left" quota pill text. */
export function quotaLabel(usage: AskUsage | null): string {
  if (!usage) return "";
  return `${usage.remaining} of ${usage.limit} left`;
}

/**
 * Sanitized provider list off /api/me. Anything without a name is dropped, so
 * a malformed entry can never render as a blank row on the consent screen.
 */
export function providersIn(value: unknown): AskProvider[] | null {
  if (!value || typeof value !== "object" || !("aiProviders" in value)) return null;
  const list = (value as { aiProviders?: unknown }).aiProviders;
  if (!Array.isArray(list)) return null;
  const out: AskProvider[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name.trim()) continue;
    const provider: AskProvider = { name: record.name };
    if (typeof record.id === "string") provider.id = record.id;
    if (typeof record.detail === "string" && record.detail) provider.detail = record.detail;
    if (typeof record.url === "string" && /^https:\/\//.test(record.url)) provider.url = record.url;
    out.push(provider);
  }
  return out.length ? out : null;
}
