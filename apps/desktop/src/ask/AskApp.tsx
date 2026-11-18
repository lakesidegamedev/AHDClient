import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  askConversation,
  askConversations,
  askMe,
  askSend,
  askStop,
  isSignedOutError,
  onAskStream,
  providersIn,
  quotaLabel,
  resetIn,
  usageFromError,
  usageIn,
  type AskAnswer,
  type AskConversation,
  type AskMe,
  type AskProvider,
  type AskStreamEvent,
  type AskTurn,
  type AskUsage,
} from "./api.js";
import {
  clearCachedAskSession,
  loadCachedAskSession,
  saveCachedAskSession,
  usernameOf,
} from "./session.js";
import {
  ASK_PRIVACY_URL,
  FALLBACK_PROVIDERS,
  clearAskConsent,
  consentSignature,
  hasAskConsent,
  saveAskConsent,
} from "./consent.js";
import { listen } from "@tauri-apps/api/event";
import { ask } from "../worlds.js";
import { translate } from "../i18n.js";
import { readSettings } from "../settings.js";
import { Md } from "./markdown.js";
import "./ask.css";

type Phase = "checking" | "signedOut" | "ready";

interface Msg {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  status?: string | undefined;
  trail?: number;
  result?: AskAnswer;
  error?: string;
  stopped?: boolean;
}

const CONV_KEY = "ahdclient.ask.conv";
const LIVE_KEY = "ahdclient.ask.live";
const STARTERS = [
  "How do action points work?",
  "How does a bill become law?",
  "What changed in the latest turn?",
];

function rememberThreadId(id: string | null): void {
  try {
    if (id) localStorage.setItem(CONV_KEY, id);
    else localStorage.removeItem(CONV_KEY);
  } catch {
    // The thread still works in memory.
  }
}

let msgSeq = 0;
function nextId(prefix: string): string {
  msgSeq += 1;
  return `${prefix}-${Date.now()}-${msgSeq}`;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function answerOf(data: unknown): AskAnswer | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (typeof record.answer !== "string") return null;
  const answer: AskAnswer = {
    answer: record.answer,
    areas: Array.isArray(record.areas) ? record.areas : [],
    citations: Array.isArray(record.citations) ? record.citations : [],
    followups: Array.isArray(record.followups) ? (record.followups as string[]) : [],
    cached: record.cached === true,
    usedMcp: record.usedMcp === true,
    liveSources: Array.isArray(record.liveSources) ? record.liveSources : [],
    liveHint: str(record.liveHint) ?? null,
    vizBlocked: record.vizBlocked === true,
    usage: (record.usage as AskUsage | null) ?? null,
  };
  const reportUrl = str(record.reportUrl);
  if (reportUrl !== undefined) answer.reportUrl = reportUrl;
  const followupsLeft = record.followupsLeft;
  if (typeof followupsLeft === "number") answer.followupsLeft = followupsLeft;
  const model = str(record.model);
  if (model !== undefined) answer.model = model;
  const modelName = str(record.modelName);
  if (modelName !== undefined) answer.modelName = modelName;
  const providerName = str(record.providerName);
  if (providerName !== undefined) answer.providerName = providerName;
  const convId = str(record.convId);
  if (convId !== undefined) answer.convId = convId;
  return answer;
}

function turnToMsgs(turn: AskTurn, scope: string): Msg[] {
  const out: Msg[] = [{ id: nextId(`${scope}-q`), role: "user", text: turn.question }];
  const result = answerOf(turn);
  out.push({
    id: nextId(`${scope}-a`),
    role: "assistant",
    text: turn.answer,
    ...(result ? { result } : {}),
  });
  return out;
}

export function AskApp(): JSX.Element {
  // The last validated snapshot paints the shell instantly; the probe
  // below revalidates it in the background. No cookies or tokens here,
  // only the quota numbers and the account they belong to.
  const [cachedFirst] = useState(loadCachedAskSession);
  // Screen readers hear one short "Answer ready" per finished answer; the
  // streaming text itself is never announced token by token.
  const [announcement, setAnnouncement] = useState("");
  const streamingIds = useRef<Set<string>>(new Set());
  const [phase, setPhase] = useState<Phase>(() =>
    cachedFirst?.usage ?? cachedFirst?.tier ? "ready" : "checking",
  );
  const [usage, setUsage] = useState<AskUsage | null>(() => cachedFirst?.usage ?? null);
  const [tier, setTier] = useState<string | null>(() => cachedFirst?.tier ?? null);
  const [refreshing, setRefreshing] = useState(true);
  const [quotaStale, setQuotaStale] = useState(false);
  const accountRef = useRef<string | null>(cachedFirst?.username ?? null);
  const [convs, setConvs] = useState<AskConversation[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);

  useEffect(() => {
    const seen = streamingIds.current;
    for (const m of msgs) {
      if (m.role === "user") continue;
      if (m.streaming) {
        seen.add(m.id);
      } else if (seen.has(m.id)) {
        seen.delete(m.id);
        if (m.text && !m.error && !m.stopped) {
          // Clear first so the same words twice in a row are announced again.
          setAnnouncement("");
          window.setTimeout(() => setAnnouncement(translate(readSettings().language, "ask.answerReady")), 50);
        }
      }
    }
  }, [msgs]);
  const [input, setInput] = useState("");
  const [activeReq, setActiveReq] = useState<string | null>(null);
  const [fuLeft, setFuLeft] = useState<number | null>(null);
  const [useMcp, setUseMcp] = useState(() => {
    try {
      return localStorage.getItem(LIVE_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const [showHistory, setShowHistory] = useState(false);
  const [showAllowance, setShowAllowance] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Outside AI services named by the server, and whether the player agreed
  // to that exact list. Nothing is sent until they have.
  const [providers, setProviders] = useState<AskProvider[] | null>(null);
  const [consented, setConsented] = useState(false);
  const [reviewingConsent, setReviewingConsent] = useState(false);
  const agreedRef = useRef<string | null>(null);
  const activeReqRef = useRef<string | null>(null);
  const threadChosen = useRef(false);
  const threadRevision = useRef(0);
  const probeRevision = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const patchAssistant = useCallback((reqId: string, patch: (msg: Msg) => Msg) => {
    setMsgs((prev) => prev.map((msg) => (msg.id === `a-${reqId}` ? patch(msg) : msg)));
  }, []);

  const applyProviders = useCallback((me: AskMe) => {
    const list = providersIn(me) ?? FALLBACK_PROVIDERS;
    setProviders(list);
    setConsented(agreedRef.current === consentSignature(list) || hasAskConsent(list));
  }, []);

  const clearThread = useCallback(() => {
    threadChosen.current = false;
    threadRevision.current++;
    activeReqRef.current = null;
    setActiveReq(null);
    setThreadLoading(false);
    setShowHistory(false);
    setShowAllowance(false);
    setNotice(null);
    setConvs([]);
    setConvId(null);
    setFuLeft(null);
    setMsgs([]);
    setInput("");
    rememberThreadId(null);
  }, []);

  const signOut = useCallback(() => {
    probeRevision.current++;
    setRefreshing(false);
    clearThread();
    setConsented(false);
    accountRef.current = null;
    setUsage(null);
    setTier(null);
    setQuotaStale(false);
    clearCachedAskSession();
    setPhase("signedOut");
  }, [clearThread]);

  // Display the authoritative snapshot and keep its non-sensitive summary
  // cached for the next instant open. A new username means the account
  // changed, so the previous account's thread and history go first: nothing
  // from the old account may stay visible while the refresh is in flight.
  const remember = useCallback((nextUsage: AskUsage | null, nextTier: string | null, username: string | null) => {
    if (accountRef.current !== username) {
      clearThread();
      accountRef.current = username;
    }
    setUsage(nextUsage);
    setTier(nextTier);
    setQuotaStale(false);
    saveCachedAskSession({ username, usage: nextUsage, tier: nextTier });
  }, [clearThread]);

  // Quota arriving on any stream payload (answers, credit notices): show it
  // now; the authoritative refresh after the turn confirms it.
  const noteUsage = useCallback((data: unknown) => {
    const next = usageIn(data);
    if (!next) return;
    setUsage(next);
    const cached = loadCachedAskSession();
    saveCachedAskSession({ username: cached?.username ?? accountRef.current, usage: next, tier: cached?.tier ?? null });
  }, []);

  const refreshQuota = useCallback(async () => {
    const revision = probeRevision.current;
    try {
      const me = await askMe();
      if (revision !== probeRevision.current) return;
      remember(me.usage ?? null, me.entitlement?.label ?? null, usernameOf(me));
      applyProviders(me);
    } catch (error) {
      if (revision !== probeRevision.current) return;
      if (isSignedOutError(error)) {
        signOut();
        return;
      }
      const quota = usageFromError(error);
      if (quota) {
        noteUsage({ usage: quota });
        setNotice(error instanceof Error ? error.message : "You have used today's questions.");
      }
      // Background refresh failed: keep the cached allowance on screen but
      // flag it stale so the panel never implies current access.
      setQuotaStale(true);
    }
  }, [applyProviders, noteUsage, remember, signOut]);

  const refreshConvs = useCallback(async () => {
    const account = accountRef.current;
    const revision = probeRevision.current;
    try {
      const { conversations, usage: listUsage } = await askConversations();
      if (revision !== probeRevision.current || account !== accountRef.current) return;
      setConvs(conversations);
      if (listUsage) noteUsage({ usage: listUsage });
    } catch (error) {
      if (revision === probeRevision.current && isSignedOutError(error)) signOut();
      // History is best-effort once the thread is showing.
    }
  }, [noteUsage, signOut]);

  const openThread = useCallback(async (id: string | null) => {
    if (activeReqRef.current) return;
    threadChosen.current = true;
    const revision = ++threadRevision.current;
    setConvId(id);
    setFuLeft(null);
    setNotice(null);
    setMsgs([]);
    setThreadLoading(Boolean(id));
    rememberThreadId(id);
    stickRef.current = true;
    if (!id) return;
    try {
      const turns = await askConversation(id);
      if (revision === threadRevision.current) {
        setMsgs(turns.flatMap((turn, index) => turnToMsgs(turn, `h${index}`)));
      }
    } catch (error) {
      if (revision === threadRevision.current) {
        setNotice(error instanceof Error ? error.message : "Could not load that conversation.");
      }
    } finally {
      if (revision === threadRevision.current) setThreadLoading(false);
    }
  }, []);

  // Reopening the window revalidates access. History hydrates only on the
  // first open for this account so it cannot replace a newer local reply.
  const probe = useCallback(async () => {
    const revision = ++probeRevision.current;
    setRefreshing(true);
    try {
      const me = await askMe();
      if (revision !== probeRevision.current) return;
      const account = usernameOf(me);
      remember(me.usage ?? null, me.entitlement?.label ?? null, account);
      applyProviders(me);
      const { conversations, usage: listUsage } = await askConversations();
      if (revision !== probeRevision.current || account !== accountRef.current) return;
      setConvs(conversations);
      if (listUsage) noteUsage({ usage: listUsage });
      setPhase("ready");
      if (!threadChosen.current) {
        let stored: string | null = null;
        try {
          stored = localStorage.getItem(CONV_KEY);
        } catch {
          // The store may be unavailable.
        }
        const resume = stored && conversations.some((conv) => conv.id === stored) ? stored : null;
        await openThread(resume);
      }
    } catch (error) {
      if (revision !== probeRevision.current) return;
      if (isSignedOutError(error)) {
        signOut();
      } else {
        setNotice(error instanceof Error ? error.message : "Could not reach Ask.");
        setQuotaStale(true);
        setPhase("ready");
      }
    } finally {
      if (revision === probeRevision.current) setRefreshing(false);
    }
  }, [applyProviders, noteUsage, openThread, remember, signOut]);

  useEffect(() => {
    void probe();
  }, [probe]);

  // The sign-in bounce closes itself on login and focuses this panel, so
  // re-probe while signed out and refresh the allowance otherwise. Sign-in,
  // sign-out, and account switches land without reopening the panel.
  useEffect(() => {
    const onFocus = () => {
      if (document.hidden) return;
      if (phase === "signedOut") void probe();
      else void refreshQuota();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [phase, probe, refreshQuota]);

  useEffect(() => {
    let alive = true;
    let stop: (() => void) | undefined;
    void listen<{ ready?: boolean }>("ask-session", (event) => {
      if (!alive) return;
      if (event.payload.ready === false) signOut();
      else void probe();
    }).then((unlisten) => {
      if (!alive) unlisten();
      else stop = unlisten;
    }).catch(() => {
      // Tests and non-Tauri previews still work without the native event.
    });
    return () => {
      alive = false;
      stop?.();
    };
  }, [probe, signOut]);

  // Answer stream routing. One question at a time: the composer locks while
  // a stream is live, so the ref always names the visible placeholder.
  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    const finish = () => {
      if (!live) return;
      activeReqRef.current = null;
      setActiveReq(null);
      void refreshQuota();
      void refreshConvs();
    };
    void onAskStream((event: AskStreamEvent) => {
      if (!live || event.reqId !== activeReqRef.current) return;
      const data = event.data as Record<string, unknown>;
      switch (event.kind) {
        case "meta": {
          noteUsage(data);
          const conv = typeof data.convId === "string" ? data.convId : null;
          if (typeof data.followupsLeft === "number") setFuLeft(data.followupsLeft);
          if (conv) {
            rememberThreadId(conv);
            setConvId(conv);
          }
          break;
        }
        case "status":
          patchAssistant(event.reqId, (msg) => ({
            ...msg,
            status: typeof data.label === "string" ? data.label : "Thinking…",
          }));
          break;
        case "action":
          patchAssistant(event.reqId, (msg) => ({ ...msg, trail: (msg.trail ?? 0) + 1 }));
          break;
        case "delta":
          if (typeof data === "string") {
            patchAssistant(event.reqId, (msg) => ({ ...msg, text: msg.text + data }));
          }
          break;
        case "done": {
          const answer = answerOf(data);
          if (answer) {
            if (answer.convId) {
              rememberThreadId(answer.convId);
              setConvId(answer.convId);
            }
            if (typeof answer.followupsLeft === "number") setFuLeft(answer.followupsLeft);
            if (answer.usage) noteUsage({ usage: answer.usage });
            patchAssistant(event.reqId, (msg) => ({
              ...msg,
              text: answer.answer,
              streaming: false,
              status: undefined,
              result: answer,
            }));
          }
          finish();
          break;
        }
        case "final": {
          const status = typeof data.status === "number" ? data.status : 0;
          let body: unknown = null;
          try {
            body = typeof data.body === "string" ? JSON.parse(data.body) : null;
          } catch {
            body = null;
          }
          if (status >= 200 && status < 300) {
            const answer = answerOf(body);
            if (answer) {
              if (answer.convId) {
                rememberThreadId(answer.convId);
                setConvId(answer.convId);
              }
              if (typeof answer.followupsLeft === "number") setFuLeft(answer.followupsLeft);
              if (answer.usage) noteUsage({ usage: answer.usage });
              patchAssistant(event.reqId, (msg) => ({
                ...msg,
                text: answer.answer,
                streaming: false,
                status: undefined,
                result: answer,
              }));
            } else {
              patchAssistant(event.reqId, (msg) => ({
                ...msg,
                streaming: false,
                status: undefined,
                error: "That answer came back in a shape this panel does not understand yet.",
              }));
            }
          } else if (status === 401) {
            signOut();
            patchAssistant(event.reqId, (msg) => ({ ...msg, streaming: false, status: undefined }));
          } else {
            if (status === 429) {
              const quota = usageIn(body);
              if (quota) noteUsage({ usage: quota });
            }
            const message =
              body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
                ? String((body as { error?: unknown }).error)
                : "Something went wrong. Try again.";
            patchAssistant(event.reqId, (msg) => ({
              ...msg,
              streaming: false,
              status: undefined,
              error: message,
            }));
          }
          finish();
          break;
        }
        case "error":
          patchAssistant(event.reqId, (msg) => ({
            ...msg,
            streaming: false,
            status: undefined,
            error:
              data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
                ? String((data as { error?: unknown }).error)
                : "Something went wrong. Try again.",
          }));
          finish();
          break;
        case "stopped":
          patchAssistant(event.reqId, (msg) => ({ ...msg, streaming: false, status: undefined, stopped: true }));
          finish();
          break;
        default:
          break;
      }
    }).then(
      (stop) => { if (live) unlisten = stop; else stop(); },
      () => { if (live) setNotice("Live answers are unavailable in this window. Restart the client and try again."); },
    );
    return () => {
      live = false;
      unlisten?.();
    };
    // finish/refresh closures are stable single-purpose callbacks for this listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteUsage, patchAssistant, refreshConvs, refreshQuota, signOut]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node && stickRef.current) node.scrollTop = node.scrollHeight;
  }, [msgs]);

  const send = useCallback(
    async (raw: string) => {
      const question = raw.trim();
      if (!question || activeReqRef.current || threadLoading || !consented) return;
      setNotice(null);
      const userMsg: Msg = { id: nextId("q"), role: "user", text: question };
      // Register the request before invoking Rust. Cached answers can arrive
      // over the event channel before the invoke promise resolves.
      const reqId = Array.from(crypto.getRandomValues(new Uint8Array(9)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      threadChosen.current = true;
      activeReqRef.current = reqId;
      setActiveReq(reqId);
      stickRef.current = true;
      const assistant: Msg = {
        id: `a-${reqId}`,
        role: "assistant",
        text: "",
        streaming: true,
        status: "Thinking…",
      };
      setMsgs((prev) => [...prev, userMsg, assistant]);
      setInput("");
      try {
        await askSend(question, convId, useMcp, reqId);
      } catch (error) {
        if (activeReqRef.current !== reqId) return;
        activeReqRef.current = null;
        setActiveReq(null);
        setInput((draft) => draft || question);
        setMsgs((prev) => prev.filter((msg) => msg.id !== assistant.id));
        if (isSignedOutError(error)) {
          signOut();
        } else {
          const quota = usageFromError(error);
          if (quota) noteUsage({ usage: quota });
          setNotice(error instanceof Error ? error.message : "Could not send that question.");
        }
      }
    },
    [consented, convId, noteUsage, signOut, threadLoading, useMcp],
  );

  const stop = useCallback(async () => {
    const reqId = activeReqRef.current;
    if (!reqId) return;
    try {
      await askStop(reqId);
    } catch {
      // The pump still exits on its own; the button did its job.
    }
  }, []);

  const costLabel = fuLeft === null ? "1 question" : fuLeft > 0 ? `Follow-up · ½ question · ${fuLeft} left` : "1 question · follow-ups used up";

  if (phase === "signedOut") {
    return (
      <div className="askview">
        <div className="av-center">
          <div className="av-brand">Ask</div>
          <p className="av-muted">Ask uses your existing game login. If you are already signed in, this panel picks that up without another password.</p>
          <button type="button" className="av-primary" onClick={() => void ask.open().catch(() => undefined)}>
            Continue with game login
          </button>
          <button type="button" className="av-quiet" onClick={() => void probe()}>
            Check again
          </button>
          {notice ? <p className="av-error">{notice}</p> : null}
        </div>
      </div>
    );
  }

  if (providers && (!consented || reviewingConsent)) {
    return (
      <AskConsent
        providers={providers}
        agreed={consented}
        onAgree={() => {
          agreedRef.current = consentSignature(providers);
          saveAskConsent(providers);
          setConsented(true);
          setReviewingConsent(false);
        }}
        onWithdraw={() => {
          agreedRef.current = null;
          clearAskConsent();
          setConsented(false);
          setReviewingConsent(false);
        }}
        onClose={() => setReviewingConsent(false)}
      />
    );
  }

  // Cached quota is last-known, never current: the title says so while the
  // background refresh is in flight or failed.
  const quotaTitle = usage
    ? `${quotaStale ? "Last known allowance · refresh failed. " : refreshing ? "Refreshing allowance… " : ""}${tier ? `Plan: ${tier}. ` : ""}${
      usage.resetAt > 0 ? `Allowance resets in ${resetIn(usage.resetAt)}.` : "Question allowance."
    }`
    : "";
  const checking = phase === "checking";
  const writing = msgs.some((message) => message.streaming);
  const threadTitle = convs.find((conversation) => conversation.id === convId)?.title || "Ask";

  return (
    <div className="askview">
      <header className="av-head">
        <div className="av-heading">
          <span className="av-mark" aria-hidden="true">✦</span>
          <div>
            <h1 className="av-brand">{threadTitle}</h1>
            <p className="av-muted">{writing ? "Writing · safe to close" : "A House Divided"}</p>
          </div>
        </div>
        <div className="av-head-actions">
          {usage ? (
            <button
              type="button"
              className="av-quota"
              aria-live="polite"
              aria-expanded={showAllowance}
              title={quotaTitle}
              onClick={() => { setShowAllowance(!showAllowance); setShowHistory(false); }}
            >
              {quotaLabel(usage)}{refreshing ? " · Updating…" : ""}{quotaStale ? " · Last known" : ""}
            </button>
          ) : refreshing ? (
            <span className="av-quota">Checking access…</span>
          ) : null}
          <button type="button" className="av-iconbtn" aria-label="New chat" title="New chat" disabled={writing} onClick={() => { setShowHistory(false); void openThread(null); }}>
            New
          </button>
          <button
            type="button"
            className="av-iconbtn"
            aria-label="Chat history"
            title="Chat history"
            aria-expanded={showHistory}
            onClick={() => { setShowHistory(!showHistory); setShowAllowance(false); }}
          >
            History
          </button>
        </div>
      </header>

      {usage && showAllowance ? (
        <div className="av-quota-strip" aria-label="Question allowance">
          <div className="av-meter">
            <div className="av-meter-row">
              <span>Questions</span>
              <span>{usage.remaining}/{usage.limit}</span>
            </div>
            <div className="av-bar"><i style={{ width: `${usage.limit ? Math.round((100 * usage.remaining) / usage.limit) : 0}%` }} /></div>
          </div>
          <div className="av-meter">
            <div className="av-meter-row">
              <span>Live data</span>
              <span>{usage.mcpRemaining}/{usage.mcpLimit}</span>
            </div>
            <div className="av-bar"><i style={{ width: `${usage.mcpLimit ? Math.round((100 * usage.mcpRemaining) / usage.mcpLimit) : 0}%` }} /></div>
          </div>
          <p className="av-note">
            {usage.used} of {usage.limit} used · {usage.remaining} left
            {usage.resetAt > 0 ? ` · resets in ${resetIn(usage.resetAt)}` : ""}
            {quotaStale ? " · last known" : refreshing ? " · updating…" : ""}
          </p>
        </div>
      ) : null}

      {showHistory ? (
        <div className="av-history" role="dialog" aria-label="Chat history">
          {writing ? <p className="av-muted">You can switch chats when this answer finishes.</p> : null}
          {convs.length === 0 ? <p className="av-muted">No conversations yet.</p> : null}
          {convs.map((conv) => (
            <button
              key={conv.id}
              type="button"
              className={conv.id === convId ? "av-conv active" : "av-conv"}
              disabled={writing}
              onClick={() => {
                setShowHistory(false);
                void openThread(conv.id);
              }}
            >
              {conv.title || "Untitled conversation"}
            </button>
          ))}
        </div>
      ) : null}

      <div className="av-sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
      <div
        className="av-thread"
        ref={scrollRef}
        role="log"
        aria-label="Conversation"
        aria-live="off"
        aria-busy={writing || threadLoading}
        onScroll={(event) => {
          const node = event.currentTarget;
          stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
      >
        {threadLoading ? <p className="av-muted">Opening chat…</p> : msgs.length === 0 ? (
          <section className="av-welcome">
            <span className="av-mark" aria-hidden="true">✦</span>
            <h2>What would you like to know?</h2>
            <p className="av-muted">Get help with the rules, your character, or what’s happening in the world.</p>
            <div className="av-starters">
              {STARTERS.map((question) => (
                <button key={question} type="button" onClick={() => { setInput(question); composerRef.current?.focus(); }} disabled={checking}>
                  {question}<span aria-hidden="true">↗</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
        {msgs.map((msg) =>
          msg.role === "user" ? (
            <div className="av-turn" key={msg.id}>
              <div className="av-q"><p className="av-qt">{msg.text}</p></div>
            </div>
          ) : (
            <AssistantMsg key={msg.id} msg={msg} onFollowup={send} />
          ),
        )}
      </div>

      {notice ? <p className="av-error" role="alert">{notice}</p> : null}

      <footer className="av-composer">
        <label className="av-live">
          <input
            type="checkbox"
            checked={useMcp}
            onChange={(event) => {
              const checked = event.target.checked;
              setUseMcp(checked);
              try {
                localStorage.setItem(LIVE_KEY, checked ? "on" : "off");
              } catch {
                // Ignore.
              }
            }}
          />
          <span>Use live game data</span>
        </label>
        <div className="av-row">
          <textarea
            ref={composerRef}
            value={input}
            rows={2}
            placeholder={checking ? "Checking access…" : "Ask a question…"}
            aria-label="Ask a question"
            disabled={checking}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send(input);
              }
            }}
          />
          {activeReq ? (
            <button type="button" className="av-stop" aria-label="Stop" title="Stop" onClick={() => void stop()}>
              ■
            </button>
          ) : (
            <button type="button" className="av-send" disabled={checking || threadLoading || writing || !consented || !input.trim()} onClick={() => void send(input)}>
              Ask
            </button>
          )}
        </div>
        <div className="av-cost">
          {costLabel}
          {consented ? (
            <button type="button" className="av-link" onClick={() => setReviewingConsent(true)}>
              AI providers
            </button>
          ) : null}
        </div>
      </footer>
    </div>
  );
}

const AssistantMsg = memo(function AssistantMsg({ msg, onFollowup }: { msg: Msg; onFollowup: (text: string) => void }): JSX.Element {
  const result = msg.result;
  const citations = result?.citations ?? [];
  const followups = result?.followups ?? [];
  const liveSources = result?.liveSources ?? [];
  return (
    <div className="av-turn">
      <div className="av-ans-head">
        <span className="av-ans-label">Answer</span>
        {result?.modelName ? (
          <span className="av-flag">
            {result.providerName && result.providerName !== result.modelName
              ? `${result.modelName} · ${result.providerName}`
              : result.modelName}
          </span>
        ) : null}
        {result?.cached ? <span className="av-flag">cached</span> : null}
        {msg.stopped ? <span className="av-flag">stopped</span> : null}
      </div>
      {msg.text ? <div className="av-answer"><Md text={msg.text} scope={msg.id} /></div> : null}
      {msg.error ? <p className="av-error" role="alert">{msg.error}</p> : null}
      {msg.streaming ? (
        <p className="av-muted">{msg.status ?? (msg.text ? "Writing…" : "Thinking…")}{msg.trail ? ` · ${msg.trail} checks` : ""}</p>
      ) : null}
      {result?.vizBlocked ? (
        <p className="av-note">Visualizations are used up for today, so this answer comes without them.</p>
      ) : null}
      {liveSources.length > 0 ? (
        <p className="av-live-src">Live: {liveSources.map((source) => source.label).join(" · ")}</p>
      ) : null}
      {citations.length > 0 ? (
        <details className="av-srcs">
          <summary>Sources · {citations.length}</summary>
          <ol>
            {citations.map((citation, i) => (
              <li key={i}>
                {citation.url ? (
                  <a href={citation.url} target="_blank" rel="noopener">{citation.label || citation.path || citation.url}</a>
                ) : (
                  citation.label || citation.path || "Source"
                )}
                {citation.url && citation.path ? <span className="av-src-path">{citation.path}</span> : null}
                {!citation.url && citation.path && citation.label ? <span className="av-src-path">{citation.path}</span> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {followups.length > 0 && !msg.streaming ? (
        <div className="av-sugg">
          {followups.map((followup, i) => (
            <button key={i} type="button" onClick={() => onFollowup(followup)}>
              {followup}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});

function AskConsent({
  providers,
  agreed,
  onAgree,
  onWithdraw,
  onClose,
}: {
  providers: AskProvider[];
  agreed: boolean;
  onAgree: () => void;
  onWithdraw: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="askview">
      <div className="av-consent" role="dialog" aria-labelledby="av-consent-title">
        <h2 id="av-consent-title">Ask uses outside AI services</h2>
        <p>
          Ask answers with AI models run by other companies. When you send a question, it goes to one of the services
          below. What they receive: the text you type, earlier messages in the same chat, any file you attach, and, if
          you ask about your own character, your own game records. Your username, email and account IDs are not sent.
        </p>
        <ul className="av-providers">
          {providers.map((provider) => (
            <li key={`${provider.name}|${provider.detail ?? ""}`}>
              <strong>{provider.name}</strong>
              {provider.detail ? <span>{provider.detail}</span> : null}
            </li>
          ))}
        </ul>
        <p>
          Each service has its own terms and data handling. Every answer shows which model and service wrote it. Lakeside
          keeps your conversations so they appear in your history.
        </p>
        <p>
          <a href={ASK_PRIVACY_URL} target="_blank" rel="noopener">
            Ask privacy notice
          </a>
        </p>
        {agreed ? (
          <div className="av-consent-actions">
            <button type="button" className="av-primary" onClick={onClose}>
              Keep using Ask
            </button>
            <button type="button" className="av-quiet" onClick={onWithdraw}>
              Withdraw permission
            </button>
          </div>
        ) : (
          <div className="av-consent-actions">
            <button type="button" className="av-primary" onClick={onAgree}>
              Allow and continue
            </button>
            <p className="av-muted">Ask does not send anything until you allow it.</p>
          </div>
        )}
      </div>
    </div>
  );
}
