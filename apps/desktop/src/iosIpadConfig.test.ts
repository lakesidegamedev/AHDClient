import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Windows checkouts can use CRLF; the patterns below expect LF.
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const script = read("../../../scripts/configure-ios-widgets.rb");
const plist = read("../src-tauri/Info.ios.plist");
const css = read("./launcher/launcher.css");

describe("iPad enablement", () => {
  it("targets iPhone and iPad for the app and iPhone only for the widget extension", () => {
    const families = [
      ...script.matchAll(/'TARGETED_DEVICE_FAMILY'\]?\s*(?:=>|=)\s*'([^']+)'/g),
    ].map((m) => m[1]);
    expect(families).toEqual(["1,2", "1"]);
    expect(script).toMatch(/\['base'\]\['TARGETED_DEVICE_FAMILY'\] = '1,2'/);
    expect(script).toMatch(
      /'SKIP_INSTALL' => 'YES',\s*'TARGETED_DEVICE_FAMILY' => '1'/,
    );
  });

  it("declares all four iPad orientations and does not opt out of multitasking", () => {
    const block = plist.match(
      /<key>UISupportedInterfaceOrientations~ipad<\/key>\s*<array>([\s\S]*?)<\/array>/,
    );
    expect(block).not.toBeNull();
    for (const name of [
      "Portrait",
      "PortraitUpsideDown",
      "LandscapeLeft",
      "LandscapeRight",
    ]) {
      expect(block![1]).toContain(
        `<string>UIInterfaceOrientation${name}</string>`,
      );
    }
    expect(plist).not.toContain("UIRequiresFullScreen");
  });

  it("keeps the iPhone orientations without upside down", () => {
    const block = plist.match(
      /<key>UISupportedInterfaceOrientations<\/key>\s*<array>([\s\S]*?)<\/array>/,
    );
    expect(block![1]).not.toContain("UpsideDown");
  });

  it("applies safe-area insets to the launcher above the phone breakpoint", () => {
    const wide = css.slice(css.lastIndexOf("@media (min-width: 701px)"));
    expect(wide).toMatch(
      /\.launcher-stage\s*\{[^}]*env\(safe-area-inset-right\)[^}]*env\(safe-area-inset-left\)/,
    );
    // The top bar carries the top inset for every width, iPad included.
    expect(css).toMatch(
      /\.launcher-topbar\s*\{[^}]*env\(safe-area-inset-top\)[^}]*env\(safe-area-inset-right\)/,
    );
    expect(wide).toMatch(
      /\.launcher-footer\s*\{[^}]*env\(safe-area-inset-bottom\)/,
    );
  });
});

describe("iOS appearance", () => {
  const plugin = read("../src-tauri/plugins/briefing-widgets/ios/Sources/BriefingWidgetsPlugin.swift");
  const ask = read("../src-tauri/plugins/briefing-widgets/ios/Sources/NativeAsk.swift");

  it("lets native sheets follow the system while the launcher stays dark", () => {
    // No app-wide pin: Ask and other native sheets follow light or dark.
    expect(plist).not.toMatch(/<key>UIUserInterfaceStyle<\/key>/);
    expect(script).toContain("props.delete('UIUserInterfaceStyle')");
    // The launcher window pins itself dark; Ask overrides from the device setting.
    expect(plugin).toContain("NativeLauncherAppearance.pinDark(webview)");
    expect(ask).toContain("window.overrideUserInterfaceStyle = .dark");
    expect(ask).toContain("func applySystemAppearance()");
  });

  it("paints the launch screen the launcher color so light mode never flashes white", () => {
    expect(script).toContain('launchScreen="YES"');
    expect(script).toContain('red="0.0784313725" green="0.0784313725" blue="0.1098039216"');
    expect(script).toContain("props['UILaunchScreen'] = { 'UIColorName' => 'LaunchBackground' }");
  });
});
