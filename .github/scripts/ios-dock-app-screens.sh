#!/usr/bin/env bash
# Screenshot the dock inside the real simulator build, over the launcher, on an
# iPhone and an iPad. Launch argument -AHDDockPreview <state> shows canned
# figures with no account (see NativeDock.swift). Evidence, never a gate.
set -u
app="$1"
bundle=net.lakesidegames.ahdclient
mkdir -p ios-dock-app-screens
pick() {
  xcrun simctl list devices available --json | python3 -c "import json,sys
prefix=sys.argv[1]
for runtime, devices in json.load(sys.stdin)['devices'].items():
  if 'iOS' not in runtime: continue
  for d in devices:
    if d['name'].startswith(prefix): print(d['udid']); sys.exit()" "$1"
}
for kind in iPhone iPad; do
  udid=$(pick "$kind"); [ -z "$udid" ] && { echo "no $kind simulator"; continue; }
  xcrun simctl boot "$udid" 2>/dev/null
  xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1
  xcrun simctl ui "$udid" appearance light
  xcrun simctl install "$udid" "$app" || continue
  for state in collapsed expanded; do
    xcrun simctl terminate "$udid" "$bundle" >/dev/null 2>&1
    xcrun simctl launch "$udid" "$bundle" -AHDDockPreview "$state" >/dev/null
    sleep 26
    xcrun simctl io "$udid" screenshot "ios-dock-app-screens/$kind-$state.png" >/dev/null 2>&1 && echo "captured $kind $state"
  done
  xcrun simctl shutdown "$udid" 2>/dev/null
done
ls -la ios-dock-app-screens
exit 0
