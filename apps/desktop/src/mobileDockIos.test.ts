import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) =>
  readFileSync(
    resolve(here, "../src-tauri/plugins/briefing-widgets/ios/Sources", file),
    "utf8",
  );

describe("iOS dock source contract", () => {
  const nav = read("NativeNav.swift");
  const model = read("NativeDockModel.swift");
  const view = read("NativeDockView.swift");
  const layout = read("NativeDockLayout.swift");
  const status = read("NativeDockStatus.swift");
  const core = read("NativeDockCore.swift");

  it("replaces the stock tab bar with the SwiftUI dock", () => {
    expect(nav).not.toContain("UITabBar");
    expect(nav).toContain(
      "UIHostingController(rootView: DockView(model: model))",
    );
    expect(view).toContain("struct DockView: View");
  });

  it("judges the keyboard in window coordinates and sizes the dock for landscape", () => {
    expect(nav).toContain("DockKeyboard.coversDock(keyboard: local, window: window.bounds)");
    expect(nav).not.toContain("screen.bounds.height");
    expect(nav).toContain("DockUserAgent.truthful(base, isPad:");
    expect(view).toContain("verticalSizeClass == .compact");
    expect(view).toContain(".hoverEffect(.highlight)");
  });

  it("marks the user agent only from the dock's own attach path", () => {
    expect(nav).toContain(
      'static let statusMarker = "AHDClientNativeStatus/1"',
    );
    // Appended to the existing agent, never replacing it, and skipped if already present.
    expect(nav).toContain(
      'webView.customUserAgent = truthful + " " + Self.statusMarker',
    );
    expect(nav).toContain("guard !base.contains(Self.statusMarker)");
    // The Rust side must not add the marker: an app whose dock never attached keeps the web footer.
    expect(
      readFileSync(resolve(here, "../src-tauri/src/mobile.rs"), "utf8"),
    ).not.toContain("AHDClientNativeStatus");
  });

  it("accepts one fixed word from game pages on the turn-complete bridge", () => {
    expect(nav).toContain("window.addEventListener('ahd:turn-complete'");
    expect(nav).toContain('body == "turn-complete", let host = url.host');
    expect(nav).toContain("message.frameInfo.isMainFrame");
    expect(nav).toContain("NativeNavController.gameHosts.contains(host)");
  });

  it("only navigates the dock's rows and links to bounded game paths", () => {
    expect(nav).toContain("BriefingStore.gamePath(path)");
    expect(layout).toContain("BriefingStore.gamePath(value)");
    for (const path of ["/portfolio", "/actions", "/profile", "/notifications"])
      expect(status).toContain(`"${path}"`);
  });

  it("keeps every shortcut and the 48 point targets", () => {
    for (const input of ['"k"', '"r"', '"["', '"]"'])
      expect(nav).toContain(`input: ${input}`);
    // Cmd+1 to Cmd+5 are the dock's tabs, whatever they are.
    expect(nav).toContain("input: String(index + 1)");
    expect(nav).toContain("controller?.tabTitles");
    expect(view).toContain("minHeight: compact ? 44 : 54");
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
    expect(core).toContain("static let fallback: [DockTab]");
    for (const label of ["Game", "Briefing", "Ask", "More"])
      expect(core).toContain(`label: "${label}"`);
    // No layout, or a 401: app tabs. Any other failure keeps what the dock already has.
    expect(nav).toContain(
      "case .signedOut:\n        DockLayoutCache.clear(account: account)\n        self.model.setLayout(nil)",
    );
    expect(nav).toContain("case .unavailable:\n        break");
  });

  it("asks the game for its layout on foreground, login and section change, and caches per account", () => {
    expect(layout).toContain("https://ahousedividedgame.com/api/mobile-dock");
    expect(nav).toContain("refreshLayout(maxAge: 30)");
    expect(nav).toContain("refreshLayout(maxAge: 300)");
    expect(nav).toContain("refreshLayout(maxAge: 0)");
    expect(layout).toContain("enum DockLayoutCache");
    expect(nav).toContain("DockLayoutCache.load(key: layoutKey())");
  });

  it("puts the app section first in More and badges the More tab", () => {
    expect(view).toContain('tab.id == "more" ? model.badge : 0');
    expect(view.indexOf("ForEach(Array(appRows.enumerated())")).toBeLessThan(
      view.indexOf("ForEach(sections)"),
    );
    for (const label of ["Briefing", "Inbox", "Ask", "Back to launcher"])
      expect(view).toContain(`"${label}"`);
  });
});

describe("iOS dock fix round contract", () => {
  const nav = read("NativeNav.swift");
  const model = read("NativeDockModel.swift");
  const view = read("NativeDockView.swift");
  const layout = read("NativeDockLayout.swift");
  const core = read("NativeDockCore.swift");
  const dockFile = read("NativeDock.swift");

  it("sends the ahd-locale cookie with the dock request and keys the cache by language", () => {
    expect(layout).toContain('header += "; ahd-locale=" + locale');
    expect(nav).toContain('$0.name == "ahd-locale"');
    expect(nav).toContain("httpCookieStore");
    expect(layout).toContain(
      'account + "|" + (locale ?? "-") + "|" + (country ?? "-")',
    );
    // A changed language swaps the cached tabs and asks again.
    expect(nav).toContain("let changed = first || locale != self.layoutLocale");
  });

  it("follows the country page with a throttled, per-country request", () => {
    expect(core).toContain('parts[0] == "country"');
    expect(nav).toContain("DockTabs.country(inPath: path)");
    expect(layout).toContain(
      'URLQueryItem(name: "country", value: country.uppercased())',
    );
    expect(nav).toContain("layoutFetchedAt[key]");
  });

  it("uses the app tabs on the sandbox and drops to them at once on sign-out", () => {
    expect(nav).toContain("url.host == Self.sandboxHost");
    expect(nav).toContain(
      "guard layoutAccount != nil, !onSandbox else {\n      model.setLayout(nil)",
    );
    expect(core).toContain('["/login", "/register", "/logout"]');
    expect(nav).toContain("DockTabs.signedOutPaths.contains(path)");
    expect(nav).toContain("DockLayoutCache.clear(account: account)");
    expect(nav).toContain("BriefingStore.sessionFingerprint()");
  });

  it("refetches for the current account when the session changed during a fetch", () => {
    expect(nav).toContain(
      "guard BriefingStore.sessionFingerprint() == account else {\n        self.syncAccount()",
    );
    expect(nav).toContain(
      "guard self.layoutKey() == key, !self.onSandbox else {\n        self.refreshLayout(maxAge: 0)",
    );
  });

  it("caches in Application Support, out of backups, keyed by the session fingerprint", () => {
    expect(layout).toContain("applicationSupportDirectory");
    expect(layout).toContain("isExcludedFromBackup = true");
    expect(layout).not.toContain("UserDefaults.standard.set");
    expect(layout).not.toContain("defaults.set(");
    expect(layout).toContain("removeObject(forKey: legacyDefaultsKey)");
    expect(layout).not.toContain("accountKey(");
    expect(read("BriefingStore.swift")).toContain(
      "static func sessionFingerprint() -> String?",
    );
  });

  it("hides the dock while the keyboard is up and pads from the window's home indicator only", () => {
    expect(nav).toContain("UIResponder.keyboardWillChangeFrameNotification");
    expect(nav).toContain("UIResponder.keyboardWillHideNotification");
    expect(nav).toContain("host?.window?.safeAreaInsets.bottom");
    expect(model).toContain(
      "let height = keyboardUp ? 0 : baseHeight + bottomPad + DockStyle.pageGap",
    );
    expect(view).toContain("let pad = model.bottomPad");
    expect(view).not.toContain("geo.safeAreaInsets");
    expect(dockFile).toContain("guard let model, !model.keyboardUp");
  });

  it("makes an open panel modal for VoiceOver and announces its title", () => {
    expect(nav).toContain("self.container?.accessibilityViewIsModal = open");
    expect(nav).toContain(
      "UIAccessibility.post(notification: .screenChanged, argument: self.model.title(of: self.model.panel))",
    );
  });

  it("opens external rows outside the webview, never through webView.load", () => {
    expect(nav).toContain("SFSafariViewController(url: url)");
    expect(nav).toContain("UIApplication.shared.open(url)");
    expect(nav).toContain("guard DockExternal.url(url.absoluteString) != nil");
    expect(core).toContain(
      '"wiki.ahousedividedgame.com", "discord.gg", "www.patreon.com", "lakesidegames.net", "docs.lakesidegames.net"',
    );
    expect(core).toContain(
      'static let mailbox = "admin@ahousedividedgame.com"',
    );
    expect(layout).toContain("var external: Bool?");
    expect(layout).toContain(
      "guard let url = DockExternal.url(raw) else { return nil }",
    );
  });

  it("drops the game's notifications row on More because the app adds an Inbox row", () => {
    expect(view).toContain('sheet.sections(without: "notifications")');
  });

  it("closes the open sheet only when the page path changes", () => {
    expect(nav).toContain("if place != lastPlace {");
    expect(nav).not.toContain("if url != lastURL {");
  });

  it("draws every grid as crisp whole-pixel squares, app rows and fallback tabs included", () => {
    expect(view).toContain("FillStyle(antialiased: false)");
    expect(view).toContain("floor(min(side / columns, side / rows) * screen)");
    // The pop is one device pixel per cell, not a fractional scale.
    expect(view).toContain("fit + (emphasized ? 1 : 0)");
    expect(view).not.toMatch(/DockPixelIcon[^\n]*scaleEffect/);
    for (const name of ["game", "briefing", "inbox", "ask", "launcher", "more"])
      expect(core).toContain(`static let ${name} = DockIcon(`);
    for (const row of [
      "DockAppIcons.briefing",
      "DockAppIcons.inbox",
      "DockAppIcons.ask",
      "DockAppIcons.launcher",
    ])
      expect(view).toContain(row);
    // No SF Symbol is used for an app row or a fallback tab.
    expect(view).not.toContain('symbol: "newspaper"');
  });

  it("reserves the icon column on every sheet row and ellipsizes long labels", () => {
    expect(view).toContain("// The icon column is always reserved");
    expect(view).toContain(".frame(width: 28, height: 28)");
    expect(view).not.toContain("reserveIcon");
    expect(view).toContain(".truncationMode(.tail)");
    expect(layout).toContain("static let maxLabel = 80");
    expect(layout).toContain("static let maxID = 64");
    expect(layout).toContain("static let maxSections = 16");
  });

  it("uses the game's shortLabel for a tab and never shows the strip on Briefing", () => {
    expect(layout).toContain(
      "clean(tab.shortLabel, limit: maxLabel) ?? clean(tab.label, limit: maxLabel)",
    );
    expect(model).toContain('onStripPage && selectedID != "briefing"');
  });

  it("previews over a stand-in game page so the strip is never photographed on the launcher", () => {
    expect(nav).toContain(
      "webView.loadHTMLString(NativeDockPreview.standInPage",
    );
  });

  it("is compiled and run on a Mac against the real payloads in CI", () => {
    const workflows = ["release-mobile.yml", "ios-dock-preview.yml"].map(
      (file) =>
        readFileSync(resolve(here, "../../../.github/workflows", file), "utf8"),
    );
    for (const text of workflows) {
      expect(text).toContain(".github/dock-core-test/main.swift");
      expect(text).toContain("apps/desktop/src/dockFixtures");
    }
  });
});

describe("real /api/mobile-dock payloads", () => {
  type Link = {
    id: string;
    label: string;
    href: string;
    icon?: { grid: string[] };
    external?: boolean;
  };
  type Section = { id: string; title: string; links: Link[] };
  type Payload = {
    version: number;
    tabs: {
      id: string;
      label: string;
      shortLabel?: string;
      href?: string;
      sheet?: string;
      activePrefixes: string[];
      icon: { grid: string[] };
    }[];
    sheets: Record<
      "state" | "nation" | "more",
      { title: string; sections: Section[] }
    >;
  };
  const load = (name: string) =>
    JSON.parse(
      readFileSync(resolve(here, "dockFixtures", name), "utf8"),
    ) as Payload;
  const staff = load("mobile-dock-staff-us.json");
  const player = load("mobile-dock-player-nocompany-uk.json");
  const swiftTest = readFileSync(
    resolve(here, "../../../.github/dock-core-test/main.swift"),
    "utf8",
  );

  it("has five tabs and non-empty state, nation and more sheets", () => {
    for (const payload of [staff, player]) {
      expect(payload.version).toBe(1);
      expect(payload.tabs).toHaveLength(5);
      for (const key of ["state", "nation", "more"] as const)
        expect(payload.sheets[key].sections.length).toBeGreaterThan(0);
    }
    expect(staff.tabs.map((tab) => tab.id)).toEqual([
      "company",
      "state",
      "nation",
      "actions",
      "more",
    ]);
    expect(player.tabs.map((tab) => tab.id)).toEqual([
      "market",
      "state",
      "nation",
      "actions",
      "more",
    ]);
  });

  it("keeps the staff section in the staff More sheet, and the player has none", () => {
    expect(staff.sheets.more.sections.map((section) => section.id)).toContain(
      "staff:staff",
    );
    expect(
      player.sheets.more.sections.some((section) =>
        section.id.startsWith("staff"),
      ),
    ).toBe(false);
    expect(staff.sheets.more.sections.length).toBe(13);
  });

  it("carries colon section ids, a short nation label and external links", () => {
    expect(
      staff.sheets.state.sections.every((section) => section.id.includes(":")),
    ).toBe(true);
    expect(
      staff.tabs.find((tab) => tab.id === "nation")?.shortLabel,
    ).toBeTruthy();
    const external = staff.sheets.more.sections
      .flatMap((section) => section.links)
      .filter((link) => link.external);
    expect(external.length).toBe(7);
    const allowed = new Set([
      "wiki.ahousedividedgame.com",
      "discord.gg",
      "www.patreon.com",
      "lakesidegames.net",
      "docs.lakesidegames.net",
    ]);
    for (const link of external) {
      if (link.href.startsWith("mailto:"))
        expect(link.href).toBe("mailto:admin@ahousedividedgame.com");
      else expect(allowed.has(new URL(link.href).host)).toBe(true);
    }
  });

  it("claims the pages the fix round names, and the Swift test asserts them", () => {
    const prefixes = (payload: Payload, id: string) =>
      payload.tabs.find((tab) => tab.id === id)?.activePrefixes ?? [];
    expect(prefixes(staff, "state")).toContain("/country/us/region/NY");
    expect(prefixes(staff, "nation")).toContain("/country/us");
    expect(prefixes(staff, "company")).toContain("/corporation/7");
    for (const path of [
      "/country/us/region/NY/legislature",
      "/country/us/budget",
      "/corporation/7/finance",
    ]) {
      expect(swiftTest).toContain(`"${path}"`);
    }
  });

  it("keeps the game's duplicate Notifications row, which the app removes on More", () => {
    const ids = staff.sheets.more.sections.flatMap((section) =>
      section.links.map((link) => link.id),
    );
    expect(ids).toContain("notifications");
    expect(swiftTest).toContain('sections(without: "notifications")');
  });
});

describe("iOS dock preview fixture", () => {
  const source = read("NativeDockLayout.swift");
  const fixture = JSON.parse(
    source
      .slice(source.indexOf('static let json = """') + 21)
      .split('"""')[0] ?? "",
  );

  it("matches the /api/mobile-dock contract", () => {
    expect(fixture.version).toBe(1);
    expect(fixture.tabs.map((tab: { id: string }) => tab.id)).toEqual([
      "company",
      "state",
      "nation",
      "actions",
      "more",
    ]);
    for (const tab of fixture.tabs) {
      expect(Boolean(tab.href) !== Boolean(tab.sheet)).toBe(true);
      if (tab.sheet) expect(fixture.sheets[tab.sheet]).toBeDefined();
      expect(tab.icon.grid.every((row: string) => /^[01]+$/.test(row))).toBe(
        true,
      );
      expect(Array.isArray(tab.activePrefixes)).toBe(true);
    }
    for (const sheet of Object.values(fixture.sheets) as {
      sections: { links: { href: string; external?: boolean }[] }[];
    }[]) {
      for (const section of sheet.sections) {
        for (const link of section.links)
          expect(
            link.external
              ? /^(https:\/\/|mailto:)/.test(link.href)
              : link.href.startsWith("/"),
          ).toBe(true);
      }
    }
  });

  it("uses no em or en dashes in any dock source", () => {
    for (const file of [
      "NativeNav.swift",
      "NativeLoad.swift",
      "NativeDock.swift",
      "NativeDockCore.swift",
      "NativeDockModel.swift",
      "NativeDockView.swift",
      "NativeDockLayout.swift",
      "NativeDockStatus.swift",
    ]) {
      expect(read(file)).not.toMatch(/[–—]/);
    }
  });
});

describe("iOS load feedback contract", () => {
  const load = read("NativeLoad.swift");
  const nav = read("NativeNav.swift");
  const dockFile = read("NativeDock.swift");

  it("wraps wry's navigation delegate and forwards to it", () => {
    expect(load).toContain("final class NativeLoadDelegate: NSObject, WKNavigationDelegate");
    expect(load).toContain("let proxy = NativeLoadDelegate(inner: webview.navigationDelegate)");
    expect(load).toContain("forwardingTarget(for aSelector: Selector!)");
    expect(load).toContain("inner?.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)");
    expect(load).toContain("inner?.webView?(webView, didFinish: navigation)");
    // The proxy observes loads; it must never answer a navigation policy itself.
    expect(load).not.toContain("decidePolicyFor");
  });

  it("ignores cancelled loads and only reports game pages", () => {
    expect(load).toContain("NSURLErrorCancelled");
    expect(load).toContain("NativeNavController.gameHosts.contains");
  });

  it("offers Retry and Back to launcher on the screen", () => {
    expect(load).toContain('"Cannot reach the game"');
    expect(load).toContain('"Retry"');
    expect(load).toContain('"Back to launcher"');
    expect(load).toContain("estimatedProgress");
  });

  it("is installed by the nav host and has an offline preview state", () => {
    expect(nav).toContain("loadView.install(in: host, webView: webView, above: slot.topAnchor)");
    expect(nav).toContain('state == "offline"');
    expect(dockFile).toContain('"offline"');
  });
});

describe("iOS alerts", () => {
  const alerts = read("NativeAlerts.swift");
  const nav = read("NativeNav.swift");
  const push = read("NativePush.swift");
  const view = read("NativeDockView.swift");
  const dock = read("NativeDock.swift");

  it("asks once, after a signed-in status load, never at launch", () => {
    expect(alerts).toContain("Get alerts for votes, offers and attacks?");
    expect(alerts).toContain("!asked && signedIn && statusLoaded && onGamePage");
    expect(alerts).toContain("permission == .notDetermined");
    expect(nav).toContain("offerAlerts(saved)");
    expect(nav).toContain("guard saved != nil, layoutAccount != nil");
    // The system prompt is only reached from the sheet's button, through configure.
    expect(push.match(/requestAuthorization/g)).toHaveLength(1);
    expect(push).toContain("NativeAlerts.shared.setEnabled");
  });

  it("has an Alerts row in More and a preview state for the sheet", () => {
    expect(view).toContain('label: "Alerts"');
    expect(nav).toContain("case .alerts:");
    expect(dock).toContain('"alerts"');
    expect(nav).toContain('state == "alerts"');
  });

  it("badges the icon with unread and clears alerts for the page in view", () => {
    expect(alerts).toContain("setBadgeCount(value)");
    expect(alerts).toContain("applicationIconBadgeNumber");
    expect(nav).toContain("NativeAlerts.shared.updateBadge");
    expect(nav).toContain("NativeAlerts.shared.clearDelivered(viewing: path)");
    expect(push).toContain("[.banner, .sound, .badge]");
  });

  it("registers an alert category with an Open inbox action", () => {
    expect(alerts).toContain('title: "Open inbox"');
    expect(push).toContain("NativeAlerts.shared.registerCategories()");
    expect(push).toContain("NativeAlerts.openInboxAction");
  });

  it("has an opt-in turn reminder, off by default, cancelled on sign-out", () => {
    expect(alerts).toContain("Remind me when a new turn starts");
    expect(alerts).toContain("UNCalendarNotificationTrigger");
    expect(alerts).toContain("static func reminderDate");
    expect(alerts).toContain("guard on, permission == .granted, signedIn");
    expect(alerts).toContain("return \"Turn \\(Int(current) + 1) is in\"");
    expect(alerts).toContain("pendingReminder");
    expect(nav).toContain("NativeAlerts.shared.syncReminder");
    expect(nav).toContain("NativeAlerts.shared.cancelReminder()");
    expect(nav).toContain('state == "reminder"');
    expect(dock).toContain('"reminder"');
  });

  it("keeps UIKit-free policy and no push state in the sheet code", () => {
    expect(alerts).toContain("enum AlertsPolicy");
    expect(alerts).not.toContain("NativePush");
  });
});
