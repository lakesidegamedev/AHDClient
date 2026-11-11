#!/usr/bin/env python3
"""Make sure the App ID has Push Notifications and Associated Domains enabled before signing.

Automatic signing only puts aps-environment in the App Store profile when the
App ID has the capability. Without it iOS rejects registerForRemoteNotifications
on every device. The same holds for the associated-domains entitlement (game
links opening the app): without the capability the signed export fails because
the profile cannot carry the entitlement. Idempotent. Prints the capability state only; never the team,
key or signing identity.

Env: APPLE_API_ISSUER, APPLE_API_KEY, APPLE_API_KEY_PATH (the .p8 file).
Needs PyJWT with the cryptography backend.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import jwt

BUNDLE_ID = "net.lakesidegames.ahdclient"
API = "https://api.appstoreconnect.apple.com/v1"
REQUIRED = [
    ("PUSH_NOTIFICATIONS", "Push Notifications"),
    ("ASSOCIATED_DOMAINS", "Associated Domains"),
]


def token() -> str:
    with open(os.environ["APPLE_API_KEY_PATH"], encoding="utf-8") as handle:
        key = handle.read()
    now = int(time.time())
    return jwt.encode(
        {"iss": os.environ["APPLE_API_ISSUER"], "iat": now, "exp": now + 600, "aud": "appstoreconnect-v1"},
        key,
        algorithm="ES256",
        headers={"kid": os.environ["APPLE_API_KEY"], "typ": "JWT"},
    )


def call(method: str, path: str, auth: str, body: dict | None = None) -> dict:
    request = urllib.request.Request(
        API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {auth}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        # Apple error bodies name the failing field, never the team.
        detail = error.read().decode(errors="replace")[:300]
        raise SystemExit(f"FAIL: App Store Connect {method} {path.split('?')[0]} -> {error.code} {detail}")
    return json.loads(raw) if raw else {}


def main() -> int:
    auth = token()
    query = urllib.parse.urlencode({"filter[identifier]": BUNDLE_ID, "limit": 50})
    bundles = [item for item in call("GET", f"/bundleIds?{query}", auth)["data"]
               if item["attributes"]["identifier"] == BUNDLE_ID]
    if len(bundles) != 1:
        print(f"FAIL: expected one App ID {BUNDLE_ID}, found {len(bundles)}")
        return 1
    bundle = bundles[0]["id"]
    capabilities = call("GET", f"/bundleIds/{bundle}/bundleIdCapabilities", auth)["data"]
    kinds = sorted(item["attributes"]["capabilityType"] for item in capabilities)
    print(f"{BUNDLE_ID} capabilities: {', '.join(kinds) or 'none'}")
    for kind, label in REQUIRED:
        if kind in kinds:
            print(f"PASS: {label} already enabled")
            continue
        call("POST", "/bundleIdCapabilities", auth, {
            "data": {
                "type": "bundleIdCapabilities",
                "attributes": {"capabilityType": kind},
                "relationships": {"bundleId": {"data": {"type": "bundleIds", "id": bundle}}},
            }
        })
        print(f"FIXED: {label} enabled on the App ID; signing will issue a new profile")
    return 0

if __name__ == "__main__":
    sys.exit(main())
