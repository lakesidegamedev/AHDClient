/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  askMe: vi.fn(),
  askConversations: vi.fn(),
  askConversation: vi.fn(),
  askSend: vi.fn(),
  askStop: vi.fn(),
  askOpen: vi.fn(),
  streamHandler: null as null | ((event: { reqId: string; kind: string; data: unknown }) => void),
}));

vi.mock("./api.js", () => ({
  askMe: (...args: unknown[]) => mocks.askMe(...args),
  askConversations: (...args: unknown[]) => mocks.askConversations(...args),
  askConversation: (...args: unknown[]) => mocks.askConversation(...args),
  askSend: (...args: unknown[]) => mocks.askSend(...args),
  askStop: (...args: unknown[]) => mocks.askStop(...args),
  askRenderMap: vi.fn(async () => "<svg></svg>"),
  onAskStream: (handler: (event: { reqId: string; kind: string; data: unknown }) => void) => {
    mocks.streamHandler = handler;
    return Promise.resolve(() => {});
  },
  quotaLabel: (usage: { remaining: number; limit: number } | null) =>
    usage ? `${usage.remaining} of ${usage.limit} left` : "",
  resetIn: () => "38m",
  usageIn: (value: unknown) =>
    value && typeof value === "object" && "usage" in value
      ? ((value as { usage?: unknown }).usage ?? null)
      : null,
  isSignedOutError: (error: unknown) =>
    !!(
      (error && typeof error === "object" && "signedOut" in error && (error as { signedOut?: unknown }).signedOut === true) ||
      (typeof error === "string" && /sign in/i.test(error))
    ),
  usageFromError: (error: unknown) =>
    error && typeof error === "object" && "usage" in error ? (error as { usage?: unknown }).usage ?? null : null,
  providersIn: (value: unknown) => {
    const list = value && typeof value === "object" ? (value as { aiProviders?: unknown }).aiProviders : undefined;
    return Array.isArray(list) && list.length ? list : null;
  },
  AskError: class AskError extends Error {},
}));

vi.mock("../worlds.js", () => ({ ask: { open: mocks.askOpen } }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { AskApp } from "./AskApp.js";
import { ASK_SESSION_CACHE_KEY } from "./session.js";
import { saveCachedAskSession } from "./session.js";
import { FALLBACK_PROVIDERS, saveAskConsent } from "./consent.js";

const baseUsage = {
  used: 3,
  limit: 10,
  remaining: 7,
  mcpUsed: 0,
  mcpLimit: 2,
  mcpRemaining: 2,
  resetAt: Date.now() + 3600_000,
};

const me = (username: string, usage: unknown) => ({
  identity: { username },
  entitlement: { allowed: true, label: "Player" },
  usage,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  localStorage.clear();
  // Most tests are about the panel after permission; consent has its own block.
  saveAskConsent(FALLBACK_PROVIDERS);
  mocks.streamHandler = null;
  mocks.askMe.mockReset().mockResolvedValue(me("marshall", baseUsage));
  mocks.askConversations.mockReset().mockResolvedValue({ conversations: [], usage: null });
  mocks.askConversation.mockReset().mockResolvedValue([]);
  mocks.askSend.mockReset().mockResolvedValue("req-1");
  mocks.askStop.mockReset().mockResolvedValue(undefined);
  mocks.askOpen.mockReset();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("ask startup", () => {
  it("paints the usable shell immediately from cache while /api/me is still pending", async () => {
    saveCachedAskSession({ username: "marshall", usage: baseUsage, tier: "Player" });
    const gate = deferred<unknown>();
    mocks.askMe.mockReturnValue(gate.promise);

    render(<AskApp />);

    // Shell is usable before the authoritative refresh answers.
    expect(screen.getByText("7 of 10 left", { exact: false })).toBeTruthy();
    expect((screen.getByLabelText("Ask a question") as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.queryByText("Opening your questions…")).toBeNull();

    gate.resolve(me("marshall", { ...baseUsage, used: 4, remaining: 6 }));
    await waitFor(() => expect(screen.getByText("6 of 10 left", { exact: false })).toBeTruthy());
  });

  it("shows an explicit checking shell instead of a blocked panel on first launch", async () => {
    const gate = deferred<unknown>();
    mocks.askMe.mockReturnValue(gate.promise);

    render(<AskApp />);

    expect(screen.queryByText("Opening your questions…")).toBeNull();
    expect(screen.getByText("Checking access…")).toBeTruthy();
    expect(screen.getByLabelText("Ask a question")).toBeTruthy();
    expect((screen.getByLabelText("Ask a question") as HTMLTextAreaElement).disabled).toBe(true);

    gate.resolve(me("marshall", baseUsage));
    await waitFor(() =>
      expect((screen.getByLabelText("Ask a question") as HTMLTextAreaElement).disabled).toBe(false),
    );
    expect(screen.getByText("7 of 10 left", { exact: false })).toBeTruthy();
  });

  it("signs out and clears cached quota on 401", async () => {
    saveCachedAskSession({ username: "marshall", usage: baseUsage, tier: "Player" });
    mocks.askMe.mockRejectedValue({ signedOut: true, message: "Please sign in to Ask first." });

    render(<AskApp />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Continue with game login" })).toBeTruthy());
    expect(screen.getByText(/existing game login/i)).toBeTruthy();
    expect(localStorage.getItem(ASK_SESSION_CACHE_KEY)).toBeNull();
  });

  it("replaces cached quota when the account changes", async () => {
    saveCachedAskSession({ username: "marshall", usage: baseUsage, tier: "Player" });
    const other = { ...baseUsage, used: 9, remaining: 1 };
    mocks.askMe.mockResolvedValue(me("delegate", other));

    render(<AskApp />);

    await waitFor(() => expect(screen.getByText("1 of 10 left", { exact: false })).toBeTruthy());
    expect(screen.queryByText("7 of 10 left", { exact: false })).toBeNull();
    expect(JSON.parse(localStorage.getItem(ASK_SESSION_CACHE_KEY) ?? "{}").username).toBe("delegate");
  });

  it("drops the previous account's open thread when the account changes", async () => {
    saveCachedAskSession({ username: "marshall", usage: baseUsage, tier: "Player" });
    localStorage.setItem("ahdclient.ask.conv", "c1");
    mocks.askConversations.mockResolvedValue({ conversations: [{ id: "c1", title: "Harvest" }], usage: null });
    mocks.askConversation.mockResolvedValue([{ question: "Why did the harvest fail?", answer: "Blight." }]);

    render(<AskApp />);
    await waitFor(() => expect(screen.getByText("Why did the harvest fail?")).toBeTruthy());

    const other = { ...baseUsage, used: 9, remaining: 1 };
    mocks.askMe.mockResolvedValue(me("delegate", other));
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(screen.getByText("1 of 10 left", { exact: false })).toBeTruthy());
    expect(screen.queryByText("Why did the harvest fail?")).toBeNull();
    expect(localStorage.getItem("ahdclient.ask.conv")).toBeNull();
  });
});

describe("ask quota updates", () => {
  it("updates quota from the answer event", async () => {
    render(<AskApp />);
    await waitFor(() =>
      expect((screen.getByLabelText("Ask a question") as HTMLTextAreaElement).disabled).toBe(false),
    );

    const answered = { ...baseUsage, used: 4, remaining: 6 };
    const refresh = deferred<unknown>();
    mocks.askMe.mockReturnValue(refresh.promise);

    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: "Why did the harvest fail?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(mocks.askSend).toHaveBeenCalled());

    mocks.streamHandler?.({
      reqId: "req-1",
      kind: "done",
      data: { answer: "Blight.", usage: answered },
    });
    await waitFor(() => expect(screen.getByText("6 of 10 left", { exact: false })).toBeTruthy());

    refresh.resolve(me("marshall", answered));
    await waitFor(() => expect(screen.getByText("6 of 10 left", { exact: false })).toBeTruthy());
  });

  it("updates quota on a 429 answer refusal", async () => {
    render(<AskApp />);
    await waitFor(() =>
      expect((screen.getByLabelText("Ask a question") as HTMLTextAreaElement).disabled).toBe(false),
    );

    const spent = { ...baseUsage, used: 10, remaining: 0 };
    const refresh = deferred<unknown>();
    mocks.askMe.mockReturnValue(refresh.promise);

    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: "One more question?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(mocks.askSend).toHaveBeenCalled());

    mocks.streamHandler?.({
      reqId: "req-1",
      kind: "final",
      data: { status: 429, body: JSON.stringify({ error: "No questions left", usage: spent }) },
    });
    await waitFor(() => expect(screen.getByText("0 of 10 left", { exact: false })).toBeTruthy());

    refresh.resolve(me("marshall", spent));
  });
});

describe("ask screen reader support", () => {
  it("marks the thread as a log and announces a finished answer once", async () => {
    render(<AskApp />);
    await waitFor(() =>
      expect((screen.getByLabelText("Ask a question") as HTMLTextAreaElement).disabled).toBe(false),
    );
    expect(screen.getByRole("log").getAttribute("aria-live")).toBe("off");

    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: "Why?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(mocks.askSend).toHaveBeenCalled());
    expect(screen.getByRole("log").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("");

    mocks.streamHandler?.({ reqId: "req-1", kind: "done", data: { answer: "Blight.", usage: baseUsage } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Answer ready"));
    expect(screen.getByRole("log").getAttribute("aria-busy")).toBe("false");
  });
});

describe("ask AI provider consent", () => {
  const providers = [
    { id: "muse", name: "Meta", detail: "Muse Spark models" },
    { id: "deepseek", name: "DeepSeek", detail: "DeepSeek models, operated from China" },
  ];

  it("names the providers and sends nothing until the player allows it", async () => {
    localStorage.clear();
    mocks.askMe.mockResolvedValue({ ...me("marshall", baseUsage), aiProviders: providers });

    render(<AskApp />);

    await waitFor(() => expect(screen.getByText("Ask uses outside AI services")).toBeTruthy());
    expect(screen.getByText("Meta")).toBeTruthy();
    expect(screen.getByText("DeepSeek models, operated from China")).toBeTruthy();
    expect(screen.queryByLabelText("Ask a question")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Allow and continue" }));

    await waitFor(() => expect(screen.getByLabelText("Ask a question")).toBeTruthy());
    expect(mocks.askSend).not.toHaveBeenCalled();
  });

  it("asks again when the provider list changes", async () => {
    localStorage.clear();
    saveAskConsent(providers);
    mocks.askMe.mockResolvedValue({
      ...me("marshall", baseUsage),
      aiProviders: [...providers, { id: "google", name: "Google", detail: "Gemini models" }],
    });

    render(<AskApp />);

    await waitFor(() => expect(screen.getByText("Ask uses outside AI services")).toBeTruthy());
    expect(screen.getByText("Google")).toBeTruthy();
  });

  it("lets the player review and withdraw permission", async () => {
    render(<AskApp />);

    await waitFor(() => expect(screen.getByRole("button", { name: "AI providers" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "AI providers" }));
    fireEvent.click(screen.getByRole("button", { name: "Withdraw permission" }));

    expect(screen.getByRole("button", { name: "Allow and continue" })).toBeTruthy();
    expect(screen.queryByLabelText("Ask a question")).toBeNull();
  });

  it("shows which model and service wrote each answer", async () => {
    render(<AskApp />);

    await waitFor(() => expect((screen.getByLabelText("Ask a question") as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: "How do elections work?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(mocks.askSend).toHaveBeenCalled());
    await waitFor(() => expect(mocks.streamHandler).not.toBeNull());

    mocks.streamHandler!({
      reqId: "req-1",
      kind: "done",
      data: { answer: "They run on a calendar.", modelName: "DeepSeek V4 Flash", providerName: "Ollama Cloud" },
    });

    await waitFor(() => expect(screen.getByText("DeepSeek V4 Flash · Ollama Cloud")).toBeTruthy());
  });
});
