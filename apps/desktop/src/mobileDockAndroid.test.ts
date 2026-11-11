import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(join(here, relative), "utf8").replace(/\r\n/g, "\n");
const android = (file: string) =>
  read(`../src-tauri/gen/android/app/src/main/java/net/lakesidegames/ahdclient/${file}`);

const resources = "../src-tauri/gen/android/app/src/main/res";
/** An English string from values/strings.xml, by name. */
const string = (name: string) => {
  const match = new RegExp(`<string name="${name}">([^<]*)</string>`).exec(read(`${resources}/values/strings.xml`));
  if (!match) throw new Error(`missing string ${name}`);
  return (match[1] ?? "").replace(/\\'/g, "'");
};

describe("Android language (2.11, A8)", () => {
  it("ships German and offers both languages in Android's per-app language setting", () => {
    expect(read(`${resources}/values-de/strings.xml`)).toContain('name="alerts_ask_title"');
    expect(read(`${resources}/xml/locales_config.xml`)).toMatch(/<locale android:name="en" \/>[\s\S]*<locale android:name="de" \/>/);
    expect(read("../src-tauri/gen/android/app/src/main/AndroidManifest.xml")).toContain('android:localeConfig="@xml/locales_config"');
    expect(read("../src-tauri/plugins/briefing-widgets/android/src/main/res/values-de/ask_strings.xml")).toContain('name="ask_consent_title"');
  });

  it("follows the game's language cookie, not only the phone's", () => {
    expect(android("Texts.kt")).toContain("fun syncFromCookie()");
    expect(android("NativeNav.kt")).toContain("Texts.use(cookieLocale)");
  });
});

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
    expect(nav).toContain("var dock = NativeDock(activity, this)");
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
    expect(model).toContain('DockTab("app-game", Texts.s(R.string.dock_game)');
    expect(model).toContain('DockTab("app-briefing", Texts.s(R.string.dock_briefing)');
    expect(model).toContain('DockTab("app-ask", Texts.s(R.string.dock_ask)');
    expect(model).toContain('DockTab("app-more", Texts.s(R.string.dock_more)');
    expect(string("dock_game")).toBe("Game");
    expect(string("dock_more")).toBe("More");
    // The app section comes first in More: Briefing, Inbox, Alerts, Ask, Back to launcher.
    const section = model.indexOf("fun appSection");
    const order = ["dock_briefing", "dock_inbox", "dock_alerts", "dock_ask", "dock_launcher"].map((name) => `R.string.${name}`).map((entry) => model.indexOf(entry, section));
    expect(["Briefing", "Inbox", "Alerts", "Ask", "Back to launcher"]).toEqual(
      ["dock_briefing", "dock_inbox", "dock_alerts", "dock_ask", "dock_launcher"].map(string));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(model).toContain("val sections = listOf(appSection(signedIn, update)) + game");
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
    expect(nav).toContain("DockModel.fallback(live, update)");
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
    expect(dock).toContain('R.string.dock_tab_unread');
    expect(dock).toContain("info.roleDescription = Texts.s(R.string.dock_tab_role)");
    expect(dock).toContain("Texts.s(R.string.dock_status_prefix");
    expect(dock).toContain("R.string.dock_show_status");
    expect(string("dock_show_status")).toBe("Show status details");
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

  it("asks about alerts once, after the first signed-in status load, with the iPhone copy", () => {
    const policy = read("../src-tauri/gen/android/app/src/main/java/net/lakesidegames/ahdclient/AlertsPolicy.kt");
    const nav = read("../src-tauri/gen/android/app/src/main/java/net/lakesidegames/ahdclient/NativeNav.kt");
    expect(policy).toContain("R.string.alerts_ask_title");
    expect(string("alerts_ask_title")).toBe("Get alerts for votes, offers and attacks?");
    expect(string("alerts_ask_body")).toContain("You can change this any time under More, Alerts.");
    expect(nav).toContain("NativeAlerts.askOnce(activity, signedIn = true, statusLoaded = true, onGamePage = true)");
    expect(nav).toContain("AppAction.ALERTS -> NativeAlerts.showManager(activity)");
  });

  it("has an opt-in turn reminder: inexact alarm, own channel, off by default, in the Alerts sheet", () => {
    const dir = "../src-tauri/gen/android/app/src/main/java/net/lakesidegames/ahdclient";
    const reminder = read(`${dir}/TurnReminder.kt`);
    const alerts = read(`${dir}/NativeAlerts.kt`);
    expect(reminder).toContain('const val CHANNEL = "ahd-turn"');
    expect(reminder).toContain('getBoolean(ON, false)');
    expect(reminder).toContain("alarms.set(AlarmManager.RTC_WAKEUP");
    expect(reminder).not.toContain("setExact");
    expect(read("../src-tauri/gen/android/app/src/main/AndroidManifest.xml")).not.toContain("SCHEDULE_EXACT_ALARM");
    expect(read("../src-tauri/gen/android/app/src/main/AndroidManifest.xml")).toContain(".TurnReminderReceiver");
    expect(alerts).toContain("R.string.alerts_turn_reminder");
    expect(nav).toContain("NativeAlerts.syncReminder(");
    expect(string("alerts_turn_reminder")).toBe("Remind me when a new turn starts");
    expect(string("turn_reminder_title")).toBe("Turn %1$d is in");
    expect(read("../src-tauri/gen/android/app/src/main/res/values-de/strings.xml")).toContain('name="turn_reminder_title"');
  });

  it("offers a canned preview link for screenshots, in debug and CI builds only", () => {
    expect(activity).toContain('uri.host == "dock"');
    expect(activity).toContain('setOf("collapsed", "expanded", "state", "more", "signedout", "launcher", "alerts", "reminder", "off")');
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
    expect(nav).toContain("else -> DockModel.safePath(link.href)?.let { loadTopLevel(site + it) }");
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

describe("Android loading bar and cannot-reach screen", () => {
  const chrome = android("LoadChrome.kt");
  const rules = android("LoadRules.kt");
  const nav = android("NativeNav.kt");
  const activity = android("MainActivity.kt");

  it("wraps the client the WebView has and forwards all five wry overrides to it first", () => {
    expect(nav).toContain("WebViewCompat.getWebViewClient(webView)");
    expect(nav).toContain("WebViewFeature.GET_WEB_VIEW_CLIENT");
    expect(nav).toContain("webView.setWebViewClient(LoadWatchingClient(current, chrome))");
    expect(chrome).toContain("return inner.shouldInterceptRequest(view, request)");
    expect(chrome).toContain("inner.shouldOverrideUrlLoading(view, request)");
    expect(chrome).toContain("inner.onPageStarted(view, url, favicon)");
    expect(chrome).toContain("inner.onPageFinished(view, url)");
    expect(chrome).toContain("inner.onReceivedError(view, request, error)");
    // The inner client runs before the screen decides anything, and the app replaces neither client.
    expect(chrome.indexOf("inner.onReceivedError")).toBeLessThan(chrome.indexOf("LoadRules.showsError"));
    expect(activity).not.toContain("setWebChromeClient");
    expect(nav).not.toContain("setWebChromeClient");
  });

  it("keeps the dock's page tracking and Back history rules intact", () => {
    expect(nav).toContain("private fun loadTopLevel(url: String)");
    expect(nav).toContain("webView.clearHistory()");
    expect(nav).toContain("fun rebuildDock()");
    // The screen is a native view, never a page in the WebView, so it adds no history entry and no game URL.
    expect(chrome).not.toContain("loadDataWithBaseURL");
  });

  it("uses the same words as the iPhone screen", () => {
    expect(rules).toContain("TITLE = R.string.load_title");
    expect(string("load_title")).toBe("Cannot reach the game");
    expect(string("load_detail")).toBe("Check your connection and try again.");
    expect(string("load_retry")).toBe("Retry");
    expect(string("load_back")).toBe("Back to launcher");
  });

  it("draws a 2 dp bar just above the dock and sits under it", () => {
    expect(chrome).toContain("(2 * density).toInt()");
    expect(nav.indexOf("content.addView(chrome")).toBeLessThan(nav.indexOf("content.addView(dock"));
    expect(chrome).toContain("source.bottomMargin");
  });
});

describe("Android game links and shortcuts (2.11, A7)", () => {
  const manifest = read("../src-tauri/gen/android/app/src/main/AndroidManifest.xml");
  const filters = manifest.split("<intent-filter").slice(1).map((f) => f.split("</intent-filter>")[0] ?? "");
  const links = filters.find((f) => f.includes('android:pathPrefix="/elections"')) ?? "";

  it("claims only game page sections as verified links, never sign-in or the API", () => {
    expect(links).toContain('android:autoVerify="true"');
    expect(links).toContain('android:host="ahousedividedgame.com"');
    expect(links).not.toContain("sandbox.");
    const prefixes = [...links.matchAll(/android:pathPrefix="([^"]+)"/g)].map((m) => m[1]);
    expect(prefixes.length).toBeGreaterThan(5);
    for (const bad of ["/api", "/login", "/auth", "/register", "/logout", "/"]) expect(prefixes).not.toContain(bad);
    const kotlin = android("AppLinks.kt");
    for (const prefix of prefixes) expect(kotlin).toContain(`"${(prefix ?? "").slice(1)}"`);
  });

  it("sends a linked page through the existing loader and keeps signed-out players on the launcher", () => {
    const main = android("MainActivity.kt");
    expect(main).toContain("AppLinks.pathFor(");
    expect(main).toContain("BriefingWidgets.identity() == null");
  });

  it("has Inbox and Ask shortcuts with their own icons and German labels", () => {
    const shortcuts = read(`${resources}/xml/briefing_shortcuts.xml`);
    expect(shortcuts).toContain('android:icon="@drawable/ic_shortcut_inbox"');
    expect(shortcuts).toContain('android:icon="@drawable/ic_shortcut_ask"');
    expect(shortcuts).toContain("ahdclient://inbox");
    expect(shortcuts).toContain("ahdclient://ask");
    expect(read(`${resources}/values-de/strings.xml`)).toContain('name="shortcut_inbox"');
  });
});
