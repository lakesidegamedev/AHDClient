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
  const routing = android("DockRouting.kt");

  it("replaces the stock Material tab bar with the custom dock", () => {
    expect(nav).not.toContain("BottomNavigationView");
    expect(dock).not.toContain("BottomNavigationView");
    expect(nav).toContain("val dock = NativeDock(activity, this)");
  });

  it("marks only the mobile WebView with the native status user agent, once the dock is on screen, then reloads the page once", () => {
    // MainActivity no longer sets the marker; NativeNav.attach does, after content.addView(dock) succeeded.
    expect(activity).not.toContain("AHDClientNativeStatus/1");
    expect(nav).toContain('const val NATIVE_MARKER = "AHDClientNativeStatus/1"');
    const added = nav.indexOf("content.addView(dock");
    const marked = nav.indexOf("markUserAgent() }");
    expect(added).toBeGreaterThan(0);
    expect(marked).toBeGreaterThan(added);
    // attach returns before anything is marked when there is no content view to host the dock.
    expect(nav.indexOf("?: return")).toBeLessThan(added);
    expect(nav).toContain('settings.userAgentString = "$agent $NATIVE_MARKER"');
    expect(nav).toContain("if (pageOf(webView.url) == Page.SITE) webView.reload()");
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
    expect(model).toContain("val sections = listOf(appSection(signedIn)) + game");
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
    // Ids are view keys: any short string without control characters, labels up to 80, 16 sections counted after filtering.
    expect(model).toContain("it.length <= MAX_ID && it.none { c -> c.isISOControl() }");
    expect(model).toContain("private const val MAX_LABEL = 80");
    expect(model).toContain("private const val MAX_SECTIONS = 16");
    expect(model).toContain("if (sections.size >= MAX_SECTIONS) break");
    expect(store).toContain("active.instanceFollowRedirects = false");
    expect(store).toContain('active.setRequestProperty("Cookie", cookie)');
    expect(store).toContain("MAX_BYTES");
    expect(store).toContain('takeIf { it.optString("identity") == identity }');
    // A 401 or a missing endpoint drops the cache; offline keeps it.
    expect(store).toContain("status == 401 || status == 403");
    expect(store).toContain("Outcome.FAILED");
    expect(nav).toContain("DockModelStore.refresh(context, key)");
    expect(nav).toContain("DockModel.fallback(live)");
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
    expect(nav).toMatch(/Thread \{\s+var fetched[^\n]*\n[^\n]*\n\s+try \{\s+if \(statusDue\) BriefingWidgets\.refresh\(context\)\s+fetched = DockModelStore\.refresh\(context, key\)/);
  });

  it("honors reduce motion and keeps 48dp touch targets", () => {
    expect(dock).toContain("Settings.Global.ANIMATOR_DURATION_SCALE");
    expect(dock).toContain("private const val TAB_HEIGHT_DP = 56");
    expect(dock).toContain("private const val STRIP_HEIGHT_DP = 48");
    expect(dock).toContain("minimumWidth = dp(48)");
    expect(dock).toContain("SpringAnimation");
  });

  it("gives screen readers labels for tabs, the badge count and the status values", () => {
    expect(dock).toContain('"${tab.fullLabel}, $count unread"');
    expect(dock).toContain('info.roleDescription = "Tab"');
    expect(dock).toContain('val description = "Status. "');
    expect(dock).toContain('"Show status details"');
  });

  it("closes the sheet on Android back before anything else", () => {
    expect(activity).toContain("OnBackPressedCallback(false)");
    expect(activity).toContain("onBackPressedDispatcher.addCallback(this, it)");
    expect(activity).toContain("fun onDockExpanded(expanded: Boolean)");
  });

  it("keeps dock tabs top level: history clears once the awaited page shows, and predictive back is on", () => {
    expect(nav).toContain("loadTopLevel(");
    expect(nav).toContain("clearHistoryWhenReached(url)");
    expect(nav).toContain("webView.clearHistory()");
    expect(nav).toContain("DockRouting.reachedTopLevel(target, url)");
    expect(read("../src-tauri/gen/android/app/src/main/AndroidManifest.xml")).toContain(
      'android:enableOnBackInvokedCallback="true"',
    );
  });

  it("offers a canned preview link for screenshots, in debug and CI builds only", () => {
    expect(activity).toContain('uri.host == "dock"');
    expect(activity).toContain('setOf("collapsed", "expanded", "state", "more", "signedout", "launcher", "off")');
    expect(nav).toContain("fun preview(mode: String)");
    // A store build ignores the link: no page, message or app can fake a player's dock.
    expect(activity).toContain("if (!(BuildConfig.DEBUG || BuildConfig.DOCK_PREVIEW)) return");
    const gate = activity.indexOf("BuildConfig.DOCK_PREVIEW");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(activity.indexOf("pendingDockPreview = uri"));
    const gradle = read("../src-tauri/gen/android/app/build.gradle.kts");
    expect(gradle).toContain('buildConfigField("boolean", "DOCK_PREVIEW", dockPreview.toString())');
    // The flag needs the CI env var and the absence of release signing, so a signed build never carries it.
    expect(gradle).toContain('System.getenv("AHD_DOCK_PREVIEW") == "1" && !keystorePropertiesFile.exists()');
    const workflow = read("../../../.github/workflows/release-mobile.yml");
    expect(workflow).toContain("AHD_DOCK_PREVIEW: ${{ github.event_name == 'pull_request' && '1' || '' }}");
  });

  it("keeps the strip off the launcher, Briefing, sign-in pages and the sandbox, in the preview too", () => {
    expect(routing).toContain("onGamePage && signedIn && !authPage && !sandbox");
    expect(nav).toContain("DockRouting.stripAllowed(page == Page.SITE, signedIn, authPage, sandbox)");
    expect(nav).toContain('onGamePage = mode != "launcher"');
  });

  it("draws the status strip as one line: clock, funds, actions and a chevron", () => {
    for (const icon of ["CLOCK_ICON", "FUNDS_ICON", "ACTIONS_ICON", "CHEVRON_ICON"]) expect(dock).toContain(`DockModel.${icon}`);
    expect(dock).toContain("DockFormat.clock(remaining, current.turnActive)");
    expect(dock).toContain('it.value.replace(" / ", "/")');
    expect(dock).toContain("chevron.rotation = value * 180f");
    // No second row any more.
    expect(dock).not.toContain("flowed");
  });

  it("sends the session and the game's language cookie, and caches per account, language and country", () => {
    expect(store).toContain('"$session; ${DockRouting.LOCALE_COOKIE}=${key.locale}"');
    expect(store).toContain("CookieManager.getInstance().getCookie(BriefingWidgets.ORIGIN)");
    expect(store).toContain('"?country=$it"');
    expect(store).toContain("MAX_ENTRIES");
    expect(routing).toContain('const val LOCALE_COOKIE = "ahd-locale"');
    expect(nav).toContain("DockModelStore.locale()");
    expect(nav).toContain("DockKey(it, locale, country)");
  });

  it("follows the page for Nation, drops to the fallback on sign-in pages, sign-out and the sandbox", () => {
    expect(nav).toContain("DockRouting.countryOf(path)");
    expect(nav).toContain("DockRouting.isAuthPath(path)");
    expect(nav).toContain('if (authChanged && nextAuth) dropAccountModels()');
    expect(nav).toContain("uri?.host == SANDBOX_HOST");
    expect(nav).toContain("private fun accountLive() = identity != null && !authPage && !sandbox");
    expect(nav).toContain("if (previewing || sandbox || authPage) return");
    // The account check runs on every follow tick (cookies only), not every twentieth.
    expect(nav).toMatch(/checkAccount\(\)\n\s+followPage\(\)/);
    expect(nav).not.toContain("ticks % 20 == 0) checkAccount()");
  });

  it("reads disk only on worker threads and keeps the figures in memory", () => {
    expect(nav).not.toContain("BriefingWidgets.snapshot(activity)");
    expect(nav).not.toContain("BriefingWidgets.inbox(activity)");
    expect(nav).toContain("private fun readSnapshot(context: android.content.Context)");
    expect(nav).toMatch(/Thread \{\s+val saved = DockModelStore\.cachedAll\(context, forIdentity\)/);
    expect(nav).toContain("private val models = HashMap<String, DockModel>()");
    expect(nav).toContain("dock.setStatus(if (signedIn) statusNow else null)");
  });

  it("opens outside links outside the game WebView and never loads them in it", () => {
    expect(nav).toContain("link.external -> openExternal(link.href)");
    expect(nav).toContain("val safe = DockModel.safeExternal(href) ?: return");
    expect(nav).toContain("Intent.ACTION_SENDTO");
    expect(nav).toContain("Intent.ACTION_VIEW");
    // The WebView loads game paths only.
    expect(nav).toContain("else -> DockModel.safePath(link.href)?.let { webView.loadUrl(site + it) }");
    for (const host of ["wiki.ahousedividedgame.com", "discord.gg", "www.patreon.com", "lakesidegames.net", "docs.lakesidegames.net"]) {
      expect(model).toContain(`"${host}"`);
    }
    expect(model).toContain('const val SUPPORT_MAILTO = "mailto:admin@ahousedividedgame.com"');
  });

  it("makes an open sheet modal for TalkBack and keeps one icon column in every menu row", () => {
    expect(nav).toContain("View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS else View.IMPORTANT_FOR_ACCESSIBILITY_AUTO");
    expect(dock).toContain("if (value) post { sheet.focusForAccessibility() }");
    expect(dock).toContain("AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS");
    expect(dock).toContain("View.INVISIBLE else View.GONE");
    expect(dock).toContain("reserveIcon = true");
    expect(dock).not.toContain("indent = anyIcon");
  });
});
