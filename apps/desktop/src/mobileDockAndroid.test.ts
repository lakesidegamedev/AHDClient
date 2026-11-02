import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(join(here, relative), "utf8").replace(/\r\n/g, "\n");
const android = (file: string) =>
  read(`../src-tauri/gen/android/app/src/main/java/net/lakesidegames/ahdclient/${file}`);

describe("Android mobile dock (2.10.0)", () => {
  const activity = android("MainActivity.kt");
  const nav = android("NativeNav.kt");
  const dock = android("NativeDock.kt");
  const model = android("DockModel.kt");
  const store = android("DockModelStore.kt");

  it("replaces the stock Material tab bar with the custom dock", () => {
    expect(nav).not.toContain("BottomNavigationView");
    expect(dock).not.toContain("BottomNavigationView");
    expect(nav).toContain("val dock = NativeDock(activity, this)");
  });

  it("marks only the mobile WebView with the native status user agent, after the dock exists", () => {
    expect(activity).toContain('" AHDClientNativeStatus/1"');
    const built = activity.indexOf("nav = NativeNav(this, webView)");
    expect(built).toBeGreaterThan(0);
    expect(activity.indexOf("AHDClientNativeStatus/1")).toBeGreaterThan(built);
    // Desktop code never carries the marker.
    for (const file of ["desktop.rs", "lib.rs"]) {
      expect(read(`../src-tauri/src/${file}`)).not.toContain("AHDClientNativeStatus");
    }
  });

  it("draws the game's own tabs from /api/mobile-dock and falls back to Game, Briefing, Ask, More", () => {
    expect(store).toContain("/api/mobile-dock");
    expect(model).toContain("if (raw == null || raw.optInt(\"version\", -1) != 1) return null");
    expect(model).toContain('DockTab("app-game", "Game"');
    expect(model).toContain('DockTab("app-briefing", "Briefing"');
    expect(model).toContain('DockTab("app-ask", "Ask"');
    expect(model).toContain('DockTab("app-more", "More"');
    // The app section comes first in More: Briefing, Inbox, Ask, Back to launcher.
    const section = model.indexOf("fun appSection");
    const order = ['"Briefing"', '"Inbox"', '"Ask"', '"Back to launcher"'].map((entry) => model.indexOf(entry, section));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(model).toContain("listOf(appSection(signedIn)) + (existing?.sections ?: emptyList())");
    expect(nav).toContain("NativeAskController.present()");
    expect(nav).toContain("dock.setInboxBadge(");
    expect(dock).toContain('"99+"');
    // Pixel icons are drawn as squares, never through a vector or an image fetch.
    expect(dock).toContain("PixelIconView(context)");
    expect(android("PixelIconView.kt")).toContain("canvas.drawRect(");
  });

  it("checks everything the game sends and caches it per account", () => {
    expect(model).toContain("path.startsWith(\"/\") && !path.startsWith(\"//\")");
    expect(model).toContain("private const val MAX_TABS = 6");
    expect(store).toContain("active.instanceFollowRedirects = false");
    expect(store).toContain('active.setRequestProperty("Cookie", cookie)');
    expect(store).toContain("MAX_BYTES");
    expect(store).toContain('stored.optString("identity") != identity');
    // A 401 or a missing endpoint drops the cache; offline keeps it.
    expect(store).toContain("status == 401 || status == 403");
    expect(store).toContain("Outcome.FAILED");
    expect(nav).toContain("DockModelStore.refresh(context)");
    expect(nav).toContain("DockModel.fallback(signedIn)");
  });

  it("refreshes status on foreground, tab return, finished turns and a timer that never beats a minute", () => {
    expect(nav).toContain("STATUS_GAP_MS = 60_000L");
    expect(nav).toContain("dock foreground refresh");
    expect(nav).toContain("val returned = now == Page.SITE && page != null && page != Page.SITE");
    expect(nav).toContain("dock section refresh");
    expect(nav).toContain("dock account refresh");
    expect(nav).toContain("ahd:turn-complete");
    expect(nav).toContain("WebViewFeature.WEB_MESSAGE_LISTENER");
    // A message listener limited to the game's https pages, not a JavaScript interface.
    expect(nav).toContain("addWebMessageListener(webView, \"ahdDock\", origins)");
    expect(nav).not.toContain("addJavascriptInterface");
    // Network work stays off the UI thread.
    expect(nav).toMatch(/Thread \{\s+var outcome[^\n]*\n\s+try \{\s+BriefingWidgets\.refresh\(context\)\s+outcome = DockModelStore\.refresh\(context\)/);
  });

  it("honors reduce motion and keeps 48dp touch targets", () => {
    expect(dock).toContain("Settings.Global.ANIMATOR_DURATION_SCALE");
    expect(dock).toContain("private const val TAB_HEIGHT_DP = 56");
    expect(dock).toContain("private const val STRIP_HEIGHT_DP = 48");
    expect(dock).toContain("minimumWidth = dp(48)");
    expect(dock).toContain("SpringAnimation");
  });

  it("gives screen readers labels for tabs, the badge count and the status values", () => {
    expect(dock).toContain('"${tab.label}, $count unread"');
    expect(dock).toContain('info.roleDescription = "Tab"');
    expect(dock).toContain('val description = "Status. "');
    expect(dock).toContain('"Show status details"');
  });

  it("closes the sheet on Android back before anything else", () => {
    expect(activity).toContain("OnBackPressedCallback(false)");
    expect(activity).toContain("onBackPressedDispatcher.addCallback(this, it)");
    expect(activity).toContain("fun onDockExpanded(expanded: Boolean)");
  });

  it("offers a canned preview link for screenshots", () => {
    expect(activity).toContain('uri.host == "dock"');
    expect(activity).toContain('setOf("collapsed", "expanded", "state", "more", "signedout", "off")');
    expect(nav).toContain("fun preview(mode: String)");
  });
});
