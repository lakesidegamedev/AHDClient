import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) =>
  readFileSync(resolve(here, "../src-tauri/plugins/briefing-widgets/ios/Sources", file), "utf8");

describe("iOS dock source contract", () => {
  const nav = read("NativeNav.swift");
  const model = read("NativeDockModel.swift");
  const view = read("NativeDockView.swift");
  const layout = read("NativeDockLayout.swift");
  const status = read("NativeDockStatus.swift");

  it("replaces the stock tab bar with the SwiftUI dock", () => {
    expect(nav).not.toContain("UITabBar");
    expect(nav).toContain("UIHostingController(rootView: DockView(model: model))");
    expect(view).toContain("struct DockView: View");
  });

  it("marks the user agent only from the dock's own attach path", () => {
    expect(nav).toContain('static let statusMarker = "AHDClientNativeStatus/1"');
    // Appended to the existing agent, never replacing it, and skipped if already present.
    expect(nav).toContain("webView.customUserAgent = base + \" \" + Self.statusMarker");
    expect(nav).toContain("guard !base.contains(Self.statusMarker)");
    // The Rust side must not add the marker: an app whose dock never attached keeps the web footer.
    expect(readFileSync(resolve(here, "../src-tauri/src/mobile.rs"), "utf8")).not.toContain("AHDClientNativeStatus");
  });

  it("accepts one fixed word from game pages on the turn-complete bridge", () => {
    expect(nav).toContain("window.addEventListener('ahd:turn-complete'");
    expect(nav).toContain('(message.body as? String) == "turn-complete"');
    expect(nav).toContain("message.frameInfo.isMainFrame");
    expect(nav).toContain("NativeNavController.gameHosts.contains(host)");
  });

  it("only navigates the dock's rows and links to bounded game paths", () => {
    expect(nav).toContain("BriefingStore.gamePath(path)");
    expect(layout).toContain("BriefingStore.gamePath(value)");
    for (const path of ["/portfolio", "/actions", "/profile", "/notifications"]) expect(status).toContain(`"${path}"`);
  });

  it("keeps every shortcut and the 48 point targets", () => {
    for (const input of ['"k"', '"r"', '"["', '"]"']) expect(nav).toContain(`input: ${input}`);
    // Cmd+1 to Cmd+5 are the dock's tabs, whatever they are.
    expect(nav).toContain("input: String(index + 1)");
    expect(nav).toContain("controller?.tabTitles");
    expect(view).toContain("minHeight: 54");
    expect(view).toContain("minHeight: 48");
    expect(status).toContain("minHeight: 48");
  });

  it("honours Reduce Motion and keeps the tab identifiers", () => {
    expect(model).toContain("UIAccessibility.isReduceMotionEnabled");
    expect(nav).toContain("reduceMotionStatusDidChangeNotification");
    expect(view).toContain('"ahdclient-tab-\\(tab.id)"');
  });

  it("never polls faster than a minute", () => {
    expect(nav).toContain("withTimeInterval: 60");
    expect(read("BriefingStore.swift")).toContain("maxAge: TimeInterval = 60");
  });

  it("falls back to the app's own tabs and never leaves the player stuck", () => {
    expect(model).toContain("static let fallback: [DockTab]");
    for (const label of ["Game", "Briefing", "Ask", "More"]) expect(model).toContain(`label: "${label}"`);
    // No layout, or a 401: app tabs. Any other failure keeps what the dock already has.
    expect(nav).toContain("case .signedOut:\n        self.model.setLayout(nil)");
    expect(nav).toContain("case .unavailable:\n        break");
  });

  it("asks the game for its layout on foreground, login and section change, and caches per account", () => {
    expect(layout).toContain("https://ahousedividedgame.com/api/mobile-dock");
    expect(layout).toContain('"Accept-Language"');
    expect(nav).toContain("refreshLayout(maxAge: 30)");
    expect(nav).toContain("refreshLayout(maxAge: 300)");
    expect(nav).toContain("refreshLayout(maxAge: 0)");
    expect(layout).toContain("enum DockLayoutCache");
    expect(nav).toContain("DockLayoutCache.load(account: next)");
  });

  it("puts the app section first in More and badges the More tab", () => {
    expect(view).toContain('tab.id == "more" ? model.badge : 0');
    expect(view.indexOf("appRows")).toBeLessThan(view.indexOf("sheet?.sections"));
    for (const label of ["Briefing", "Inbox", "Ask", "Back to launcher"]) expect(view).toContain(`"${label}"`);
  });
});

describe("iOS dock preview fixture", () => {
  const source = read("NativeDockLayout.swift");
  const fixture = JSON.parse(source.slice(source.indexOf('static let json = """') + 21).split('"""')[0] ?? "");

  it("matches the /api/mobile-dock contract", () => {
    expect(fixture.version).toBe(1);
    expect(fixture.tabs.map((tab: { id: string }) => tab.id)).toEqual(["company", "state", "nation", "actions", "more"]);
    for (const tab of fixture.tabs) {
      expect(Boolean(tab.href) !== Boolean(tab.sheet)).toBe(true);
      if (tab.sheet) expect(fixture.sheets[tab.sheet]).toBeDefined();
      expect(tab.icon.grid.every((row: string) => /^[01]+$/.test(row))).toBe(true);
      expect(Array.isArray(tab.activePrefixes)).toBe(true);
    }
    for (const sheet of Object.values(fixture.sheets) as { sections: { links: { href: string }[] }[] }[]) {
      for (const section of sheet.sections) for (const link of section.links) expect(link.href.startsWith("/")).toBe(true);
    }
  });

  it("uses no em or en dashes in any dock source", () => {
    for (const file of ["NativeNav.swift", "NativeDock.swift", "NativeDockModel.swift", "NativeDockView.swift", "NativeDockLayout.swift", "NativeDockStatus.swift"]) {
      expect(read(file)).not.toMatch(/[–—]/);
    }
  });
});
