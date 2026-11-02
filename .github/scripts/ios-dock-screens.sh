#!/usr/bin/env bash
# Build the dock harness (the real dock sources around a stand-in page) and
# screenshot it on an iPhone and an iPad simulator, collapsed and expanded,
# in both appearances, signed out, on the Briefing tab and at a large text
# size. Evidence for design review; a build failure fails the job, a missing
# screenshot does not.
set -u
src=apps/desktop/src-tauri/plugins/briefing-widgets/ios/Sources
out=dock-screens
mkdir -p "$out" build-harness/DockHarness.app
sdk=$(xcrun --sdk iphonesimulator --show-sdk-path)
xcrun swiftc -parse-as-library -swift-version 5 -target arm64-apple-ios15.0-simulator -sdk "$sdk" \
  -o build-harness/DockHarness.app/DockHarness \
  "$src/BriefingStore.swift" "$src/NativeNav.swift" "$src/NativeDock.swift" "$src/FoundationModelBridge.swift" "$src"/NativeAsk*.swift \
  .github/ios-dock-harness/HarnessApp.swift 2>&1 | grep -E "error|warning: unre" ; test -x build-harness/DockHarness.app/DockHarness || { echo "harness build failed"; exit 1; }
cp .github/ios-dock-harness/Info.plist build-harness/DockHarness.app/Info.plist
codesign --force -s - build-harness/DockHarness.app
bundle=net.lakesidegames.ahdclient.dockharness
pick() {
  xcrun simctl list devices available --json | python3 -c "import json,sys
prefix=sys.argv[1]
for runtime, devices in json.load(sys.stdin)['devices'].items():
  if 'iOS' not in runtime: continue
  for d in devices:
    if d['name'].startswith(prefix): print(d['udid']); sys.exit()" "$1"
}
shot() { # udid file state
  xcrun simctl terminate "$1" "$bundle" >/dev/null 2>&1
  xcrun simctl launch "$1" "$bundle" -AHDDockPreview "$3" >/dev/null
  sleep 4
  xcrun simctl io "$1" screenshot "$out/$2.png" >/dev/null 2>&1 && echo "captured $2"
}
for kind in iPhone iPad; do
  udid=$(pick "$kind"); [ -z "$udid" ] && { echo "no $kind simulator"; continue; }
  echo "== $kind"
  xcrun simctl boot "$udid" 2>/dev/null
  xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1
  xcrun simctl install "$udid" build-harness/DockHarness.app || continue
  xcrun simctl ui "$udid" appearance dark
  shot "$udid" "$kind-1-collapsed-dark" collapsed
  shot "$udid" "$kind-2-expanded-dark" expanded
  shot "$udid" "$kind-3-signedout-dark" signedout
  shot "$udid" "$kind-4-briefing-dark" briefing
  xcrun simctl ui "$udid" appearance light
  shot "$udid" "$kind-5-collapsed-light" collapsed
  shot "$udid" "$kind-6-expanded-light" expanded
  xcrun simctl ui "$udid" appearance dark
  xcrun simctl ui "$udid" content_size accessibility-extra-extra-large
  shot "$udid" "$kind-7-collapsed-bigtext" collapsed
  shot "$udid" "$kind-8-expanded-bigtext" expanded
  xcrun simctl ui "$udid" content_size large
  xcrun simctl shutdown "$udid" 2>/dev/null
done
ls -la "$out"
exit 0
