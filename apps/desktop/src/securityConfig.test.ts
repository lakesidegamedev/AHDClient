import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tauriConfig from "../src-tauri/tauri.conf.json";
import desktopPackage from "../package.json";
import rootPackage from "../../../package.json";
import defaultCapability from "../src-tauri/capabilities/default.json";
import onlineCapability from "../src-tauri/capabilities/online.json";
import gameCapability from "../src-tauri/capabilities/game.json";
import askCapability from "../src-tauri/capabilities/ask.json";
import askAuthCapability from "../src-tauri/capabilities/ask-auth.json";
import mobileCapability from "../src-tauri/capabilities/mobile.json";
import briefingCapability from "../src-tauri/capabilities/briefing.json";
import androidConfig from "../src-tauri/tauri.android.conf.json";
import iosConfig from "../src-tauri/tauri.ios.conf.json";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(join(here, relative), "utf8").replace(/\r\n/g, "\n");
// The iOS Ask sheet spans several NativeAsk*.swift files (API, model, views).
const iosAskSources = "../src-tauri/plugins/briefing-widgets/ios/Sources";
const readIosAsk = () =>
  readdirSync(join(here, iosAskSources))
    .filter((name) => /^NativeAsk.*\.swift$/.test(name))
    .sort()
    .map((name) => read(`${iosAskSources}/${name}`))
    .join("\n");

// The Android Ask sheet is split across these sources (2.6.0).
const androidAskSources = ["NativeAsk.kt", "AskApi.kt", "AskSession.kt", "AskSheet.kt"];
const readAndroidAsk = () =>
  androidAskSources
    .map((file) => read(`../src-tauri/plugins/briefing-widgets/android/src/main/java/net/lakesidegames/briefing/${file}`))
    .join("\n");

describe("desktop security configuration", () => {
  it("limits PiP to the local briefing and its read-only commands", () => {
    expect(briefingCapability.webviews).toEqual(["briefing"]);
    expect("remote" in briefingCapability).toBe(false);
    expect([...briefingCapability.permissions].sort()).toEqual([
      "core:default", "allow-get-briefing", "allow-open-briefing-page", "allow-open-game-page", "allow-set-briefing-pinned",
    ].sort());
    expect(read("../src-tauri/src/briefing.rs")).toContain(".redirects(0)");
  });
  it("keeps native dialogs out of desktop and remote webview capabilities", () => {
    expect(read("../src-tauri/src/desktop.rs")).not.toContain("tauri_plugin_dialog::init()");
    expect(defaultCapability.permissions).not.toEqual(
      expect.arrayContaining(["dialog:default", "dialog:allow-open", "dialog:allow-save"]),
    );
    expect(onlineCapability.permissions).toEqual([]);
    expect(gameCapability.permissions).toEqual([]);
    const entrypoint = read("../src-tauri/src/lib.rs");
    expect(entrypoint).toContain("#[cfg(mobile)]\n  let builder = mobile::configure(builder);");
    expect(read("../src-tauri/Cargo.toml")).toMatch(
      /target\.'cfg\(not\(any\(target_os = \"android\", target_os = \"ios\"\)\)\)'\.dependencies\][\s\S]*?tauri-plugin-dialog = \"2\"/,
    );
  });

  it("ships a local-only CSP for the launcher window", () => {
    expect(tauriConfig.app.security.csp).toEqual({
      "default-src": "'self'",
      "connect-src": "ipc: http://ipc.localhost",
      // Player pictures come from the game account API on exactly the hosts
      // the native briefing path trusts. No other remote images are allowed.
      "img-src": "'self' asset: http://asset.localhost data: https://ahousedividedgame.com https://*.ahousedividedgame.com https://cdn.discordapp.com https://*.public.blob.vercel-storage.com",
      "style-src": "'self' 'unsafe-inline'",
    });
  });

  it("keeps both remote-content windows capability-empty", () => {
    expect(defaultCapability.webviews).toEqual(["main"]);
    expect("windows" in defaultCapability).toBe(false);
    expect(onlineCapability.webviews).toEqual(["online", "online-embedded"]);
    expect(onlineCapability.permissions).toEqual([]);
    expect(gameCapability.webviews).toEqual(["game", "game-embedded"]);
    expect(gameCapability.permissions).toEqual([]);
    expect(askAuthCapability.webviews).toEqual(["ask-auth"]);
    expect(askAuthCapability.permissions).toEqual([]);
    for (const capability of [
      defaultCapability,
      onlineCapability,
      gameCapability,
      askAuthCapability,
    ]) {
      expect("remote" in capability).toBe(false);
    }
  });

  it("limits the native Ask panel to its backend commands", () => {
    expect(askCapability.webviews).toEqual(["ask"]);
    expect("remote" in askCapability).toBe(false);
    expect([...askCapability.permissions].sort()).toEqual([
      "core:default", "allow-ask-api", "allow-ask-send", "allow-ask-stop",
    ].sort());
  });

  it("opens the native Ask panel from the launcher", () => {
    const identifiers = (defaultCapability.permissions as Array<string>).filter(
      (permission) => typeof permission === "string",
    );
    expect(identifiers).toContain("allow-open-ask-window");
    const ask = read("../src-tauri/src/ask.rs");
    expect(ask).toMatch(/async fn open_ask_window/);
    // Resuming focuses the existing panel without re-navigating, so history
    // and an in-flight answer survive closing and reopening.
    expect(ask).toMatch(
      /fn focus_ask_ui[\s\S]*?get_webview_window\("ask"\)[\s\S]*?set_focus\(\)/,
    );
    // The panel is local UI now; only the transient sign-in window loads the
    // Ask origin, under the same navigation guard as before.
    expect(ask).toMatch(/WebviewUrl::App\("index.html\?view=ask"/);
    expect(ask).toMatch(/fn open_ask_auth[\s\S]*?WebviewUrl::External/);
    expect(ask).toMatch(/auth\/login\?next=/);
    expect(ask).toMatch(/__Host-ask_session/);
    expect(ask).toMatch(/focus_ask_ui\(&app\)\?;/);
    expect(ask).toMatch(/fn ask_api_allowed/);
    expect(read("../src-tauri/src/mobile.rs")).toMatch(
      /fn open_ask_window[\s\S]*?navigate_main\(&app, url\)/,
    );
    expect(read("../src-tauri/src/mobile.rs")).toMatch(
      /async fn present_native_ask[\s\S]*?\.show_ask\(\)/,
    );
    expect(read("../src-tauri/src/mobile.rs")).toMatch(
      /is_ask_navigation_allowed\(url\)[\s\S]*?present_native_ask\(app\)/,
    );
    expect(read("../src-tauri/plugins/briefing-widgets/src/lib.rs")).toContain(
      'run_mobile_plugin("showAsk"',
    );
    expect(
      readIosAsk(),
    ).toContain("UIHostingController");
    expect(
      readAndroidAsk(),
    ).toContain("class AskSheet(");
    expect(read("../src-tauri/build.rs")).toContain("\"open_ask_window\"");
    expect(read("../src-tauri/build.rs")).toContain("\"ask_send\"");
    expect(read("../src-tauri/src/lib.rs")).toContain("https://ask.lakesidegames.net/");
    expect(read("../src-tauri/src/lib.rs")).toContain('"auth.lakesidegames.net"');
    const iosAsk = readIosAsk();
    expect(iosAsk).toContain('"auth.lakesidegames.net"');
    expect(iosAsk).toContain('"https://auth.ahousedividedgame.com/auth/ahd?return=');
    expect(iosAsk).toContain("%2Fauth%2Fnative%2Fcallback");
    expect(iosAsk).toContain('request("/api/ask/context"');
    expect(iosAsk).toContain("gameContext: evidence.text");
    const androidAsk = readAndroidAsk();
    expect(androidAsk).toContain('"auth.lakesidegames.net"');
    expect(androidAsk).toContain("NATIVE_AHD_LOGIN");
    expect(androidAsk).toContain("%2Fauth%2Fnative%2Fcallback");
  });

  it("keeps multiplayer navigation ahead of Ask interception and the sandbox out of the phone app", () => {
    const mobile = read("../src-tauri/src/mobile.rs");
    const classifier = mobile.match(/fn classify_navigation\([\s\S]*?\n}\n/)?.[0] ?? "";
    expect(classifier).not.toBe("");
    expect(classifier.indexOf("if is_app_navigation_allowed")).toBeLessThan(
      classifier.indexOf("if is_native_ask_request"),
    );
    expect(mobile).toContain("|| is_ask_navigation_allowed(url)");
    expect(mobile).toContain("ahdclient://ask");
    expect(mobile).toContain("https://ahousedividedgame.com/");
    // The sandbox is a supporter perk bought outside the App Store, so the
    // iPhone app neither offers it nor keeps it in the webview (3.1.1).
    // Android ships outside Google Play and keeps it for linked supporters,
    // still with no purchase link.
    expect(mobile).not.toContain("action('Sandbox'");
    expect(mobile).toContain('const SANDBOX_IN_APP: bool = cfg!(target_os = "android");');
    expect(mobile).toContain("(SANDBOX_IN_APP || url.host_str() != Some(SANDBOX_HOST))");
    expect(mobile).toContain('Some("sandbox") if SANDBOX_IN_APP => {');
    expect(mobile).toContain("account.linked && account.supporter");
    expect(mobile).toContain('Some("sandbox") => return Err(');
    expect(mobile).not.toContain("patreon.com");
    const app = read("./App.tsx");
    expect(app).toContain('sandboxAvailable={platform !== "ios"}');
  });

  it("lets iOS swipe back and keeps the AHD button off the game's bottom bar", () => {
    const mobile = read("../src-tauri/src/mobile.rs");
    expect(mobile).toContain("setAllowsBackForwardNavigationGestures: true");
    expect(mobile).toContain("function lift()");
    expect(mobile).toContain("document.elementsFromPoint(32, window.innerHeight - 24)");
    const settings = read("./settings.css");
    expect(settings).toMatch(/@media \(max-width: 600px\)[\s\S]*\.client-account-menu > div \{ left: 0; right: auto;/);
  });

  it("keeps native Ask sign-in transactions intact and AFM on device", () => {
    const iosAsk = readIosAsk();
    const iosFoundationModels = read("../src-tauri/plugins/briefing-widgets/ios/Sources/FoundationModelBridge.swift");
    const androidAsk = readAndroidAsk();
    expect(iosAsk).toContain("__Host-ask_login");
    expect(iosAsk).toContain("brokerCookie");
    expect(iosAsk).toContain("liveSources");
    expect(androidAsk).toContain("__Host-ask_login");
    expect(androidAsk).toContain("merge(auth, game, sandbox, wwwGame)");
    expect(androidAsk).toContain("text/event-stream");
    // The on-device path never runs a server Ask generation: that took
    // minutes, spent quota, and could not finish inside the AFM timeout.
    expect(iosFoundationModels).not.toContain("NativeAskLiveTool");
    expect(iosFoundationModels).not.toContain("LanguageModelSession(tools:");
    expect(iosFoundationModels).not.toContain("api.ask(");
  });

  it("forwards an existing unified session to Ask without sending it to the game broker", () => {
    const iosAsk = readIosAsk();
    const androidAsk = readAndroidAsk();
    expect(iosAsk).toContain("unifiedSessionCookie");
    expect(iosAsk).toContain("Cookie");
    expect(androidAsk).toContain("merge(ask, unifiedAuth, includeUnified = true)");
    expect(androidAsk).toContain("name == \"__Host-lakeside_session\"");
  });

  it("forwards every accepted game session to the iOS Ask broker", () => {
    const iosAsk = readIosAsk();
    const gameSessionHelper = iosAsk.match(
      /private static func isGameAuthCookie\([\s\S]*?\n  }/,
    )?.[0] ?? "";
    expect(gameSessionHelper).toMatch(/authjs|next-auth/);
    expect(iosAsk).toContain("gameAuthCookieHeader");
    expect(iosAsk).toMatch(
      /setValue\(gameAuthCookieHeader, forHTTPHeaderField: "Cookie"\)/,
    );
  });

  it("keeps AFM usable without live auth and shows generation failures", () => {
    const iosAsk = readIosAsk();
    const iosFoundationModels = read("../src-tauri/plugins/briefing-widgets/ios/Sources/FoundationModelBridge.swift");
    expect(iosAsk).toContain("if signedIn, let api");
    expect(iosAsk).toContain("without the game guides");
    expect(iosAsk).toContain("NativeAskErrorCard(message: message");
    expect(iosAsk).toContain("FoundationModelBridgeError.empty");
    expect(iosFoundationModels).toContain("NativeAskToolProtocolSanitizer");
    expect(iosFoundationModels).toContain("Never output JSON, XML, or tool-call syntax");
    expect(iosFoundationModels).toContain("Answer in ordinary sentences only.");
  });

  it("bounds native AFM retrieval and model work", () => {
    const iosAsk = readIosAsk();
    const iosFoundationModels = read("../src-tauri/plugins/briefing-widgets/ios/Sources/FoundationModelBridge.swift");
    expect(iosAsk).toContain("NativeAskTimeoutError");
    expect(iosAsk).toContain("let payload = try await withNativeAskTimeout(seconds: 30)");
    expect(iosAsk).toContain('request("/api/ask/context"');
    expect(iosFoundationModels).toContain("withNativeAskTimeout(seconds: OnDeviceBudget.responseSeconds)");
    expect(iosFoundationModels).toContain("static let responseSeconds: UInt64 = 60");
    // Each attempt gets a fresh session so a failed one cannot fill the next
    // attempt's context window.
    expect(iosFoundationModels).toContain("let session = LanguageModelSession(instructions: instructions)");
  });

  it("streams iOS Ask answers as they arrive and lets the player stop them", () => {
    const iosAsk = readIosAsk();
    // Deltas reach the visible turn instead of a spinner until `done`.
    expect(iosAsk).toContain('pendingText[turnID, default: ""] += text');
    // `done` and `error` end the read; a cut stream is reported, not hung on.
    expect(iosAsk).toMatch(/case "done":[\s\S]*?return true/);
    expect(iosAsk).toContain('object?["error"] as? String');
    expect(iosAsk).toContain("throw NativeAskError.streamDropped");
    // Live-data answers outlast two minutes; keepalives cover dead links.
    expect(iosAsk).toContain("configuration.timeoutIntervalForResource = 600");
    // Stop aborts the server generation, so it costs no quota.
    expect(iosAsk).toContain('request("/api/ask/stop", body: ["reqId": requestID])');
    expect(iosAsk).toContain('accessibilityLabel("Stop answer")');
  });

  it("keeps AFM prompts below the on-device context budget", () => {
    const iosFoundationModels = read("../src-tauri/plugins/briefing-widgets/ios/Sources/FoundationModelBridge.swift");
    expect(iosFoundationModels).toContain("options.history.suffix(OnDeviceBudget.historyTurns)");
    expect(iosFoundationModels).toContain("static let evidenceChars = 3_200");
    expect(iosFoundationModels).toContain("static let compactEvidenceChars = 1_400");
    expect(iosFoundationModels).toContain("case .exceededContextWindowSize");
  });

  it("retains the unified Ask login transaction and session cookies on mobile", () => {
    const iosAsk = readIosAsk();
    const androidAsk = readAndroidAsk();
    for (const source of [iosAsk, androidAsk]) {
      expect(source).toContain("__Host-lakeside_login");
      expect(source).toContain("__Host-lakeside_session");
    }
  });

  it("gives the launcher no filesystem or shell access of its own", () => {
    const permissions = defaultCapability.permissions as Array<
      string | { identifier: string }
    >;
    const identifiers = permissions.map((p) =>
      typeof p === "string" ? p : p.identifier,
    );
    expect(
      identifiers.filter(
        (id) => id.startsWith("fs:") || id.startsWith("shell:"),
      ),
    ).toEqual([]);
    for (const command of [
      "game-start",
      "game-stop",
      "game-request",
      "open-game-window",
      "list-worlds",
    ]) {
      expect(identifiers).toContain(`allow-${command}`);
    }
  });

  it("pins the game window to its own loopback port in Rust", () => {
    const rust = read("../src-tauri/src/desktop.rs");
    expect(rust).toMatch(/fn is_local_game_url\(/);
    expect(rust).toMatch(/WebviewWindowBuilder::new\(&app, "game"/);
    expect(rust).toMatch(/"--parent-pid"/);
    expect(rust).toMatch(/"--no-browser"/);
  });

  it("disables opener JavaScript interception only on desktop and keeps native routing", () => {
    const rust = read("../src-tauri/src/lib.rs");
    expect(rust).toMatch(/#\[cfg\(desktop\)\][\s\S]*?Builder::new\(\)\.open_js_links_on_click\(false\)\.build\(\)/);
    expect(rust).toMatch(/#\[cfg\(mobile\)\][\s\S]*?tauri_plugin_opener::init\(\)/);
    const desktop = read("../src-tauri/src/desktop.rs");
    expect(desktop).toMatch(/\.on_navigation\([\s\S]*?\.opener\(\)\.open_url/);
    expect(desktop).toMatch(/\.on_new_window\([\s\S]*?\.opener\(\)\.open_url/);
    expect(desktop).toContain("is_online_navigation_allowed(url)");
    expect(desktop).toContain("fn is_local_game_url");
    expect(rust).toContain("fn is_online_navigation_allowed(url: &Url)");
    expect(onlineCapability.permissions).toEqual([]);
    expect(gameCapability.permissions).toEqual([]);
  });

  it("keeps the local game and its windows off the mobile build", () => {
    const rust = read("../src-tauri/src/lib.rs");
    expect(rust).toMatch(/#\[cfg\(desktop\)\]\s*mod desktop;/);
    expect(rust).toMatch(/#\[cfg\(mobile\)\]\s*mod mobile;/);
    const cargo = read("../src-tauri/Cargo.toml");
    const desktopOnly = cargo.split(
      "[target.'cfg(not(any(target_os = \"android\", target_os = \"ios\")))'.dependencies]",
    )[1];
    expect(desktopOnly).toBeDefined();
    for (const plugin of [
      "tauri-plugin-shell",
      "tauri-plugin-updater",
      "tauri-plugin-process",
      "tauri-plugin-fs",
      "tauri-plugin-dialog",
      "tauri-plugin-window-state",
    ]) {
      expect(desktopOnly).toContain(plugin);
    }
  });

  it("gives the mobile webview only the online, account and diagnostics commands", () => {
    expect(mobileCapability.platforms).toEqual(["android", "iOS"]);
    expect(mobileCapability.webviews).toEqual(["main"]);
    expect("remote" in mobileCapability).toBe(false);
    expect([...mobileCapability.permissions].sort()).toEqual(
      [
        "core:default",
        "allow-open-online-window",
        "allow-open-help-destination",
        "allow-open-ask-window",
        "allow-linked-account",
        "allow-sign-out",
        "allow-link-account",
        "allow-submit-diagnostics",
        "allow-get-push-status",
        "allow-configure-push",
        "allow-send-test-push",
        "allow-get-briefing",
        "allow-open-briefing-page",
        "allow-open-game-page",
      ].sort(),
    );
    expect(defaultCapability.platforms).toEqual(["linux", "macOS", "windows"]);
  });

  it("strips the sidecar, game resources and updater from mobile bundles", () => {
    for (const config of [androidConfig, iosConfig]) {
      expect(config.app.windows).toEqual([]);
      expect(config.bundle.externalBin).toBeNull();
      expect(config.bundle.resources).toBeNull();
      expect(config.bundle.createUpdaterArtifacts).toBe(false);
      expect(config.plugins.updater).toBeNull();
    }
    expect(androidConfig.bundle.android.minSdkVersion).toBe(24);
    expect(iosConfig.bundle.iOS.minimumSystemVersion).toBe("15.0");
    const mobileRust = read("../src-tauri/src/mobile.rs");
    expect(mobileRust).toMatch(/fn is_app_origin\(/);
    expect(mobileRust).toMatch(/is_online_navigation_allowed\(url\)/);
    expect(mobileRust).toContain("ahdclient://launcher");
  });

  it("generates the canonical logo into both native mobile projects", () => {
    const workflow = read("../../../.github/workflows/release-mobile.yml");
    const iconCommand = "icon src/assets/ahd-logo.png --ios-color '#ffffff'";
    expect(workflow.split(iconCommand)).toHaveLength(3);
    expect(workflow.indexOf("ios init --ci")).toBeLessThan(workflow.lastIndexOf(iconCommand));
    expect(workflow).toContain("sips -g hasAlpha");
  });
});

describe("desktop platform configuration", () => {
  it("keeps release versions and the changelog synchronized", () => {
    const cargoVersion = read("../src-tauri/Cargo.toml").match(
      /^version\s*=\s*"([^"]+)"/m,
    )?.[1];
    expect(rootPackage.version).toBe(desktopPackage.version);
    expect(tauriConfig.version).toBe(desktopPackage.version);
    expect(cargoVersion).toBe(desktopPackage.version);
    expect(read("../../../CHANGELOG.md")).toContain(
      `## [${desktopPackage.version}]`,
    );
  });

  it("bundles Node as a sidecar and the game as a resource", () => {
    expect(tauriConfig.bundle.externalBin).toEqual(["binaries/ahd-node"]);
    expect(tauriConfig.bundle.resources).toEqual({ "resources/game": "game" });
    expect(tauriConfig.app.windows[0]?.backgroundColor).toBe("#14141c");
    expect(tauriConfig.bundle.macOS.hardenedRuntime).toBe(false);
  });

  it("stages the game before every native bundle", () => {
    const workflow = read("../../../.github/workflows/release-desktop.yml");
    expect(workflow).toContain("lakesidegamedev/AHDGame");
    expect(workflow).toContain("scripts/prepare-game.mjs");
    for (const needle of [
      "ubuntu-22.04",
      "windows-latest",
      "macos-latest",
      "--bundles appimage,deb",
      "--bundles nsis",
      "--bundles app,dmg",
      "actions/upload-artifact@v4",
      "ahdclient-windows-x86_64",
      "bundle/nsis/*.exe",
    ]) {
      expect(workflow).toContain(needle);
    }
    expect(workflow).not.toContain("uploadWorkflowArtifacts");
    expect(workflow).toContain("APPLE_SIGNING_IDENTITY: ${{ startsWith(matrix.platform, 'macos') && '-' || '' }}");
    expect(workflow).toContain("console.log('ahd-node-jit-ok')");
    expect(workflow).toContain("-name '*.app.tar.gz'");
    expect(workflow).toContain("tar -xzf \"$archive\"");
  });

  it("shows Windows installer progress after the player confirms restart", () => {
    expect(tauriConfig.plugins.updater.windows.installMode).toBe("passive");
  });

  it("retains signed updater artifacts for every desktop platform", () => {
    const workflow = read("../../../.github/workflows/release-desktop.yml");
    const manifestGenerator = read(
      "../../../scripts/generate-update-manifest.mjs",
    );
    expect(tauriConfig.bundle.createUpdaterArtifacts).toBe(true);
    expect(workflow).toContain("bundle/appimage/*.AppImage.sig");
    expect(workflow).toContain("bundle/macos/*.app.tar.gz");
    expect(workflow).toContain("bundle/macos/*.app.tar.gz.sig");
    expect(workflow).toContain("bundle/nsis/*.exe.sig");
    for (const platform of [
      "windows-x86_64",
      "linux-x86_64",
      "linux-aarch64",
      "darwin-x86_64",
      "darwin-aarch64",
    ]) {
      expect(manifestGenerator).toContain(platform);
    }
  });

  it("tests the Rust target with a staged sidecar", () => {
    const workflow = read("../../../.github/workflows/verify-rust.yml");
    expect(workflow).toContain("libwebkit2gtk-4.1-dev");
    expect(workflow).toContain("prepare-game.mjs --node-only");
    expect(workflow).toContain(
      "cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml",
    );
  });

  it("keeps blocking CI on the bounded fast suite", () => {
    const workflow = read("../../../.github/workflows/verify.yml");
    expect(rootPackage.scripts["verify"]).toContain("test:ci");
    expect(workflow).toContain("npm run verify");
  });

  it("builds Android and iOS bundles in their own workflow", () => {
    const workflow = read("../../../.github/workflows/release-mobile.yml");
    for (const needle of [
      "ubuntu-22.04",
      "macos-latest",
      "android build --apk --aab",
      "ios build --export-method app-store-connect",
      "ios build --ci --target aarch64-sim --no-sign",
      "ahdclient-android",
      "ahdclient-ios",
    ]) {
      expect(workflow).toContain(needle);
    }
    expect(workflow).toContain("Remove signed iOS material");
    expect(workflow).not.toContain("name: ahdclient-ios\n");
    // Signed builds only for an explicit TestFlight dispatch, each with a new
    // build number, and Apple tool output never reaches the public log.
    expect(workflow).toContain('[ "$UPLOAD_TESTFLIGHT" = "true" ]');
    expect(workflow).toContain('"bundleVersion":"${{ github.run_number }}"');
    expect(workflow).toContain("python3 scripts/private-apple-command.py xcrun altool --upload-app");
  });
});
