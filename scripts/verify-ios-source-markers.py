#!/usr/bin/env python3
"""Fail when the built iOS app does not contain the current Swift sources.

A restored build cache can link a stale compiled plugin while the rest of the
app is new (2.3.19 build 8 showed push text that no longer existed in source).
Every literal below must appear in the app executable; update the list when
the source text changes. Markers must be longer than 15 bytes: Swift stores
shorter strings inline in the code, so they never appear as text in the binary.
"""

from __future__ import annotations

import plistlib
import sys
import tempfile
import zipfile
from pathlib import Path

SOURCES = Path(__file__).resolve().parents[1] / "apps/desktop/src-tauri/plugins/briefing-widgets/ios/Sources"
MARKERS = {
    "NativePush.swift": ["Apple declined push registration: ", "This build is not set up for push alerts.",
        "Push alerts are on. Tap one to open what it is about."],
    "NativeDockView.swift": ["Opens outside the game", "Shows the full status"],
    "NativeAskView.swift": ["Ask uses outside AI services", "Ask sends nothing until you allow it."],
}


def main() -> int:
    errors = []
    errors += [f"{m!r} is 15 bytes or fewer; Swift inlines it, pick a longer marker"
               for ms in MARKERS.values() for m in ms if len(m.encode()) <= 15]
    for file, markers in MARKERS.items():
        text = (SOURCES / file).read_text()
        errors += [f"{file} no longer contains {m!r}; update MARKERS" for m in markers if m not in text]
    with tempfile.TemporaryDirectory(prefix="ahdclient-markers-") as directory:
        with zipfile.ZipFile(sys.argv[1]) as archive:
            archive.extractall(directory)
        apps = list((Path(directory) / "Payload").glob("*.app"))
        if len(apps) != 1:
            print(f"FAIL: expected one app bundle, found {len(apps)}")
            return 1
        info = plistlib.loads((apps[0] / "Info.plist").read_bytes())
        binary = (apps[0] / info["CFBundleExecutable"]).read_bytes()
    for file, markers in MARKERS.items():
        for marker in markers:
            if marker.encode() not in binary:
                errors.append(f"app executable lacks {marker!r} from {file}: stale compiled plugin")
    for error in errors:
        print(f"FAIL: {error}")
    if not errors:
        print("PASS: the app executable matches the current Swift sources")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
