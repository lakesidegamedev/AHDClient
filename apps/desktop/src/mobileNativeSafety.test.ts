import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Windows checkouts can use CRLF; regexes below expect LF.
const read = (relative: string) => readFileSync(join(here, relative), "utf8").replace(/\r\n/g, "\n");

// The Android Ask sheet is split across these sources (2.6.0).
const androidAskSources = ["NativeAsk.kt", "AskApi.kt", "AskSession.kt", "AskSheet.kt"];
const readAndroidAsk = () =>
  androidAskSources
    .map((file) => read(`../src-tauri/plugins/briefing-widgets/android/src/main/java/net/lakesidegames/briefing/${file}`))
    .join("\n");

describe("mobile native companion safety", () => {
  it("insets the Android WebView with margins so fixed bars clear the system bars", () => {
    // Ticket 1462: padding left the site's bottom bar under three-button navigation.
    const activity = read(
      "../src-tauri/gen/android/app/src/main/java/net/lakesidegames/ahdclient/MainActivity.kt",
    );
    expect(activity).toContain("params.setMargins(bars.left, bars.top, bars.right, bottom)");
    expect(activity).toContain("ViewCompat.requestApplyInsets(webView)");
  });

  it("ends the Android WebView above the tab bar, and gives the page the room when the keyboard is up", () => {
    const activity = read(
      "../src-tauri/gen/android/app/src/main/java/net/lakesidegames/ahdclient/MainActivity.kt",
    );
    const nav = read("../src-tauri/gen/android/app/src/main/java/net/lakesidegames/ahdclient/NativeNav.kt");
    // One insets listener places both views, so the bar never covers the
    // game's fixed bottom status bar.
    expect(activity).toMatch(/keyboard -> ime\.bottom\s+tabs > 0 -> tabs\s+else -> bars\.bottom/);
    expect(activity).toContain('CompanionSafety.run("tab bar setup")');
    expect(nav).toContain("val height = (BAR_HEIGHT_DP * activity.resources.displayMetrics.density).toInt() + bottom");
    expect(nav).toContain("return if (keyboard) 0 else height");
    // A bar that never attached must not leave a gap under the page.
    expect(nav).toContain("if (bar.parent == null) return 0");
    expect(nav).toContain("ViewCompat.setOnApplyWindowInsetsListener(bar) { _, insets -> insets }");
  });

  it("gives every old in-game menu item a home in the native tab bar on both phones", () => {
    const nav = read("../src-tauri/gen/android/app/src/main/java/net/lakesidegames/ahdclient/NativeNav.kt");
    const ios = read("../src-tauri/plugins/briefing-widgets/ios/Sources/NativeNav.swift");
    for (const tab of ["Game", "Briefing", "Inbox", "Ask", "More"]) {
      expect(nav).toContain(`"${tab}"`);
      expect(ios).toContain(`return "${tab}"`);
    }
    // Game home, Inbox, Briefing, Ask and Launcher were the menu's five items.
    for (const source of [nav, ios]) {
      expect(source).toContain("/notifications");
      expect(source).toContain("?screen=briefing");
      expect(source).toContain("NativeAskController");
      expect(source).toMatch(/#briefing/);
    }
    // The launcher marks its Briefing screen so the bar can highlight it.
    expect(read("App.tsx")).toContain('const wanted = screen === "briefing" ? "#briefing" : "";');
    expect(nav).toContain('private const val LAUNCHER = "http://tauri.localhost/"');
    expect(ios).toContain('static let launcher = "tauri://localhost/"');
  });

  it("keeps the floating AHD button only as a fallback for a tab bar that did not attach", () => {
    const mobile = read("../src-tauri/src/mobile.rs");
    const mount = mobile.indexOf("function mount()");
    const guard = mobile.indexOf("if (window.__ahdclientNativeTabs) return;");
    const button = mobile.indexOf("createElement('button')");
    expect(mount).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(mount);
    expect(button).toBeGreaterThan(guard);
    const nav = read("../src-tauri/gen/android/app/src/main/java/net/lakesidegames/ahdclient/NativeNav.kt");
    const ios = read("../src-tauri/plugins/briefing-widgets/ios/Sources/NativeNav.swift");
    expect(nav).toContain('val flag = "window.__ahdclientNativeTabs = true;"');
    expect(ios).toContain('let flag = "window.__ahdclientNativeTabs = true;"');
    // Set only after the bar is in the view tree.
    expect(nav.indexOf("content.addView(bar")).toBeLessThan(nav.indexOf("val flag ="));
    expect(ios.indexOf("host.addSubview(bar)")).toBeLessThan(ios.indexOf("let flag ="));
  });

  it("attaches the iOS tab bar from the plugin with iPad keyboard shortcuts", () => {
    const plugin = read("../src-tauri/plugins/briefing-widgets/ios/Sources/BriefingWidgetsPlugin.swift");
    const ios = read("../src-tauri/plugins/briefing-widgets/ios/Sources/NativeNav.swift");
    expect(plugin).toContain("NativeNavController.shared.attach(webview)");
    expect(ios).toContain("webView.bottomAnchor.constraint(equalTo: bar.topAnchor)");
    expect(ios).toContain("bar.bottomAnchor.constraint(equalTo: host.bottomAnchor)");
    expect(ios).toContain("UISelectionFeedbackGenerator");
    for (const input of ['"k"', '"r"', '"["', '"]"']) expect(ios).toContain(`input: ${input}`);
    expect(ios).toContain("input: String(index + 1)");
  });

  it("files each Android alert under its inbox category channel", () => {
    const push = read(
      "../src-tauri/plugins/briefing-widgets/android/src/main/java/net/lakesidegames/briefing/NativePush.kt",
    );
    for (const thread of ["crisis", "election", "legislation", "party", "treasury", "standing", "system"]) {
      expect(push).toContain(`"${thread}" to`);
    }
    expect(push).toContain('val channel = thread?.let { "ahd-$it" } ?: CHANNEL');
  });

  it("keeps optional Android companions outside the app launch failure path", () => {
    const activity = read(
      "../src-tauri/gen/android/app/src/main/java/net/lakesidegames/ahdclient/MainActivity.kt",
    );
    const widget = read(
      "../src-tauri/gen/android/app/src/main/java/net/lakesidegames/ahdclient/BriefingWidget.kt",
    );
    const safety = read(
      "../src-tauri/gen/android/app/src/main/java/net/lakesidegames/ahdclient/CompanionSafety.kt",
    );
    const plugin = read(
      "../src-tauri/plugins/briefing-widgets/android/src/main/java/net/lakesidegames/briefing/BriefingPlugin.kt",
    );
    const nativeSafety = read(
      "../src-tauri/plugins/briefing-widgets/android/src/main/java/net/lakesidegames/briefing/NativeSafety.kt",
    );
    const ask = readAndroidAsk();

    expect(activity).toContain("CompanionSafety.run");
    expect(activity).toContain('CompanionSafety.run("widget deep link")');
    // Only the exact screenshot flag switches the Ask sheet to its canned preview.
    expect(activity).toContain('openAskWhenReady(preview = uri.encodedQuery == "preview=1")');
    expect(widget).toContain("CompanionSafety.run");
    expect(widget).toContain("jobFinished(params, false)");
    expect(safety).toContain("catch (error: Throwable)");
    expect(plugin).toContain("NativeSafety.run");
    expect(nativeSafety).toContain("catch (error: Throwable)");
    expect(ask).toContain('NativeSafety.run("native Ask presentation")');
    expect(ask).toContain('NativeSafety.run("$operation task")');
    expect(ask).toContain('NativeSafety.run("Ask done")'.replace("NativeSafety.run(", "post("));
    expect(ask).toContain("BottomSheetDialog");
    expect(plugin).toContain('NativeSafety.run("push sync")');
    expect(plugin).toContain('NativeSafety.run("push poll")');
  });

  it("never calls a blocking mobile plugin from the UI-thread navigation callbacks", () => {
    const mobile = read("../src-tauri/src/mobile.rs");
    const body = (signature: string) => {
      const start = mobile.indexOf(signature);
      expect(start).toBeGreaterThanOrEqual(0);
      return mobile.slice(start, mobile.indexOf("\n}\n", start));
    };
    // Android runs these on the UI thread; a plugin call there waits on the
    // UI thread itself and freezes the app (ticket 1450).
    for (const callback of [body("fn navigation_policy("), body("fn create_main_window(")]) {
      expect(callback).not.toMatch(/\.opener\(\)|NativeCompanion|run_mobile_plugin/);
    }
    const external = body("fn open_externally(");
    expect(external).toContain("spawn_blocking(move ||");
    expect(external.indexOf("spawn_blocking(")).toBeLessThan(external.indexOf(".opener()"));
  });

  it("keeps wry cookie calls, which abort iOS, behind one native bridge", () => {
    const srcDir = join(here, "../src-tauri/src");
    const offenders = readdirSync(srcDir)
      .filter((file) => file.endsWith(".rs") && file !== "webview_cookies.rs")
      .filter((file) =>
        /\.(cookies_for_url|cookies|delete_cookie|set_cookie)\(/.test(
          read(`../src-tauri/src/${file}`),
        ),
      );
    expect(offenders).toEqual([]);

    const bridge = read("../src-tauri/src/webview_cookies.rs");
    expect(bridge).toContain('#[cfg(target_os = "ios")]');
    expect(bridge).toContain("companion(app).cookies_for_url");

    const plugin = read(
      "../src-tauri/plugins/briefing-widgets/ios/Sources/BriefingWidgetsPlugin.swift",
    );
    expect(plugin).toContain("@objc public func cookies(_ invoke: Invoke)");
    expect(plugin).toContain(
      "@objc public func deleteCookie(_ invoke: Invoke)",
    );
    expect(plugin).toContain("DispatchQueue.main.async");
  });
});
