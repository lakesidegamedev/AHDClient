#!/bin/bash
set -euo pipefail
umask 077
sdk_major=$(xcrun --sdk iphoneos --show-sdk-version | cut -d. -f1)
if [ "$sdk_major" -lt 26 ]; then echo 'Apple uploads require the iOS 26 SDK or newer.' >&2; exit 1; fi
for variable in APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_CONTENT APPLE_DEVELOPMENT_TEAM; do
  if [ -z "${!variable:-}" ]; then echo "Missing repository secret: $variable" >&2; exit 1; fi
done
export APPLE_API_KEY_PATH="$RUNNER_TEMP/lakeside-signing.p8"
python3 - <<'PY'
import base64, os
from pathlib import Path
content = os.environ['APPLE_API_KEY_CONTENT'].strip()
key = content.encode() if content.startswith('-----BEGIN PRIVATE KEY-----') else base64.b64decode(''.join(content.split()), validate=True)
Path(os.environ['APPLE_API_KEY_PATH']).write_bytes(key)
PY
trap 'rm -f "$APPLE_API_KEY_PATH"' EXIT
python3 scripts/apple.py
auth=(-allowProvisioningUpdates -authenticationKeyPath "$APPLE_API_KEY_PATH" -authenticationKeyID "$APPLE_API_KEY" -authenticationKeyIssuerID "$APPLE_API_ISSUER")
# Lakeside Ops moved to lakesidegamedev/lakeside-ops with its own release workflow.
schemes=(LakesideAsk)
for scheme in "${schemes[@]}"; do
  xcodebuild archive -project Lakeside.xcodeproj -scheme "$scheme" -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "build/$scheme.xcarchive" \
    CURRENT_PROJECT_VERSION="${GITHUB_RUN_NUMBER:-1}" CODE_SIGNING_ALLOWED=NO
  app_id=$(python3 -c 'import json,sys; print(next(x["appId"] or "" for x in json.load(open("build/release-status.json")) if x["scheme"] == sys.argv[1]))' "$scheme")
  if [ -z "$app_id" ]; then
    echo "::notice::$scheme compiled for iPhone. Create its app record in App Store Connect, then rerun with release enabled."
    continue
  fi
  python3 - "$scheme" <<'PY'
import os, plistlib, sys
from pathlib import Path
value = {'method': 'app-store-connect', 'destination': 'upload', 'signingStyle': 'automatic',
    'teamID': os.environ['APPLE_DEVELOPMENT_TEAM'], 'manageAppVersionAndBuildNumber': False,
    'uploadSymbols': True, 'stripSwiftSymbols': True}
Path('build/' + sys.argv[1] + '-export.plist').write_bytes(plistlib.dumps(value))
PY
  python3 ../../scripts/private-apple-command.py xcodebuild -exportArchive -archivePath "build/$scheme.xcarchive" \
    -exportOptionsPlist "build/$scheme-export.plist" -exportPath "build/$scheme-export" "${auth[@]}"
  python3 - "$scheme" <<'PY'
import json, sys
from pathlib import Path
p = Path('build/release-status.json'); rows = json.loads(p.read_text())
for row in rows:
    if row['scheme'] == sys.argv[1]: row['status'] = 'uploaded-awaiting-apple-processing'
p.write_text(json.dumps(rows, indent=2) + '\n')
PY
done
cat build/release-status.json >> "$GITHUB_STEP_SUMMARY"
