import XCTest
@testable import LakesideAsk

@MainActor final class SessionTests: XCTestCase {
    private func session() -> AppSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FixtureProtocol.self]
        return AppSession(.ops, configuration: config)
    }
    private func askSession() -> AppSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FixtureProtocol.self]
        return AppSession(.ask, configuration: config)
    }
    func testOpsProductionCookieCompletesSignIn() async throws {
        // Same attributes as opsSessionCookie: the server omits Secure.
        let url = URL(string: "https://ops.lakesidegames.net/")!
        let cookie = try XCTUnwrap(HTTPCookie.cookies(withResponseHeaderFields: [
            "Set-Cookie": "ops_session=fixture-login; Path=/; HttpOnly; SameSite=Lax; Domain=.lakesidegames.net; Max-Age=3600"
        ], for: url).first)
        XCTAssertFalse(cookie.isSecure)
        let app = session()
        try await app.accept(cookie)
        XCTAssertTrue(app.signedIn)
        XCTAssertEqual(app.profile["role"].string, "admin")
        await app.signOut()
    }
    func testPublicSuffixCookieCannotSignIn() async throws {
        let cookie = try XCTUnwrap(HTTPCookie(properties: [.name: "ops_session", .value: "fixture-login", .domain: ".net", .path: "/", .secure: "TRUE"]))
        let app = session()
        do { try await app.accept(cookie); XCTFail("Public suffix accepted") } catch {}
        XCTAssertFalse(app.signedIn)
    }
    func testAskStillRequiresItsSecureCookie() async throws {
        let app = askSession()
        let cookie = try XCTUnwrap(HTTPCookie(properties: [.name: "__Host-ask_session", .value: "fixture-login", .domain: "ask.lakesidegames.net", .path: "/"]))
        do { try await app.accept(cookie); XCTFail("Ask accepted an insecure cookie") } catch {}
        XCTAssertFalse(app.signedIn)
    }
    func testAskProductionCookieCompletesSignIn() async throws {
        let url = URL(string: "https://ask.lakesidegames.net/")!
        let cookie = try XCTUnwrap(HTTPCookie.cookies(withResponseHeaderFields: [
            "Set-Cookie": "__Host-ask_session=fixture-login; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600"
        ], for: url).first)
        let app = askSession()
        try await app.accept(cookie)
        XCTAssertTrue(app.signedIn)
        XCTAssertEqual(app.profile["identity"]["username"].string, "Test operator")
        await app.signOut()
    }
    func testAskUnifiedAuthCookieCompletesSignIn() async throws {
        let url = URL(string: "https://ask.lakesidegames.net/")!
        let cookie = try XCTUnwrap(HTTPCookie.cookies(withResponseHeaderFields: [
            "Set-Cookie": "__Host-lakeside_session=fixture-login; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600"
        ], for: url).first)
        let app = askSession()
        try await app.accept(cookie)
        XCTAssertTrue(app.signedIn)
        XCTAssertEqual(app.profile["identity"]["username"].string, "Test operator")
        await app.signOut()
    }
    func testAskContextUsesTheAuthenticatedSession() async throws {
        let app = askSession()
        let cookie = try XCTUnwrap(HTTPCookie(properties: [.name: "__Host-ask_session", .value: "fixture-login", .domain: "ask.lakesidegames.net", .path: "/", .secure: "TRUE"]))
        try await app.accept(cookie)
        let context = try await app.post("/api/ask/context", ["question": .string("How does inflation work?"), "game": .string("ahd")])
        XCTAssertEqual(context["game"]["id"].string, "ahd")
        XCTAssertTrue(context["context"].string.contains("price index"))
        await app.signOut()
    }
    func testAskRejectsLegacyCookieName() async throws {
        let app = askSession()
        let cookie = try XCTUnwrap(HTTPCookie(properties: [.name: "ask_session", .value: "fixture-login", .domain: "ask.lakesidegames.net", .path: "/", .secure: "TRUE"]))
        do { try await app.accept(cookie); XCTFail("Ask accepted the legacy cookie name") } catch {}
        XCTAssertFalse(app.signedIn)
    }
    func testApplePromptUsesRetrievedGameEvidence() {
        let prompt = AppleFoundationModelPrompt.make(
            question: "How does inflation work?",
            history: [],
            gameName: "A House Divided",
            gameSubject: "a political strategy game",
            gameEvidence: "SOURCE CODE: inflation is calculated from the price index.",
            length: "standard",
            style: "standard",
            mode: "auto"
        )
        XCTAssertTrue(prompt.contains("inflation is calculated from the price index"))
        XCTAssertTrue(prompt.contains("Use the evidence for game mechanics"))
        XCTAssertFalse(prompt.contains("You do not have access to current game state, server tools, citations, or live data."))
    }
    func testAppleFoundationModelToolProtocolIsRejected() {
        XCTAssertTrue(ToolProtocolSanitizer.containsProtocol(#"{"recipient_name":"gamestate","tool_input":{"country":"US"}}"#))
        XCTAssertTrue(ToolProtocolSanitizer.containsProtocol("<tool_call><function=country_fiscal>"))
        XCTAssertFalse(ToolProtocolSanitizer.containsProtocol("US inflation is currently elevated."))
    }
    func testUnrelatedCookieCannotSignIn() async throws {
        let cookie = try XCTUnwrap(HTTPCookie(properties: [.name: "ops_session", .value: "fixture", .domain: "attacker.example", .path: "/", .secure: "TRUE"]))
        let app = session()
        do { try await app.accept(cookie); XCTFail("Unrelated domain accepted") } catch {}
        XCTAssertFalse(app.signedIn)
    }
    // MARK: - Research trail

    private func step(_ state: String, id: Double = 1, name: String = "search_code",
                      verb: String = "Searched the source", kind: String = "source",
                      icon: String = "search", target: String = "dividend tax") -> JSONValue {
        .object(["id": .number(id), "name": .string(name), "state": .string(state),
                 "verb": .string(verb), "kind": .string(kind), "icon": .string(icon), "target": .string(target)])
    }

    private func completion(id: Double = 1, ms: Double = 412, ok: Bool = true,
                            summary: String = "5 excerpts from 3 files") -> JSONValue {
        .object(["id": .number(id), "state": .string("end"), "ms": .number(ms), "ok": .bool(ok), "summary": .string(summary)])
    }

    func testResearchTrailCorrelatesStartAndCompletion() {
        var trail = ResearchTrail()
        let start = Date(timeIntervalSince1970: 1_000)
        trail.apply(step("start"), at: start)
        XCTAssertEqual(trail.steps.count, 1)
        XCTAssertEqual(trail.steps[0].status, .running)
        XCTAssertEqual(trail.steps[0].title, "Searched the source")
        XCTAssertEqual(trail.steps[0].target, "dividend tax")
        XCTAssertEqual(trail.steps[0].phase, "search")
        XCTAssertEqual(trail.steps[0].symbol, "magnifyingglass")
        XCTAssertEqual(trail.startedAt, start)

        trail.apply(completion(), at: start.addingTimeInterval(0.4))
        XCTAssertEqual(trail.steps[0].status, .done)
        XCTAssertEqual(trail.steps[0].summary, "5 excerpts from 3 files")
        XCTAssertEqual(trail.steps[0].milliseconds, 412)
        XCTAssertEqual(trail.steps[0].durationText, "412ms")
        XCTAssertFalse(trail.steps[0].missed)
        XCTAssertEqual(trail.durationText(at: start.addingTimeInterval(4.2)), "4.2s")
    }

    func testResearchTrailSettlesAnOrphanCompletion() {
        // A completion whose start never arrived still becomes a done row, so a
        // dropped frame cannot leave a step running forever.
        var trail = ResearchTrail()
        trail.apply(completion(id: 9, ms: 731, summary: "read live data"))
        XCTAssertEqual(trail.steps.count, 1)
        XCTAssertEqual(trail.steps[0].status, .done)
        XCTAssertEqual(trail.steps[0].summary, "read live data")
    }

    func testResearchTrailAcceptsALegacySingleShotEvent() {
        // Older servers send one event with the old `tool(query)` label.
        var trail = ResearchTrail()
        trail.apply(.object(["name": .string("search_code"), "label": .string("search_code(dividend tax)")]))
        XCTAssertEqual(trail.steps.count, 1)
        XCTAssertEqual(trail.steps[0].status, .done)
        XCTAssertEqual(trail.steps[0].title, "search_code(dividend tax)")
        XCTAssertEqual(trail.steps[0].symbol, "magnifyingglass")
    }

    func testResearchTrailTallyAndGroupsFollowTheSteps() {
        var trail = ResearchTrail()
        trail.apply(step("start", id: 1, kind: "source"), at: Date())
        trail.apply(completion(id: 1), at: Date())
        trail.apply(step("start", id: 2, name: "read_file", verb: "Read the file", kind: "file", icon: "file", target: "gdp.ts"), at: Date())
        trail.apply(completion(id: 2, ms: 96, summary: "read 2 parts"), at: Date())
        trail.apply(step("start", id: 3, name: "trace_corp", verb: "Looked up the corporation", kind: "live", icon: "corp", target: "Lakeside"), at: Date())
        trail.apply(completion(id: 3, ms: 731, summary: "read live data"), at: Date())

        XCTAssertEqual(trail.tally.searches, 1)
        XCTAssertEqual(trail.tally.files, 1)
        XCTAssertEqual(trail.tally.live, 1)
        XCTAssertEqual(trail.tally.steps, 3)
        XCTAssertEqual(trail.tally.line, "1 search · 1 file read · 1 live read")
        XCTAssertEqual(trail.groups.map(\.phase), ["search", "read", "live"])
        XCTAssertEqual(trail.groups.first?.steps.count, 1)
    }

    func testResearchTrailCountsAMissAsAFindingOfNothing() {
        var trail = ResearchTrail()
        trail.apply(step("start", id: 1, name: "grep_code", verb: "Searched exact symbols"))
        trail.apply(completion(id: 1, ms: 88, ok: false, summary: "nothing found"))
        XCTAssertTrue(trail.steps[0].missed)
        XCTAssertEqual(trail.tally.misses, 1)
        XCTAssertEqual(trail.steps[0].accessibilityLabel, "Searched exact symbols, dividend tax, nothing found")
    }

    func testResearchTrailStopsAtItsLimit() {
        var trail = ResearchTrail()
        for index in 0..<(ResearchTrail.limit + 5) {
            trail.apply(step("start", id: Double(index)))
        }
        XCTAssertEqual(trail.steps.count, ResearchTrail.limit)
    }
}
