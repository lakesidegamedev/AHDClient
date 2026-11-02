import Foundation

// Fixture tests for the dock's pure logic (NativeDockCore.swift and
// NativeDockLayout.swift). Built and run on a Mac in CI:
//   swiftc BriefingStore.swift NativeDockLayout.swift NativeDockCore.swift main.swift
//   ./dock-core-test apps/desktop/src/dockFixtures
// The fixtures are real /api/mobile-dock output from the game's route.

var failures = 0
var checks = 0

func check(_ condition: @autoclosure () -> Bool, _ message: String, line: Int = #line) {
  checks += 1
  if !condition() {
    failures += 1
    print("FAIL (line \(line)): \(message)")
  }
}

guard CommandLine.arguments.count > 1 else {
  print("usage: dock-core-test <fixtures dir>")
  exit(2)
}
let dir = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)

func load(_ name: String) -> Data {
  guard let data = try? Data(contentsOf: dir.appendingPathComponent(name)) else {
    print("cannot read fixture \(name)")
    exit(2)
  }
  return data
}

func tabs(_ layout: DockLayout) -> [DockTab] { DockTabs.tabs(for: layout) }
func links(_ sheet: DockSheet?) -> [DockLink] { (sheet?.sections ?? []).flatMap { $0.links } }

// MARK: Real payloads

let staffBytes = load("mobile-dock-staff-us.json")
let playerBytes = load("mobile-dock-player-nocompany-uk.json")

guard let staff = DockLayoutCodec.decode(staffBytes) else { print("FAIL: staff fixture does not decode"); exit(1) }
guard let player = DockLayoutCodec.decode(playerBytes) else { print("FAIL: player fixture does not decode"); exit(1) }

for (name, layout) in [("staff", staff), ("player", player)] {
  check(layout.tabs.count == 5, "\(name): 5 tabs")
  for key in ["state", "nation", "more"] {
    check(!(layout.sheets[key]?.sections.isEmpty ?? true), "\(name): \(key) sheet has sections")
  }
  check(layout.tabs.first { $0.id == "nation" }?.label == "Nation", "\(name): the nation tab uses shortLabel")
  check(layout.sheets["nation"]?.title.isEmpty == false, "\(name): the nation sheet keeps the full title")
  for sheet in layout.sheets.values {
    for section in sheet.sections {
      check(Set(section.links.map { $0.id }).count == section.links.count, "\(name): link ids unique in \(section.id)")
    }
    check(Set(sheet.sections.map { $0.id }).count == sheet.sections.count, "\(name): section ids unique")
  }
  check(layout.tabs.allSatisfy { $0.icon != nil }, "\(name): every tab icon parsed")
}

check(staff.sheets["more"]?.sections.count == 13, "staff More keeps all 13 sections (got \(staff.sheets["more"]?.sections.count ?? -1))")
check(staff.sheets["more"]?.sections.contains { $0.id == "staff:staff" } == true, "staff More keeps the staff section")
check(player.sheets["more"]?.sections.contains { $0.id.hasPrefix("staff") } == false, "player More has no staff section")
check(staff.sheets["more"]?.sections.contains { $0.id == "help:community" } == true, "colon section ids survive")
check(staff.sheets["nation"]?.sections.first?.id == "switch-country", "country switcher section kept")
check(links(staff.sheets["nation"]).contains { $0.id == "country:US" }, "country link ids with colons survive")

// External links.
let staffExternal = links(staff.sheets["more"]).filter { $0.external }
check(staffExternal.count == 7, "staff has 7 external links (got \(staffExternal.count))")
check(links(player.sheets["more"]).filter { $0.external }.count == 6, "player has 6 external links")
let hosts = Set(staffExternal.compactMap { URL(string: $0.href)?.host ?? ($0.href.hasPrefix("mailto:") ? "mailto" : nil) })
check(hosts == ["wiki.ahousedividedgame.com", "discord.gg", "www.patreon.com", "lakesidegames.net", "docs.lakesidegames.net", "mailto"],
  "external hosts parsed: \(hosts)")
check(links(staff.sheets["more"]).filter { !$0.external }.allSatisfy { $0.href.hasPrefix("/") }, "in-game links stay paths")

// The tabs.
let staffTabs = tabs(staff)
let playerTabs = tabs(player)
check(staffTabs.map { $0.id } == ["company", "state", "nation", "actions", "more"], "staff tab order")
check(playerTabs.map { $0.id } == ["market", "state", "nation", "actions", "more"], "player gets market, not company")
check(DockTabs.tab(forPath: "/country/us/region/NY/legislature", in: staffTabs) == "state", "legislature lights State")
check(DockTabs.tab(forPath: "/country/us/region/NY", in: staffTabs) == "state", "the state page itself lights State")
check(DockTabs.tab(forPath: "/country/us/budget", in: staffTabs) == "nation", "budget lights Nation")
check(DockTabs.tab(forPath: "/country/us", in: staffTabs) == "nation", "the nation page lights Nation")
check(DockTabs.tab(forPath: "/corporation/7/finance", in: staffTabs) == "company", "finance lights Company")
check(DockTabs.tab(forPath: "/corporation/70", in: staffTabs) == nil, "/corporation/70 is not /corporation/7")
check(DockTabs.tab(forPath: "/country/us/region/NYC", in: staffTabs) == "nation", "whole segments: NYC is not NY, but is the nation")
check(DockTabs.tab(forPath: "/actions?tab=x#top", in: staffTabs) == "actions", "query and hash ignored")
check(DockTabs.tab(forPath: "/actions/", in: staffTabs) == "actions", "trailing slash ignored")
check(DockTabs.tab(forPath: "/market", in: playerTabs) == "market", "market lights the market tab")
check(DockTabs.tab(forPath: "/profile", in: staffTabs) == nil, "an unclaimed page lights no tab")
check(DockTabs.tab(forPath: "/", in: staffTabs) == nil, "the home page lights no tab here")
check(DockTabs.tab(forPath: "/country/uk/economy", in: playerTabs) == "nation", "the UK nation page lights Nation on the UK layout")
check(DockTabs.tab(forPath: "/country/us/economy", in: playerTabs) == nil, "another nation does not light the UK tab")

// Longest prefix wins, matched on whole segments.
let rival = [
  DockTab(id: "a", label: "A", icon: nil, symbol: "x", kind: .page("/a"), activePrefixes: ["/country/us"]),
  DockTab(id: "b", label: "B", icon: nil, symbol: "x", kind: .page("/b"), activePrefixes: ["/country/us/region/NY"]),
]
check(DockTabs.tab(forPath: "/country/us/region/NY/legislature", in: rival) == "b", "longest prefix beats shorter")
check(DockTabs.tab(forPath: "/country/us/region/CA", in: rival) == "a", "shorter prefix catches the rest")

// Country follows the page.
check(DockTabs.country(inPath: "/country/uk/economy") == "UK", "country from path")
check(DockTabs.country(inPath: "/country/us") == "US", "country, no tail")
check(DockTabs.country(inPath: "/country") == nil, "bare /country")
check(DockTabs.country(inPath: "/countries") == nil, "/countries is not a country")
check(DockTabs.country(inPath: "/actions") == nil, "other pages have no country")
check(DockTabs.country(inPath: "/country/<script>") == nil, "junk is no country")

// Sign-out paths.
check(["/login", "/register", "/logout"].allSatisfy { DockTabs.signedOutPaths.contains($0) }, "sign-out paths")

// The fallback.
check(DockTabs.fallback.map { $0.id } == ["game", "briefing", "ask", "more"], "fallback tabs")
check(DockTabs.fallback.allSatisfy { $0.icon != nil }, "fallback tabs draw pixel icons")
for icon in [DockAppIcons.game, DockAppIcons.briefing, DockAppIcons.inbox, DockAppIcons.ask, DockAppIcons.launcher, DockAppIcons.more] {
  check(icon.rows == 11 && icon.grid.allSatisfy { $0.count == 11 && $0.allSatisfy { $0 == "0" || $0 == "1" } }, "app icon \(icon.name) is an 11x11 grid")
}

// MARK: Duplicate inbox

let moreLinks = links(staff.sheets["more"])
check(moreLinks.contains { $0.id == "notifications" }, "the game sends a notifications link")
let withoutInbox = staff.sheets["more"]!.sections(without: "notifications")
check(!withoutInbox.flatMap { $0.links }.contains { $0.id == "notifications" }, "notifications dropped when the app adds Inbox")
check(withoutInbox.flatMap { $0.links }.count == moreLinks.count - 1, "only that link is dropped")

// MARK: External policy

check(DockExternal.url("https://wiki.ahousedividedgame.com")?.host == "wiki.ahousedividedgame.com", "wiki allowed")
check(DockExternal.url("https://discord.gg/DmF8zJJuqN") != nil, "discord allowed")
check(DockExternal.url("https://www.patreon.com/cw/AHouseDividedGame/membership") != nil, "patreon allowed")
check(DockExternal.url("https://lakesidegames.net/supporters") != nil, "supporters allowed")
check(DockExternal.url("https://docs.lakesidegames.net") != nil, "docs allowed")
check(DockExternal.url("mailto:admin@ahousedividedgame.com") != nil, "support mail allowed")
for bad in [
  "javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "http://wiki.ahousedividedgame.com",
  "https://evil.example/", "https://wiki.ahousedividedgame.com.evil.example/", "https://user@discord.gg/x",
  "https://discord.gg:8443/x", "mailto:someone@else.example", "mailto:admin@ahousedividedgame.com?cc=x@y.z",
  "//discord.gg/x", "/profile", "https://discord.gg/ x", "https://patreon.com/x", "tel:123",
] {
  check(DockExternal.url(bad) == nil, "rejected: \(bad)")
}

// MARK: Decoder rules

func layoutJSON(tabs: String, sheets: String) -> Data {
  Data("{\"version\":1,\"tabs\":[\(tabs)],\"sheets\":{\(sheets)}}".utf8)
}
let grid = "[\"1\"]"
func tab(_ id: String, sheet: String? = nil, href: String? = nil, extra: String = "") -> String {
  var parts = ["\"id\":\"\(id)\"", "\"label\":\"\(id)\"", "\"icon\":{\"name\":\"x\",\"grid\":\(grid)}"]
  if let sheet { parts.append("\"sheet\":\"\(sheet)\"") }
  if let href { parts.append("\"href\":\"\(href)\"") }
  if !extra.isEmpty { parts.append(extra) }
  return "{" + parts.joined(separator: ",") + "}"
}
func link(_ id: String, href: String = "/x", extra: String = "") -> String {
  "{\"id\":\"\(id)\",\"label\":\"Label\",\"href\":\"\(href)\"\(extra.isEmpty ? "" : "," + extra)}"
}
func section(_ id: String, _ links: [String]) -> String {
  "{\"id\":\"\(id)\",\"title\":\"T\",\"links\":[\(links.joined(separator: ","))]}"
}

// An absolute link needs external:true; external:true needs an allowed destination.
do {
  let sheets = "\"s\":{\"title\":\"S\",\"sections\":[" + section("a", [
    link("keep"), link("abs", href: "https://wiki.ahousedividedgame.com"),
    link("ext", href: "https://wiki.ahousedividedgame.com", extra: "\"external\":true"),
    link("evil", href: "https://evil.example", extra: "\"external\":true"),
    link("js", href: "javascript:alert(1)", extra: "\"external\":true"),
  ]) + "]}"
  let layout = DockLayoutCodec.decode(layoutJSON(tabs: tab("t1", sheet: "s") + "," + tab("t2", href: "/t2"), sheets: sheets))
  let ids = links(layout?.sheets["s"]).map { $0.id }
  check(ids == ["keep", "ext"], "external rules: \(ids)")
}

// Ids: any string up to 64 chars, no control characters; duplicates made unique.
do {
  let longID = String(repeating: "i", count: 65)
  let okID = String(repeating: "j", count: 64)
  let sheets = "\"s\":{\"title\":\"S\",\"sections\":[" + section("state:overview", [
    link("country:US"), link("dup"), link("dup"), link(longID), link(okID), link("bad\\u0001id"),
  ]) + "]}"
  let layout = DockLayoutCodec.decode(layoutJSON(tabs: tab("t1", sheet: "s") + "," + tab("t2", href: "/t2"), sheets: sheets))
  let found = links(layout?.sheets["s"])
  check(found.count == 6, "every link kept (got \(found.count))")
  check(Set(found.map { $0.id }).count == found.count, "link ids unique after dedupe")
  check(found.contains { $0.id == "country:US" }, "colon ids accepted")
  check(found.contains { $0.id == okID }, "64 char ids accepted")
  check(!found.contains { $0.id == longID }, "65 char id replaced")
  check(layout?.sheets["s"]?.sections.first?.id == "state:overview", "colon section id")
}

// Labels: up to 80 characters.
do {
  let long = String(repeating: "w", count: 120)
  let sheets = "\"s\":{\"title\":\"S\",\"sections\":[{\"id\":\"a\",\"title\":\"T\",\"links\":[{\"id\":\"l\",\"label\":\"\(long)\",\"href\":\"/x\"}]}]}"
  let layout = DockLayoutCodec.decode(layoutJSON(tabs: tab("t1", sheet: "s") + "," + tab("t2", href: "/t2"), sheets: sheets))
  check(links(layout?.sheets["s"]).first?.label.count == 80, "labels cut at 80")
  let eighty = String(repeating: "w", count: 80)
  let sheets2 = "\"s\":{\"title\":\"S\",\"sections\":[{\"id\":\"a\",\"title\":\"T\",\"links\":[{\"id\":\"l\",\"label\":\"\(eighty)\",\"href\":\"/x\"}]}]}"
  let layout2 = DockLayoutCodec.decode(layoutJSON(tabs: tab("t1", sheet: "s") + "," + tab("t2", href: "/t2"), sheets: sheets2))
  check(links(layout2?.sheets["s"]).first?.label == eighty, "an 80 char label is whole")
}

// Section cap is 16 and is counted after filtering.
do {
  let empty = (0..<10).map { "{\"id\":\"e\($0)\",\"title\":\"E\",\"links\":[]}" }
  let good = (0..<20).map { section("g\($0)", [link("l\($0)")]) }
  let sheets = "\"s\":{\"title\":\"S\",\"sections\":[" + (empty + good).joined(separator: ",") + "]}"
  let layout = DockLayoutCodec.decode(layoutJSON(tabs: tab("t1", sheet: "s") + "," + tab("t2", href: "/t2"), sheets: sheets))
  check(layout?.sheets["s"]?.sections.count == 16, "16 sections after filtering (got \(layout?.sheets["s"]?.sections.count ?? -1))")
  check(layout?.sheets["s"]?.sections.first?.id == "g0", "empty sections do not count toward the cap")
}

// Tabs: shortLabel wins, a sheet tab needs something to show (More always has the app rows).
do {
  let sheets = "\"full\":{\"title\":\"S\",\"sections\":[" + section("a", [link("l")]) + "]},\"hollow\":{\"title\":\"H\",\"sections\":[]},\"more\":{\"title\":\"M\",\"sections\":[]}"
  let tabsJSON = [
    tab("t1", sheet: "full", extra: "\"shortLabel\":\"Short\""), tab("t2", sheet: "hollow"), tab("t3", sheet: "more"), tab("t4", href: "/t4"),
  ].joined(separator: ",")
  let layout = DockLayoutCodec.decode(layoutJSON(tabs: tabsJSON, sheets: sheets))
  check(layout?.tabs.map { $0.id } == ["t1", "t3", "t4"], "empty sheet tab dropped, More kept: \(layout?.tabs.map { $0.id } ?? [])")
  check(layout?.tabs.first?.label == "Short", "shortLabel preferred")
}

// Wrong version and bad shapes fall back.
check(DockLayoutCodec.decode(Data("{\"version\":2,\"tabs\":[]}".utf8)) == nil, "wrong version")
check(DockLayoutCodec.decode(Data("{\"version\":1,\"tabs\":[]}".utf8)) == nil, "no tabs (no character)")
check(DockLayoutCodec.decode(Data("nope".utf8)) == nil, "not JSON")

// MARK: Request

do {
  let request = DockLayoutClient.request(cookie: "sid=abc", locale: "de", country: "uk")
  check(request.url?.absoluteString == "https://ahousedividedgame.com/api/mobile-dock?country=UK", "country query uppercased: \(request.url?.absoluteString ?? "")")
  check(request.value(forHTTPHeaderField: "Cookie") == "sid=abc; ahd-locale=de", "locale cookie rides with the session")
  let plain = DockLayoutClient.request(cookie: "sid=abc", locale: nil, country: nil)
  check(plain.url?.absoluteString == "https://ahousedividedgame.com/api/mobile-dock", "no country, no query")
  check(plain.value(forHTTPHeaderField: "Cookie") == "sid=abc", "no locale cookie when unknown")
  let hostile = DockLayoutClient.request(cookie: "sid=abc", locale: "de; evil=1", country: "u k;")
  check(hostile.value(forHTTPHeaderField: "Cookie") == "sid=abc", "hostile locale dropped")
  check(hostile.url?.query == nil, "hostile country dropped")
  check(DockLocale.valid("en") == "en" && DockLocale.valid("pt-BR") == "pt-BR" && DockLocale.valid("") == nil && DockLocale.valid("a b") == nil, "locale validation")
}

// MARK: Cache

do {
  let temp = FileManager.default.temporaryDirectory.appendingPathComponent("dock-cache-test-\(UUID().uuidString)", isDirectory: true)
  defer { try? FileManager.default.removeItem(at: temp) }
  let keyEN = DockLayoutCache.key(account: "acct1", locale: nil, country: nil)
  let keyDE = DockLayoutCache.key(account: "acct1", locale: "de", country: nil)
  let keyUK = DockLayoutCache.key(account: "acct1", locale: "de", country: "UK")
  let other = DockLayoutCache.key(account: "acct2", locale: nil, country: nil)
  check(Set([keyEN, keyDE, keyUK, other]).count == 4, "language, country and account all key the cache")
  check(DockLayoutCache.load(key: keyEN, directory: temp) == nil, "empty cache")
  DockLayoutCache.save(staffBytes, key: keyEN, directory: temp)
  DockLayoutCache.save(playerBytes, key: other, directory: temp)
  check(DockLayoutCache.load(key: keyEN, directory: temp)?.tabs.count == 5, "round trip")
  check(DockLayoutCache.load(key: keyDE, directory: temp) == nil, "another language is a different entry")
  let file = temp.appendingPathComponent("dock-layouts.json")
  check((try? file.resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup == true, "cache excluded from backup")
  DockLayoutCache.save(Data("not a layout".utf8), key: keyDE, directory: temp)
  check(DockLayoutCache.load(key: keyDE, directory: temp) == nil, "junk is never cached")
  DockLayoutCache.clear(account: "acct1", directory: temp)
  check(DockLayoutCache.load(key: keyEN, directory: temp) == nil, "clear removes the account")
  check(DockLayoutCache.load(key: other, directory: temp)?.tabs.first?.id == "market", "clear leaves other accounts")
  // Trimmed to the few most recent.
  for index in 0..<(DockLayoutCache.keep + 3) {
    DockLayoutCache.save(staffBytes, key: DockLayoutCache.key(account: "n\(index)", locale: nil, country: nil), directory: temp)
  }
  let kept = (0..<(DockLayoutCache.keep + 3)).filter { DockLayoutCache.load(key: DockLayoutCache.key(account: "n\($0)", locale: nil, country: nil), directory: temp) != nil }
  check(kept.count <= DockLayoutCache.keep, "cache trimmed to \(DockLayoutCache.keep) (kept \(kept.count))")
}

// MARK: The canned preview fixture

check(DockFixture.layout.tabs.count == 5, "preview fixture decodes to 5 tabs")
check(DockFixture.layout.sheets["more"]?.sections.contains { $0.links.contains { $0.external } } == true, "preview fixture has external rows")

print("\(checks - failures)/\(checks) checks passed")
exit(failures == 0 ? 0 : 1)
