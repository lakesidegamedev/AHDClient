# Releasing AHDClient (apps/desktop)

Build commands per OS for the Tauri desktop shell. Product name "AHDClient",
identifier `net.lakesidegames.ahdclient`, version tracked in the root and desktop
`package.json` files, `apps/desktop/src-tauri/tauri.conf.json`, and
`apps/desktop/src-tauri/Cargo.toml`. Run `npm run release:check` after changing
the version. CI and bundle workflows reject version or changelog drift.

## Linux (verified, this is the build this doc was written against)

Prerequisites (Debian/Ubuntu package names):

- `libwebkit2gtk-4.1-dev`, `libgtk-3-dev` (runtime: `libwebkit2gtk-4.1-0`, `libgtk-3-0`)
- `librsvg2-bin` (only needed to regenerate icons from SVG, see below)
- Rust stable toolchain (`rustc`/`cargo`), Node 22.12+
- `dpkg-deb` for the .deb target (present on any Debian-family box)
- AppImage tooling (`appimagetool`, `linuxdeploy` + plugins) is downloaded
  automatically by the Tauri bundler on first build and cached; requires
  outbound network access on that first run

Build:

```bash
npm install
npm run build:web --workspace apps/desktop
cd apps/desktop
npx tauri build
```

Artifacts land under `apps/desktop/src-tauri/target/release/bundle/`:

- `appimage/AHDClient_<version>_amd64.AppImage`
- `deb/AHDClient_<version>_amd64.deb`

`tauri.conf.json` uses the platform-native `"all"` target set. The release
workflow narrows Linux to AppImage and deb. `.deb` dependencies
(`libwebkit2gtk-4.1-0`, `libgtk-3-0`) are auto-detected by the bundler from
the linked libraries; no manual `depends` list is needed.

## Windows

The `desktop bundles` workflow builds an x64 NSIS installer on
`windows-latest`. It can be run manually or by pushing a `v*` tag. Icons are
already generated (`icons/icon.ico`); no extra icon work is needed.

## macOS

The `desktop bundles` workflow builds DMGs for Apple Silicon and Intel on
`macos-latest`. Unsigned workflow artifacts are suitable for build validation.
Public distribution still needs an Apple Developer signing identity and
notarization credentials. `icons/icon.icns` is already generated and ready.

## Icon generation

Source of truth: `apps/desktop/src/assets/ahd-logo.png`, the canonical
red-and-navy Liberty Bell used by the live game and existing client. The A
House Divided name and logo remain Lakeside Games trademarks as noted in the
repository license.

To regenerate the full icon set after changing the source:

```bash
cd apps/desktop
npx tauri icon src/assets/ahd-logo.png
```

The `tauri icon` command generates icons for every platform. This repo commits
the desktop set and the Android resources copied into `gen/android`; iOS and
MSIX-only outputs are not release inputs.

## Auto-updates

Version 2.0.2 and later check the signed stable manifest at
`https://ops.lakesidegames.net/downloads/AHDClient-latest.json`. The updater
signature proves the installer was produced with the Lakeside release key; it
is separate from Windows Authenticode publisher signing.

Set `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the
release environment. Never commit or publish the private key. Tauri emits
signed updater artifacts for Windows, Linux and macOS. Build `latest.json`
after every artifact is at its final URL:

```bash
node scripts/generate-update-manifest.mjs \
  --platform windows-x86_64 https://ops.lakesidegames.net/downloads/ahdclient/AHDClient_2.0.4_x64-setup.exe windows.sig \
  --platform linux-x86_64 https://ops.lakesidegames.net/downloads/ahdclient/AHDClient_2.0.4_amd64.AppImage linux.sig \
  --platform darwin-aarch64 https://ops.lakesidegames.net/downloads/ahdclient/AHDClient_aarch64.app.tar.gz mac-arm.sig \
  --platform darwin-x86_64 https://ops.lakesidegames.net/downloads/ahdclient/AHDClient_x64.app.tar.gz mac-x64.sig
```

Publish the installer first and `latest.json` last. This prevents a client
from discovering an update whose artifact is not available yet. Every staged
game includes `AHD_BUILD.json` with the client version and exact AHDGame commit.

## Verification before a release build

`npm run verify` from repo root is the merge gate: all workspace typechecks,
all bounded unit tests, and a deterministic turn and save smoke test. Full
world simulations are deliberately opt-in through `npm run verify:full` and
do not block CI or packaging. Rust CI is path-filtered to changes under
`apps/desktop/src-tauri`. Per `docs/FRAMEWORK.md`, desktop-touching changes additionally need
`npm run build:web --workspace apps/desktop` and `cargo check` in
`apps/desktop/src-tauri` to pass before a packaging run. Begin every release
candidate check with `npm run release:check`.

## Web preview publish

The web preview is served under a subpath, so it must be built with a relative base or every asset 404s/401s against the host root:

```
npm run build:preview --workspace apps/desktop
cp -r apps/desktop/dist/. <publish dir>/
```

`build:web` (absolute base) is for the Tauri bundle only.

## Game staging

Every native bundle needs two things that are not in this repository: a Node
runtime as a Tauri sidecar and the AHDGame singleplayer build as a resource.
`scripts/prepare-game.mjs` stages both. The release workflow checks out
`lakesidegamedev/AHDGame` at the commit in `game-ref.json` and runs it before
`tauri build`. A tagged release fails unless that commit is on the game's
`main` and no more than `maxAgeDays` older than its tip, so singleplayer cannot
silently fall behind multiplayer. Bump the pin in its own PR, after running the
game's singleplayer smoke (`npm run singleplayer:package && npm run
singleplayer:smoke` in AHDGame) at that commit, and say what changed for
singleplayer players in the changelog. A manual run can pass `game_ref` for a
test build. Locally:

```
node scripts/prepare-game.mjs --game-dir ../AHDGame
```

The game build is large (roughly 550 MB unpacked) and takes several minutes;
`--skip-game-build` reuses an existing `dist/singleplayer` in the checkout.
Nothing staged is committed.

## Android

The `mobile bundles` workflow (`.github/workflows/release-mobile.yml`) builds a
universal release APK and a Play bundle on `ubuntu-22.04` for every `v*` tag
and on demand, and runs on pull requests that touch the client. The Android
project under `apps/desktop/src-tauri/gen/android` is committed; regenerate it
with `npx tauri android init` only when the Tauri CLI template changes, then
re-apply `MainActivity.kt` (user agent marker and system bar insets), the
signing block in `app/build.gradle.kts`, and the window background colour.

Local build, with the SDK, NDK 27 and JDK 21 installed:

```bash
export ANDROID_HOME=<sdk> NDK_HOME=<sdk>/ndk/27.0.12077973 JAVA_HOME=<jdk 21>
cd apps/desktop
npx tauri android build --apk --aab            # every ABI
npx tauri android build --apk --target aarch64 # arm64 only, faster
```

Outputs land under `gen/android/app/build/outputs/apk/universal/release/` and
`.../bundle/universalRelease/`. The mobile config overlay
`tauri.android.conf.json` removes the Node sidecar, the game resources and the
desktop updater from the bundle; Android runs the launcher and the live site
only.

Release signing reads `gen/android/keystore.properties` (gitignored):

```
keyAlias=upload
password=<store and key password>
storeFile=<absolute path to the upload keystore>
```

Without the file the release build is unsigned. The upload keystore lives
outside every checkout. CI signs when the `ANDROID_KEYSTORE_BASE64` and
`ANDROID_KEYSTORE_PASSWORD` repository secrets are set; the alias is `upload`.
Play requires the bundle, sideload testers take the APK. `versionCode` is
derived by Tauri from the version (`major*1000000 + minor*1000 + patch`), so
every release bump is also a Play version bump.

## iOS

iOS builds run only on macOS, so the `mobile bundles` workflow does them on
`macos-latest`. The Xcode project is generated on the runner by
`npx tauri ios init --ci` (it is gitignored under `gen/apple`), then:

- With App Store Connect secrets set (`APPLE_API_ISSUER`, `APPLE_API_KEY`,
  `APPLE_API_KEY_CONTENT` as the base64 `.p8`, and `APPLE_DEVELOPMENT_TEAM`)
  the workflow runs `tauri ios build --export-method app-store-connect` and
  uploads the IPA from `gen/apple/build/arm64/`. Upload it with
  `xcrun altool --upload-app` or Transporter.
- Without them it runs `tauri ios build --ci --target aarch64-sim --no-sign`
  with a placeholder team id and uploads the unsigned simulator app from
  `gen/apple/build/arm64-sim/AHDClient.app`, which proves the iOS compile
  until the developer account and the App Store listing exist. Do not call
  `xcodebuild` directly: the Xcode build phase needs the options file the
  Tauri CLI writes for the build.
- The same unsigned run also tries `--target aarch64 --no-sign --archive-only`
  and zips the device app into the `ahdclient-ios-unsigned-ipa` artifact.
  Sideloadly or AltStore can sign that with a free Apple ID for a seven-day
  install on your own iPhone, no membership required. With a Mac, `npx tauri
  ios dev --open` and a personal team in Xcode does the same.

The overlay `tauri.ios.conf.json` mirrors the Android one and sets iOS 15 as
the minimum system version. The bundle identifier is the shared
`net.lakesidegames.ahdclient`; register it in the developer portal before the
first signed build. On a Mac with Xcode, `npx tauri ios dev` opens the app in a
simulator.

### Widget extension in 2.1.0

After `tauri ios init --ci`, run `ruby scripts/configure-ios-widgets.rb` from
the repository root. It adds `AHDWidgets` to the generated XcodeGen spec and
regenerates the Xcode project. The mobile workflow runs this automatically.
The extension embeds in the app and carries the same release/build version.

Register the `net.lakesidegames.ahdclient.widgets` extension bundle ID with the
same Apple team as the app. Enable App Groups for both targets and associate
`group.net.lakesidegames.ahdclient`. Both provisioning profiles must include
that group and the shared Keychain access group
`$(AppIdentifierPrefix)net.lakesidegames.ahdclient.widgets`. Xcode automatic
signing can create profiles after the capabilities exist in the team.

Unsigned simulator builds validate the extension compile and embedding.
Device validation must check adding all four widgets, stacking equal-size
widgets, sign-in and sign-out, cold-start links, refresh after a turn, and
stale/offline states. A signed device build is required to validate the shared
App Group and Keychain entitlements; an unsigned compile cannot prove those.

## What mobile ships

Android and iOS ship the launcher, its settings and account linking, with
Multiplayer and Sandbox loading the live game in the app's single webview.
Singleplayer and Worldsim are desktop only: they run the game server on the
player's machine. The app webview identifies itself to the game with an
`AHDClient-Mobile/<version>` user agent marker so the site keeps ad slots,
consent prompts and the cookie banner out of the app.

### Native push (2.1.0)

Mobile Settings includes an explicit push opt-in. Android uses FCM; iOS uses
APNs. Remote game pages have no notification IPC. Tokens and session cookies
stay in native storage and requests to the fixed multiplayer origin.

- Android: supply `FIREBASE_ANDROID_CONFIG` in GitHub Actions, containing the
  `google-services.json` for `net.lakesidegames.ahdclient`. For local builds,
  place that ignored file in `apps/desktop/src-tauri/gen/android/app/`.
  Builds without it report that push is unavailable.
- iOS: enable Push Notifications on the app identifier and regenerate signing
  profiles. `configure-ios-widgets.rb` adds the APNs entitlement using
  development for Debug and production for Release/TestFlight. The existing
  widget App Group and keychain entitlements are still required.
- Game server: deploy `/api/push/device` and its inbox dispatcher before
  enabling delivery. Configure `NATIVE_PUSH_ENABLED=true`; Android requires
  `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`; iOS requires
  `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`. An App Store Connect upload
  key is not an APNs key. Keep all private keys in the deployment secret store.
- Push is off initially. The OS prompt appears only after Turn on. Existing
  inbox mutes and snoozes apply; routine turn income stays in the inbox.
  Lock-screen previews are generic and taps open `/notifications`.
- On signed-in device tests, verify permission denial, enabling, disabling,
  background delivery, a tap from a terminated app, token rotation, sign-out,
  and switching accounts. Revocation must complete before binding a different
  account. Queued provider deliveries have a five-minute lifetime.

Unsigned CI builds validate compilation, not APNs provisioning or actual
provider delivery. Android delivery requires Google Play services. Physical
APNs/FCM delivery remains a release check with the configured providers.

### Desktop alerts (2.5.0)

Desktop polls `GET /api/push/feed` (AHDGame) while open; there is no provider
to configure. Deploy the feed to production before shipping a desktop build
that relies on it: an older server answers 404 and Settings says desktop
alerts are not offered yet. On each OS, verify turning alerts off and on, a
new alert while the launcher has focus (shown), while the live game has focus
(suppressed), several alerts in one minute (newest on top plus a count), and
sign-out. macOS shows its own permission prompt the first time.

### Private iOS delivery with EAS

The EAS project under `apps/lakeside-ios` provides private native build hosts
for all three iOS apps. Its `production` profile builds Lakeside Ask and
Lakeside Ops. Its `ahdclient-production` profile builds AHDClient with its
WidgetKit extension. Both profiles upload directly to App Store Connect.

Apple credentials are stored as Secret variables in the EAS `production`
environment. The setup workflow in `.github/workflows/eas-credentials.yml`
copies the existing GitHub secrets to the fixed EAS project without printing
their values. The build scripts suppress Apple signing output, delete signed
packages and temporary keys before completion, and declare no downloadable
artifacts. Public source builds therefore do not publish the account identity
embedded in Apple distribution signatures.

From `apps/lakeside-ios`, start the native app uploads with:

```bash
eas build --platform ios --profile production
```

Start the AHDClient upload with:

```bash
eas build --platform ios --profile ahdclient-production
```
