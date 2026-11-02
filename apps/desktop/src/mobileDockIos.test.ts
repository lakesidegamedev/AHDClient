import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) =>
  readFileSync(resolve(here, "../src-tauri/plugins/briefing-widgets/ios/Sources", file), "utf8");

describe("iOS dock source contract", () => {
  const nav = read("NativeNav.swift");
  const dock = read("NativeDock.swift");

  it("replaces the stock tab bar with the SwiftUI dock", () => {
    expect(nav).not.toContain("UITabBar");
    expect(nav).toContain("UIHostingController(rootView: DockView(model: model))");
    expect(dock).toContain("struct DockView: View");
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

  it("only navigates the sheet's rows to bounded game paths", () => {
    expect(nav).toContain("BriefingStore.gamePath(path)");
    for (const path of ["/portfolio", "/actions", "/profile", "/notifications"]) expect(dock).toContain(`"${path}"`);
  });

  it("keeps every shortcut and the 48 point tab target", () => {
    for (const input of ['"k"', '"r"', '"["', '"]"']) expect(nav).toContain(`input: ${input}`);
    expect(nav).toContain("input: String(index + 1)");
    expect(dock).toContain("minHeight: 54");
    expect(dock).toContain("minHeight: 48");
  });

  it("honours Reduce Motion and keeps the tab identifiers", () => {
    expect(dock).toContain("UIAccessibility.isReduceMotionEnabled");
    expect(nav).toContain("reduceMotionStatusDidChangeNotification");
    expect(dock).toContain('"ahdclient-tab-\\(tab.title.lowercased())"');
  });

  it("never polls faster than a minute", () => {
    expect(nav).toContain("withTimeInterval: 60");
    expect(read("BriefingStore.swift")).toContain("maxAge: TimeInterval = 60");
  });
});
