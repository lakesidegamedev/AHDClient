// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(here, "../src-tauri/src/pull_refresh.js"), "utf8");
const mobile = readFileSync(join(here, "../src-tauri/src/mobile.rs"), "utf8");

const reload = vi.fn();

function touch(type: string, target: EventTarget, y: number, x = 100) {
  const event = new Event(type, { bubbles: true });
  const point = { clientX: x, clientY: y };
  Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [point] });
  target.dispatchEvent(event);
}

function pull(target: EventTarget, distance: number) {
  touch("touchstart", target, 50);
  touch("touchmove", target, 50 + 20);
  touch("touchmove", target, 50 + distance);
  touch("touchend", target, 50 + distance);
}

const added: Array<[string, EventListenerOrEventListenerObject]> = [];

function load() {
  const original = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    added.push([type, listener]);
    original(type, listener, options);
  });
  delete (window as unknown as { __ahdPullRefresh?: boolean }).__ahdPullRefresh;
  new Function(script)();
}

beforeEach(() => {
  reload.mockClear();
  document.body.innerHTML = '<main id="page"><div id="inner"></div><input id="field" /></main>';
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { protocol: "https:", hostname: "ahousedividedgame.com", reload },
  });
  Object.defineProperty(document, "scrollingElement", { configurable: true, value: { scrollTop: 0 } });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [type, listener] of added.splice(0)) document.removeEventListener(type, listener);
});

describe("mobile pull to refresh", () => {
  it("reloads after a long pull from the top of the page", () => {
    load();
    pull(document.getElementById("inner")!, 140);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("ignores a short pull", () => {
    load();
    pull(document.getElementById("inner")!, 40);
    expect(reload).not.toHaveBeenCalled();
  });

  it("ignores a pull when the page is scrolled down", () => {
    (document.scrollingElement as unknown as { scrollTop: number }).scrollTop = 300;
    load();
    pull(document.getElementById("inner")!, 140);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not fight an inner scroll container that is not at its top", () => {
    const inner = document.getElementById("inner")!;
    inner.style.overflowY = "auto";
    Object.defineProperty(inner, "scrollHeight", { value: 800 });
    Object.defineProperty(inner, "clientHeight", { value: 200 });
    inner.scrollTop = 120;
    load();
    pull(inner, 140);
    expect(reload).not.toHaveBeenCalled();
  });

  it("ignores form fields and opted-out regions", () => {
    load();
    pull(document.getElementById("field")!, 140);
    document.getElementById("inner")!.setAttribute("data-no-pull-refresh", "");
    pull(document.getElementById("inner")!, 140);
    expect(reload).not.toHaveBeenCalled();
  });

  it("ignores mostly sideways drags", () => {
    load();
    const target = document.getElementById("inner")!;
    touch("touchstart", target, 50, 20);
    touch("touchmove", target, 80, 200);
    touch("touchmove", target, 200, 260);
    touch("touchend", target, 200, 260);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does nothing on the app's own launcher pages", () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { protocol: "tauri:", hostname: "localhost", reload },
    });
    load();
    pull(document.getElementById("inner")!, 140);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("pull to refresh wiring", () => {
  it("is injected on iOS and Android", () => {
    const both = String.raw`#\[cfg\(any\(target_os = "ios", target_os = "android"\)\)\]`;
    expect(mobile).toMatch(new RegExp(both + String.raw`\s*const PULL_REFRESH_SCRIPT`));
    expect(mobile).toMatch(new RegExp(both + String.raw`\s*\{\s*builder = builder\.initialization_script\(PULL_REFRESH_SCRIPT\)`));
  });
});
