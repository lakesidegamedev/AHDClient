# Changelog

## [2.7.0] - 2026-10-29

- iPhone, iPad and Android: a tab bar along the bottom of the screen replaces the round AHD button. Game, Briefing, Inbox, Ask and More are always one tap away, and the page now ends above the bar so the game's bottom status bar is never covered.
- Tapping Game takes you back to the page you were reading. Tap it again to go to the game's home page.
- The Inbox tab shows how many unread messages you have.
- More takes you back to the launcher, where Settings and your account are.
- iPad with a keyboard: Cmd+1 to Cmd+5 switch tabs, Cmd+K opens Ask, Cmd+R reloads the page, and Cmd+[ and Cmd+] go back and forward. Hold Cmd to see the list.
- Settings has a Send test button under Notifications. On a phone it asks the game to send one alert to that phone; on a computer it shows one straight away. It then says plainly whether it worked and, if not, what to do: sign in, allow notifications, or wait for the phone to connect.
- Fewer, clearer alerts: phones and computers now only get alerts you need to act on or that are about you, such as votes to cast, offers to answer, races won or lost and attacks on your company. Routine company reports and crises in your home state stay in the inbox. This comes from the game and applies to every version of the app.
- Launcher: your account, Briefing, Settings and Ask now sit in their own bar at the top instead of floating over the title. On iPad and in narrow desktop windows they used to cover the game name.
- iPhone and Android: the launcher's top bar holds just your account and Settings; Briefing and Ask live in the new tab bar.
- Settings is easier to read. Each option shows its name and explanation on the left with its switch on the right, instead of a grey title with the switch centred underneath. It opens as a sheet from the bottom on phones.
- Settings is grouped into General, Notifications, Singleplayer, Updates and Support on every platform, and shows your AHDClient version at the top. Phones now have a Notifications heading like desktop, and the Updates section no longer appears on phones, where updates come from the store.
- Fixed: the phone Settings header showed German text with English selected. Settings is now fully translated when you choose Deutsch.
- Headings across the launcher, world setup, Briefing and desktop Ask use the same clean sans-serif type as the rest of the app.
- The Singleplayer and Worldsim Beta tags stay on one line inside the mode switch.
- The account menu closes when you tap or click anywhere else, and Escape closes it without opening Settings.
- Keyboard focus is now visible on switches, dropdowns and menus in Settings and the account menu.
- Android: the bar behind the Back, Home and Recents buttons stays dark when your phone uses a light theme, instead of showing a pale strip under the game.

## [2.6.2] - 2026-10-14

- Desktop: links to outside sites open safely in your browser again.
- Desktop: confirmation prompts in the app work again.
- New singleplayer worlds start with the newest computer-controlled politicians, V6. They do the same things as V5 but decide better, such as backing stronger candidates in races they can win and counting votes before bringing a bill, with no extra money or action points. V6 is recommended in world setup, and the older levels are still there to pick.

## [2.6.1] - 2026-10-11

- iPhone: medium widgets give the main figure room. Share price, actions or vote share show in full with their change underneath, the chart is bigger, and Profile and Overview use the space under the main figure for more figures.
- iPhone: the "Next turn" countdown no longer draws over its label.
- iPhone: after an app update, widgets fetch fresh figures right away instead of showing the old saved ones until the next turn, so market cap, national influence and per-turn changes appear straight after updating.
- iPhone: small widgets keep their labels whole and show just the turn number under your name.

## [2.6.0] - 2026-10-11

- Ask is rebuilt for each phone. iPhone and iPad follow Apple's design and your light or dark setting; Android uses Material 3 and follows your theme. On iPad, your past chats sit in a sidebar beside the conversation.
- Ask keeps your past conversations: search them, open one to continue, start a new chat, or delete one.
- Answers are properly formatted with headings, lists and tables, and names of game pages are links that open the page in the app.
- Copy an answer, share a conversation, and mark answers helpful or not helpful.
- Ask shows how many questions you have left today and when they reset, and suggests follow-up questions after each answer.
- Answers can include maps and charts, and you can attach a screenshot or photo to a question.
- Ask holds up better on a weak connection: it retries, signs you back in if your session runs out mid-chat, keeps a partial answer if the connection drops and lets you retry, and keeps your draft and conversation when you close and reopen it.
- Widgets show more: market cap for your corporation, state and national influence, and how each figure is moving per turn, with clearer price charts that stand out from the background.
- Android widgets now match iPhone, including a new Overview widget with the turn countdown.

## [2.5.0] - 2026-10-10

- Desktop: inbox alerts now appear as system notifications on Windows, macOS and Linux while AHDClient is open. Each one shows the alert's title, its category and the message, and several at once end with a count of what else is waiting. They stay quiet while you are looking at the live game.
- Desktop: new Notifications section in Settings to turn desktop alerts on or off. They start on; a fresh install begins from your current inbox instead of replaying old alerts.
- Android: alerts now arrive in one notification channel per category (Crisis, Elections, Legislation, Party, Treasury, Standing, System), so you can silence or change the sound for one kind in Android Settings. Crisis alerts can pop up over other apps.
- Android: signing in with Discord no longer stops on "Session expired" when your phone's browser, rather than the Discord app, opens the Discord approval page. The browser now sends you back to the app to finish.
- Android: the game's bottom character bar no longer sits under the Back, Home and Recents buttons on phones that use three-button navigation.
- Android: Ask works after you link your game account. It used to say the account was not linked every time, even right after linking succeeded.
- iPhone and Android: Ask has a cleaner screen in the app's own dark style: a clear link step when needed, starter questions in an empty chat, a proper Send button, and the model and sources shown quietly under each answer. On iPhone, the choice between online and on-device answers moved into the options menu.
- Android: the sandbox is back for linked supporters. iPhone keeps it off.
- Settings on every platform has an Alert types button that opens the game settings, where you can mute the kinds of alerts you do not want. Mutes and snoozes apply to phone and desktop alerts alike.

## [2.4.1] - 2026-10-10

- Android: the app no longer freezes on the sign-in page. Tapping Continue with Discord, or any link that opens outside the app, used to stop the app answering taps until Android closed it.

## [2.4.0] - 2026-10-09

- Notifications show what happened: the alert's own title and message, its category, and how many more are waiting, instead of "You have new activity". Tapping one opens the page it is about, such as the election, bill or crisis.
- iPhone: new Overview widget with a live countdown to the next turn, your actions, unread inbox and mail, and the latest turn's changes.
- iPhone: every widget now comes in a large size. Election and Corporation widgets draw vote share and share price over recent turns, and Election shows when polls close.
- iPhone: the Stocks widget lists every company you own shares in, with quote and holding value. Tap a row to open that company.
- iPhone: Lock Screen widgets for the next turn, actions, vote share and your corporation.
- Android: each widget page shows more, plus the current turn, the next turn time and your inbox.
- The in-game AHD menu adds Inbox and Briefing, and Multiplayer is now called Game home.
- Briefing shows the current turn, a countdown to the next one and your inbox. Turn changes read in their own units with the current value, and they, and your stock holdings, open their page when tapped. Your corporation card has a share price chart.
- Android: fixed a crash that could close the app a few seconds after opening it on slower phones, when reading your signed-in session took too long.
- Fixed: tapping the Stocks widget did not open anything.
- Fixed: the Profile widget showed empty figures instead of asking you to choose a character.

## [2.3.26] - 2026-10-09

- iPhone: pull down from the top of a game page to reload it.
- iPhone: fixed a crash that could close the app right after opening it. Reading your signed-in session from the web view could abort the app, most often on a cold start.
- iPad: the app now runs as a native iPad app in every orientation, with Split View and Slide Over, instead of a scaled iPhone window.
- Version bump for the next App Store submission.

## [2.3.25] - 2026-10-08

- iPhone and Android: the app now refuses the supporter purchase and supporter wall links at the native layer, not only by hiding the buttons. No behavior change for players.
- Version bump for the next App Store submission.

## [2.3.24] - 2026-10-07

- Android: signing in with Discord opens the Discord app, where you are already signed in, to approve, then returns to AHDClient signed in. Without the Discord app it uses the browser and still returns to AHDClient.

## [2.3.23] - 2026-10-06

- iPhone and iPad: confirmation, alert, and text prompts from the game now appear. They were silently skipped, so buttons that ask "are you sure?" first (entering a race, withdrawing, and many others) did nothing.

## [2.3.22] - 2026-10-06

- Android: the app no longer closes as soon as it opens. Release builds stripped a method the app needs to read its sign-in cookies, and that method also crashed when there were no cookies yet, so every Android phone was affected. Every release build is now launched on Android 14 and 16 emulators before it can ship.

## [2.3.21] - 2026-10-06

- Android: the native library is aligned for 16 KB memory pages, and builds are checked for this before release.

## [2.3.20] - 2026-10-06

- iPhone: swipe in from the left edge to go back a page.
- Phones: the AHD button moves above the game's bottom status bar instead of covering it.
- Phones: the account menu opens on screen; it ran off the left edge.
- iPad (iPhone app in a window): the launcher keeps clear of the window controls.
- iPhone push alerts: the signed app now carries the production push entitlement, Settings shows Apple's actual reason if registration fails, and builds are checked against the current source before upload.

## [2.3.19] - 2026-09-18

- Restored the authenticated native Ask surface.
- Open Ask immediately from an account-scoped cache while access refreshes in the background.
- Display current Ask usage quota and keep it synchronized after requests, limits, authentication changes, and account switches.
- Always open the native Ask panel. Sign-in is a broker bounce that reuses the existing game login, not the Ask website.
- Detect both `ask_session` and `__Host-ask_session`, and refresh the panel as soon as that cookie lands.
- Send opted-in simulation statistics after the first sample, each End turn cadence, returning to the launcher, and Save and stop. Unknown newer feature flags are dropped instead of blocking the upload.
- Upload richer anonymous single-player aggregates (GDP, population, approval, elections) when the local game provides them.
- Drop source maps and package markdown from the bundled game payload.
- Repaired Android mobile CI after removal of the legacy SDK tools package.

Phone builds of 2.3.19, 2026-10-05 (iPhone and Android):

- iPhone and Android: Ask names the outside AI services that may receive a question and asks for permission before the first one. Permission can be reviewed or withdrawn from "AI providers", and each answer shows which model and service wrote it.
- iPhone and Android: the sandbox is no longer offered in the phone app; it stays available on desktop.
- iPhone widgets fill their rounded frame, show your portrait and corporation or stock logos, and follow the profile and corporation page layout.
- Phone launcher: no bar above the home indicator, and the controls stay inside the screen's safe areas.
- iPhone push alerts: Settings now shows Apple's actual reason when registration fails, and the App Store build is checked for the push entitlement before upload.
- The iPhone privacy manifest declares the device key used for sign-in checks and push, and that Ask questions may be used by an AI provider to train its models.

## [2.3.18] - 2026-09-14

- Rebuild the bundled game from the post-2.3.17 Head of State repair source.
- Repair existing local Head of State worlds during the launcher status handshake, restoring the canonical General Secretary or Prime Minister and the cabinet controls without requiring a new game.
- Keep formal Head of State NPP appointments available after the repaired government is established; the red Admin tab remains a player-only direct tool.

## [2.3.17] - 2026-09-14

- Let players host an existing private world for LAN or VPS guests from the Worlds screen.
- Restore owner admin permissions for bundled local worlds, including world-local moderation and bans.
- Bundle the September 13-14 Head of State repairs: visible cabinet offices, working leader authority, and NPP cabinet or head-of-state appointments.

## [2.3.16] - 2026-09-12

- Retain linked-account cookies in the native iOS Ask session instead of silently discarding them.
- Let native iOS Ask reuse the existing game login through issuer SSO, including recovery from an expired Ask session.
- Verify the native authentication path before building the iOS release.

## [2.3.15] - 2026-09-12

- Recover raw JSON on-device answers as readable prose on iOS.
- Bundle the existing-save government repair and accurate extraction idle reporting.

- Guard optional Android widgets, push, native Ask, and deep links against
  native exceptions, with bounded diagnostics for failures.
- Document the status-handshake contract required by the permanent
  head-of-state repair, so existing local worlds can recover their canonical
  government when the updated AHDGame runtime is packaged.

## [2.3.14] - 2026-09-12

- Keep Apple Foundation Models prompts within the on-device context budget and retry with a compact prompt when retrieved evidence is too large.
- Bound live tool evidence so AFM questions do not fail immediately after account linking.

## [2.3.13] - 2026-09-12

- Accept the desktop link compatibility session in the Lakeside Auth broker and explicitly forward the scoped game session from iOS native Ask.
- Preserve iOS Ask authentication across legacy, unified, and current game session cookie shapes.
- Keep Apple Foundation Models failures visible and recover from tool-call protocol output instead of silently dropping the question.

## [2.3.12] - 2026-09-12

- Forward the current unified Lakeside session to native Ask on iOS and Android so linked accounts are recognized without leaking the session to the legacy game broker.
- Keep Apple Foundation Models questions usable without live evidence, preserve the optional read-only live lookup for linked accounts, and show generation errors instead of silently reverting the question.
- Keep multiplayer and sandbox navigation inside the game and turn the bottom-left control into a small native game menu with direct Ask access.

## [2.3.11] - 2026-09-12

- Keep native Ask linked-account handoff working for accounts already routed through unified Lakeside auth.
- Bound Apple Foundation Models retrieval, live-tool lookup, and on-device generation so stalled requests fail visibly instead of spinning forever.


## [2.3.10] - 2026-09-11

- Restore native Ask linked-account handoff on iOS and Android, including the unified Lakeside auth cookies used by the current sign-in flow.
- Let Apple Foundation Models questions reach grounded Ask evidence and the on-device answer path after the linked account is detected.
- Give Apple Foundation Models one authenticated, read-only live game lookup and show its execution as native tool activity instead of raw protocol text.
- Enable cited on-device answers and native charts or diagrams, and report the actual AFM variant on supported iOS 27 devices.

## [2.3.9] - 2026-09-11

- Route Ask and account sign-in through the canonical Lakeside auth portal on desktop, Android, and iOS.
- Ground Apple Foundation Models answers with Ask's retrieved game documentation and show the supporting source files while keeping answer generation on-device.
- Keep the standalone Ask app's Apple Foundation Models option aligned with the hosted Ask release.

## [2.3.8] - 2026-09-11

- Add an optional Apple on-device Ask provider for supported iOS 26 devices. Ask retrieves bounded game evidence for the selected question, then the answer is generated on the iPhone and is not saved; live game data, citations, charts, and attachments remain on the Ask server path.
- Show the serving Free Router model while a native Ask answer is being drafted.
- Fix native Ask sign-in after auth hardening by capturing the `__Host-ask_session` cookie and using POST for logout.
- Harden Android startup so optional widget, JobScheduler, and push companion failures cannot terminate the main client WebView.
- Release the current Head of State singleplayer path with the AHDGame 1.8.3 pairing verified.

## [2.3.6] - 2026-09-11

- Add an Ask button to the launcher header and the playing toolbar. It opens the player Q&A service in a narrow panel docked against the right edge of the screen, so questions sit beside play. Reopening resumes the same panel in place: history and an in-flight answer survive closing and reopening, and the platform minimize and close buttons work as expected. Sign-in rides the shared app session, so players already signed in skip the password prompt; the daily question allowance is shown inside the panel.

## [2.3.5] - 2026-09-10

- Make Windows updates visible during installation and leave relaunch ownership with the installer, removing the unexplained blank interval after Restart.
- Record failed updater handoffs on the next launch and automatically submit bounded, redacted crash, setup and updater diagnostics.
- Add the 2027 starting era backed by the new `2027-default` game seed.
- Pull era photographs back to show the full composition and enlarge the globe into a restrained, site-style background element.
- Pair with AHDGame 1.8.3 so permanent head-of-state singleplayer characters can enact validated national laws directly without legislative votes.

## [2.3.4] - 2026-09-10

- Never replace a newer bundled game with an older published runtime, while keeping compatible prior game versions selectable.
- Keep local-world loading progress inside its track and prevent reported progress from moving backwards.
- Repair the era timeline preview width and show complete era names instead of clipped labels.
- Mark desktop game webviews as AHDClient surfaces so cookie disclosure and online-player indicators stay out of the native shell.
- Remove the game's duplicate singleplayer End Turn control when the native toolbar already provides it.

## [2.3.3] - 2026-09-10

- Prevent two client instances from opening the same world database, and pair this with an atomic shared MongoDB runtime install.
- Recover local worlds from inherited hosted maintenance state and improve first-world seed reliability.
- Default to the newest published game runtime, download it when needed, and avoid listing the bundled version twice.
- Replace the era carousel with a seven-stop chronological timeline and a stronger selected-era preview.
- Render the launcher globe against its real layout size at up to 3x display density.
- Add locale-aware English and German client-shell language selection. Existing browser-based account login remains unchanged.
- Keep singleplayer on the multiplayer game codebase: only the local supervisor and local startup repair differ.

All notable AHDClient changes are recorded here.

## [2.3.2] - 2026-09-10

- Open singleplayer setup on the Normal play mode even when Worldsim was used last. A stored Worldsim mode was leaking across entry points; the Worldsim tab still preselects simulation mode.
- Restyle world setup with selectable option cards, a visible checked state, and an era hero banner. The play-mode, autonomy, and world-setting controls previously fell back to unstyled browser defaults.
- Rework world setup and Settings into compact, grouped control surfaces with stronger hierarchy, native switches, responsive layouts, and keyboard-visible focus states.
- Trim the playing toolbar to window-level controls only. The account chip, Settings, and Diagnostics duplicated the game below; both dialogs stay reachable through the launcher and the Escape shortcut.
- Slim the embedded-game toolbar and show native turn progress with a spinner and current turn while singleplayer simulation runs.
- Label the runtime selector explicitly and identify the bundled game as 1.8.0, the first downloadable game-version baseline.
- Drop the "THE FULL GAME / ON YOUR MACHINE" tagline block from the Windows installer sidebar artwork.

## [2.3.1] - 2026-09-09

- Start local play with native world setup and character creation. End turn stays locked until a character exists, except in Worldsim.
- Keep the launcher globe anchored while menus cover it, with softer overlap and lighting that matches the website.
- Add a compact playing bar with End turn, linked identity, pause, and save controls. Refresh the current game page and show actual funds/actions changes after a turn.
- Explain autonomy and difficulty separately, show v4 as the live multiplayer tier, and label permanent head of state and Worldsim as Beta.
- Show linked account pictures from trusted hosts, or Admin for an unlinked local identity. Keep account privileges separate from local play.
- Organize settings into Launcher, Game, Updates, and Support, with startup logs and diagnostics under Advanced.
- Bundle local maintenance, session, and turn-progress fixes. The progress popup is singleplayer-only, centered on phones, and reports stale or disconnected turns without spinning forever.

- Download desktop updates in the background and wait for Restart to update before installing. Windows quiet install starts only after that confirmation, so the app does not exit while the file is still downloading.
- Stage only the runtime game payload: traced modules, mongodb aliases, the target sharp native, server.js, launch.mjs, .next/static and public. Fail packaging if leftover source, docs, tests or plan markdown remain.

## [2.3.0] - 2026-09-09

- Replace the singleplayer maintenance soft lock with a limited local Control Room. Local players remain non-admins while retaining safe start, pause, turn, rules and diagnostic controls.
- Redesign briefing widgets around character and corporation identity with PFPs, logos, monogram fallbacks and calmer rounded metric tiles.
- Add a private Stocks view and native Stocks widgets backed by up to five corporations from the active character's real portfolio.
- Enrich Election briefing with race context, live margin and seat projections, plus recorded vote-share history.
- Add deterministic Turn Briefings built only from recorded corporation, market and election changes.
- Restrict native remote identity images to bounded HTTPS URLs on trusted A House Divided, Discord and Vercel Blob hosts.

## [2.1.2] - 2026-09-08

- Replace the overflowing update changelog strip with a compact branded card that keeps release notes collapsed, stays clear of launcher controls and can be dismissed until the next launch.
- Clear hosted maintenance state from local singleplayer after a fresh world reset, and repair affected 2.1.1 worlds when the launcher checks their status.
- Restore manual diagnostic submission with the launcher's bounded, redacted runtime context.

## [2.1.1] - 2026-09-08

- Keep iOS briefing widgets signed in by sharing the session and current briefing through an entitled Keychain group.
- Give iOS widgets a branded A House Divided layout with clearer Profile, Election and Corporation cards.
- Let the anonymously signed bundled Node runtime use JIT memory and native modules on macOS so local singleplayer can start.
- Publish updater archives for both Apple silicon and Intel Macs.

## [2.1.0] - 2026-09-08

- Add opt-in native push notifications on Android and iOS, with private previews and inbox links.

- Add a multiplayer briefing with swipeable Profile, Election and Corporation cards.
- Add an always-on-top desktop picture-in-picture briefing with quick page links.
- Add native Android home-screen widgets, refresh controls and app shortcuts.
- Add iOS Profile, Election and Corporation widgets for the Home Screen and widget stacks.
- Remember the selected briefing card, refresh on resume and reconnect, and show the age of saved stats.

## [2.0.9] - 2026-09-07

- Generate the A House Divided Liberty Bell icon into the iOS and Android native projects so TestFlight and installed mobile apps no longer use placeholder artwork.
- Add Developer diagnostics to Settings on iOS, Android and desktop with runtime details and a bounded live console.
- Let players copy, clear or explicitly send redacted diagnostics while keeping user paths, world names, email addresses and credentials out of reports.

## [2.0.8] - 2026-09-07

- Stop mobile builds from calling the desktop updater, which produced an ACL error banner on iOS.
- Keep mobile issue reports inside the app through the feedback screen, while keeping versioned GitHub reports on desktop.
- Reserve a separate mobile header row for Link account and Settings so the controls no longer cover the A House Divided masthead.
- Raise the iOS minimum version to 15.0 ahead of Apple's 2027 upload requirement.

## [2.0.7] - 2026-09-07

- Fix the Windows installer header artwork clipping the A House Divided name.
- Bundle A House Divided 1.8.0, including player-paced singleplayer turns,
  optional custom turn timers and the focused player interface.

## [2.0.6] - 2026-09-06

- Add Android and iOS builds of the launcher: the same lander, settings and account linking, with Multiplayer and Sandbox opening the live game inside the app. Singleplayer and Worldsim stay desktop only, since they run the game on the player's machine.
- Return to the launcher from any online page on mobile with the AHD mark in the corner, or the system back button on Android.
- Keep ad slots, consent prompts and the cookie banner out of the mobile app webview by identifying it to the game as AHDClient-Mobile.
- Add a mobile bundles workflow that produces the Android APK and Play bundle and the iOS archive, with store signing supplied through repository secrets and an unsigned build otherwise.
- Fix diagnostics reports never leaving the desktop launcher: the command lacked a permission grant.

## [2.0.5] - 2026-09-06

- Fix Windows local worlds never becoming ready: the game server was started on the launcher's own input and output handles, which on Windows left it accepting connections without answering. It now runs on captured output and a fresh world is ready in seconds.
- Stop the local database through its own shutdown command when a world is closed, and wait for it to finish before the supervisor exits, so the last turn is always on disk and a world can be reopened immediately.
- Keep a closing world's supervisor alive until it reports that it has exited instead of ending it after a fixed delay.
- Report each startup step in plain words with its own deadline, and on failure show the step, the game server's last output and the database log instead of a frozen progress line.
- Skip preloading every page and route in the local game server, which held the first request for several seconds.

## [2.0.4] - 2026-09-06

- Fix repeated MongoDB downloads with a shared, versioned cache that only accepts complete installations.
- Reduce fresh-world startup to seconds by skipping hosted initialization work and production-only turn auditing in local singleplayer.
- Detect stalled setup promptly, show continuing startup progress, and offer redacted opt-in diagnostics after failures or cancellation.
- Add release-gated world creation, turn processing, shutdown, and restart smoke coverage across Windows, Linux, and macOS game packages.
- Add verified game-version downloads and graceful switching for immutable game releases from 1.6.0 onward.
- Fix failed desktop updates remaining stuck on Installing and retain signed updater artifacts for Windows, Linux, and macOS.
- Restyle the installer and launcher settings with native account controls, issue reporting, gameplay hints, and clearer update controls.

## [2.0.3] - 2026-09-06

- Fix linked-account recognition for environment-scoped production sessions and replace the inert account-management action with clear Profile or Link account controls.
- Replace the launcher settings panel with a universal Esc menu containing clearer preferences and a signed check, download, update and restart flow.
- Add a thin singleplayer game-version selector for immutable game releases from 1.6.0 onward, including verified downloads and offline access to installed versions.
- Keep the command globe fixed between launcher views and strengthen the animated atmospheric background.
- Show real first-run setup phases, smooth progress and stall detection while a local world is built instead of freezing on a buffered setup request.
- Reduce local world creation and turn time by skipping production-only audits while retaining compact opt-in performance analytics.
- Add a dismissible in-game turn progress toast with the A House Divided mark, plain-English phase descriptions and a smooth progress bar.

## [2.0.2]

- Fix the packaged Windows game server by retaining the hashed external module aliases emitted by the Next.js standalone build.
- Complete account linking by reading the authenticated game webview session and require a server-granted Singleplayer entitlement with a bounded seven-day offline grace period.
- Gate Sandbox on a linked Supporter account and show the exact link or upgrade action when access is unavailable.
- Replace raw world-start logs with a historical loading slideshow and practical era tips; technical logs remain available through Settings.
- Add signed in-client updates from the Lakeside download portal and keep each client release paired with its bundled AHDGame build.

## [2.0.1]

- Mark Singleplayer and Worldsim as Beta and add a playerless simulation entry.
- Show New Game, Load Game and Continue before era selection; add historical era photos and a larger globe.
- Add normal and Head of State setup, independent NPP difficulty/autonomy, and world feature controls.
- Default gameplay to the launcher window, with a separate-window preference.
- Add game account linking and supporter checks for Sandbox.
- Add optional anonymous aggregate reports with bounded offline retention and immediate opt-out.
- Adapt Windows resource paths before passing them to bundled Node and isolate database ports.
- Guard process startup and stale exit events; pause launcher animation while hidden.
- Stop the game supervisor through its control pipe so stopping a world also closes its child processes.

## [2.0.0] - 2026-09-05

### Changed

- Singleplayer is now the real game. The client runs the A House Divided server locally under a bundled Node, against a MongoDB it finds on your machine or downloads once, and shows it in its own window. Every screen, map and mechanic is the multiplayer game's own; nothing is re-implemented in the client any more.
- The launcher keeps its look and gains worlds: each world is its own data folder with a name, era, turn and character, listed under All worlds. Continue resumes the most recent one; a running world can be resumed or stopped from the launcher.
- New world asks for a world name and your name, then builds the world from the chosen era's preset and drops you into character creation.
- Turns advance from an End turn button inside the game instead of a client-side turn loop.

### Removed

- The ported engine, its content packs, the CLI, every ported game screen and the save-file format. Saves from 1.x do not carry over; the worlds they described were a different simulation.
- The Android build. The local server needs a desktop operating system.

### Security

- The game window is a plain webview pinned to its own loopback port with no Tauri capabilities, the same shape as the multiplayer window. The launcher window has no filesystem or shell access; worlds and the server are managed entirely in Rust.

## [1.0.3] - 2026-09-03

### Added

- Replaced the sparse singleplayer dashboard with a multiplayer-shaped navigation shell covering all 58 stable destinations, including matching Nation, State, World, and Help grouping and ordering.
- Added player-scoped home-region identity for new and migrated worlds, with State navigation that remains anchored to the character instead of the currently viewed country.
- Added functional local controls for Governor addresses and executive orders, party endorsements and internal elections, coalition management, cabinet nominations, extraction, sovereign bonds, savings, wire transfers, law repeal, and Senate filibusters.
- Added a live country overview and grounded local summaries for destinations that do not need a dedicated screen.

### Fixed

- Stopped failed actions from consuming action points, campaign funds, cooldowns, or action counters.
- Removed fabricated chamber officeholders and corrected the fiscal approval calculation to use budget GDP in matching currency units.
- Corrected personal navigation so My Party, My Election, Cabinet Office, and State destinations follow the player character, including Head of State party binding.
- Routed the Wiki and other Help destinations through allowlisted native handlers while preserving Android in-app navigation for game-hosted pages.
- Kept unavailable mechanics visible with named blockers instead of presenting incomplete action controls.

### Quality assurance

- Added route smoke coverage across every playable era and country, all 58 destinations, and a no-network assertion for local navigation.
- Added interaction tests for Governor, party operations, Congress procedure, Head of State, markets, character migration recovery, and safe action execution.
- Verified the fast and full repository suites, the production web build, and the Tauri Rust checks before release packaging.

## [1.0.2] - 2026-09-03

### Fixed

- Moved desktop multiplayer webview creation off the Tauri UI thread so opening the live game no longer produces a frozen blank window on Windows.
- Made the new-world era choice player-controlled after entering setup instead of continuously resetting it to the launcher selection.
- Allowed historically valid high-inflation starts such as 1991 Brazil, whose 480% annual rate previously made the entire era fail editor validation and disabled world creation.

### Quality assurance

- Added browser-level interaction tests for era stability, country-list refresh, play-mode selection, feature-flag overrides, validation, and the exact options passed into world creation.
- Added a bounded creation matrix covering all 21 supported era and playable-country starts without adding long simulations to CI.
- Added a release regression that keeps native multiplayer window construction off the UI thread.

## [1.0.1] - 2026-09-02

### Ten quality improvements

1. The launcher remembers the selected singleplayer or multiplayer mode and starting era.
2. Continue prevents duplicate loads, shows progress, and reports load failures without leaving the launcher.
3. The save manager automatically selects the newest valid slot when no current selection remains.
4. Save slots can be filtered by name, player, country, era, date, turn, or cheat status.
5. The dashboard has a one-tap quick save backed by `quick-save`, with Ctrl+S and Cmd+S shortcuts.
6. Unsaved worlds now warn before launcher exit, browser unload, refresh, or window close.
7. Manual and automatic saves clear dirty state only after success, and autosaves confirm their destination.
8. Turn-processing failures are caught and shown in the dashboard instead of becoming unhandled rejections.
9. New-world character names and seeds validate immediately, mark invalid fields, and block invalid creation.
10. NPC party ballots are tallied transiently while player ballots remain persisted, reducing a measured 100-turn 1953 world from 121.3 MiB to 48.8 MiB without changing deterministic results.

### Changed

- Aligned the client palette and repository presentation with the current A House Divided visual system while retaining AHDClient's restrained launcher layout.
- Rebranded the application, package scopes, platform identifiers, build artifacts, documentation, and GitHub repository from its former codename to AHDClient.
- Changed the repository from PolyForm Noncommercial to proprietary source-available terms and marked every workspace package private and unlicensed for registry publication.
- Split multi-turn simulation proofs from the blocking CI gate. The fast gate retains more than 800 bounded tests, including a deterministic turn and save smoke test; the full suite remains available through `npm run verify:full`. Rust validation runs only when Tauri source changes.

## [1.0.0] - 2026-09-02

### Added

- Local singleplayer across the 1953, 1979, 1991, and 2019 eras with 21 playable era and country combinations.
- Career and Head of State starts, on-demand deterministic turns, government, economy, markets, parties, elections, congress, campaigns, corporations, world, character, actions, and news views.
- Save slots, rotating crash-safe autosaves, and validated JSON import and export.
- One-tap Continue from the launcher for the newest valid local save.
- Singleplayer Tools for editing player, country, politician, party, election, time, and news state.
- Twenty-six persisted simulation controls, now configurable both when a world is created and while it is running.
- Desktop multiplayer window with a separate zero-capability security boundary and persistent sign-in.
- In-app multiplayer navigation on Android, using the same session flow as the existing mobile client.
- Linux AppImage, deb, and rpm packaging; Windows NSIS and macOS DMG validation workflows; Android APK and AAB builds.
- Release metadata verification through `npm run release:check`.

### Changed

- Restored the restrained A House Divided visual direction and canonical logo across the launcher and native application assets.
- Hardened mobile layouts for safe areas, narrow screens, touch targets, and scrollable data views.
- Launcher version text now comes from package metadata instead of a hard-coded string.

### Fixed

- Save migration through schema version 42, including feature flags for older worlds.
- Multiplayer navigation isolation, external-link handling, and desktop session persistence.
- Determinism, election seat totals, government formation, politician population bounds, treasury bounds, and economy sanity across the 21-combination QA matrix.

### Distribution notes

- Repository builds are reproducible without private credentials.
- Public macOS notarization, Windows signing, Android Play signing, and updater publication require the release owner's credentials and endpoints. These are distribution operations, not source-code fallbacks.
