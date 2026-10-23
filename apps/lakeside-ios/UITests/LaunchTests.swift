import XCTest

final class LaunchTests: XCTestCase {
    func testNativeAuthenticatedScreens() {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"]; app.launch()
        if app.tabBars.buttons["Team"].waitForExistence(timeout: 5) {
            XCTAssertTrue(app.staticTexts["Help me build the studio hub."].waitForExistence(timeout: 10))
            capture(app, "Ops assistant")
            app.tabBars.buttons["Team"].tap()
            let worker = app.staticTexts["Export repair"]
            XCTAssertTrue(worker.waitForExistence(timeout: 10)); worker.tap()
            XCTAssertTrue(app.staticTexts["Export fixed. All checks passed."].waitForExistence(timeout: 10))
            capture(app, "Ops worker report")
            app.tabBars.buttons["Usage"].tap()
            XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "5-hour allowance")).firstMatch.waitForExistence(timeout: 10))
            capture(app, "Ops measured usage")
        } else {
            let conversation = app.staticTexts["How does inflation work?"]
            XCTAssertTrue(conversation.waitForExistence(timeout: 10)); conversation.tap()
            XCTAssertTrue(app.staticTexts["Prices respond to supply and demand."].waitForExistence(timeout: 10))
            capture(app, "Native Ask conversation")
            let composer = app.textFields["ask-composer"].exists ? app.textFields["ask-composer"] : app.textViews["ask-composer"]
            XCTAssertTrue(composer.waitForExistence(timeout: 5)); composer.tap(); composer.typeText("What changes prices?")
            app.buttons["Send question"].tap()
            allowOutsideAI(app)
            XCTAssertTrue(app.staticTexts["Verified final answer from the server."].waitForExistence(timeout: 10))
            XCTAssertFalse(app.staticTexts["A partial draft"].exists)
            capture(app, "Completed streamed answer")
        }
        XCTAssertEqual(app.webViews.count, 0)
    }
    func testAskOptionsUsageAndStarters() throws {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"]; app.launch()
        if app.tabBars.buttons["Team"].waitForExistence(timeout: 3) { throw XCTSkip("Ask features") }
        XCTAssertTrue(app.buttons["Daily allowance"].waitForExistence(timeout: 10))
        capture(app, "Ask 1.1 home")
        app.buttons["Daily allowance"].tap()
        XCTAssertTrue(app.staticTexts["Question credits"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["153.5 left"].exists)
        capture(app, "Ask allowance bars")
        app.buttons["Done"].tap()
        let explore = app.buttons["Explore questions"]
        reveal(explore, in: app)
        explore.tap()
        XCTAssertTrue(app.navigationBars["Explore questions"].waitForExistence(timeout: 5))
        capture(app, "Ask starter browser")
        app.buttons["Done"].tap()
        let conversation = app.staticTexts["How does inflation work?"]
        reveal(conversation, in: app, upward: false)
        conversation.tap()
        app.buttons["Answer options"].tap()
        XCTAssertTrue(app.staticTexts["Charts, diagrams, and maps"].waitForExistence(timeout: 5))
        capture(app, "Ask response options")
        app.buttons["Done"].tap()
        let mode = app.buttons["Answer mode"]
        XCTAssertTrue(mode.waitForExistence(timeout: 5)); mode.tap()
        XCTAssertTrue(app.buttons["Verify"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Autopsy"].exists)
        XCTAssertTrue(app.buttons["Scenario"].exists)
        XCTAssertTrue(app.buttons["Report"].exists)
        capture(app, "Ask answer modes")
        app.buttons["Report"].tap()
        XCTAssertEqual(mode.value as? String, "Report")
        app.buttons["Share conversation"].tap()
        XCTAssertTrue(app.buttons["Export as Markdown file"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Create public link"].waitForExistence(timeout: 5))
        app.buttons["Create public link"].tap()
        XCTAssertTrue(app.staticTexts["Your link is ready."].waitForExistence(timeout: 5))
        XCTAssertEqual(app.webViews.count, 0)
    }
    func testNativeAskChartAndMap() throws {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-visuals"]; app.launch()
        if app.tabBars.buttons["Team"].waitForExistence(timeout: 3) { throw XCTSkip("Ask visualizations") }
        let conversation = app.staticTexts["How does inflation work?"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 10)); conversation.tap()
        XCTAssertTrue(app.staticTexts["GDP growth"].waitForExistence(timeout: 10))
        capture(app, "Native Ask chart")
        app.swipeUp()
        let expand = app.buttons["Expand game map"]
        XCTAssertTrue(expand.waitForExistence(timeout: 10)); expand.tap()
        XCTAssertTrue(app.navigationBars["Game map"].waitForExistence(timeout: 5))
        capture(app, "Native Ask map")
        XCTAssertEqual(app.webViews.count, 0)
    }
    func testOpsWorkbench() throws {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"]; app.launch()
        guard app.tabBars.buttons["Hub"].waitForExistence(timeout: 5) else { throw XCTSkip("Ops workbench") }
        app.buttons["Conversations"].tap()
        XCTAssertTrue(app.staticTexts["Build the studio hub"].waitForExistence(timeout: 5))
        capture(app, "Ops conversation history")
        app.buttons["Done"].tap()
        app.tabBars.buttons["Hub"].tap()
        app.buttons["ops-files-open"].tap()
        app.staticTexts["Studio hub"].tap()
        app.staticTexts["app.swift"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "let version")).firstMatch.waitForExistence(timeout: 5))
        capture(app, "Ops source preview")
        app.buttons["Changes"].tap()
        XCTAssertTrue(app.staticTexts["+let version = 1.3"].waitForExistence(timeout: 5))
        capture(app, "Ops file diff")
        app.tabBars.buttons["Hub"].tap()
        app.buttons["Schedules"].tap()
        XCTAssertTrue(app.staticTexts["Morning review"].waitForExistence(timeout: 5))
        capture(app, "Ops schedule controls")
        XCTAssertEqual(app.webViews.count, 0)
    }
    func testOpsStaffAndActivity() throws {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"]; app.launch()
        guard app.tabBars.buttons["Team"].waitForExistence(timeout: 5) else { throw XCTSkip("Ops staff") }
        let activity = app.buttons["ops-activity"]
        XCTAssertTrue(activity.waitForExistence(timeout: 10)); activity.tap()
        let search = app.textFields["ops-activity-search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText("missing-command\n")
        XCTAssertTrue(app.staticTexts["No matching activity"].waitForExistence(timeout: 5))
        capture(app, "Ops searchable activity")
        app.tabBars.buttons["Team"].tap()
        XCTAssertTrue(app.staticTexts["Release engineer"].waitForExistence(timeout: 5))
        capture(app, "Ops staff and assignments")
        app.staticTexts["Release engineer"].tap()
        XCTAssertTrue(app.staticTexts["Verify exports before release."].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Export repair"].exists)
        capture(app, "Ops persistent staff profile")
        app.buttons["Assign work"].tap()
        XCTAssertTrue(app.textFields["ops-assignment-title"].waitForExistence(timeout: 5))
        capture(app, "Ops new assignment")
        app.buttons["Cancel"].tap()
        app.tabBars.buttons["Usage"].tap()
        for _ in 0..<8 {
            if app.buttons["Provider benchmarks"].isHittable { break }
            app.swipeUp()
        }
        app.buttons["Provider benchmarks"].tap()
        XCTAssertTrue(app.staticTexts["Measure before routing"].waitForExistence(timeout: 5))
        capture(app, "Ops provider benchmarks")
        XCTAssertEqual(app.webViews.count, 0)
    }
    func testOpsManualRoutingPersistsAndFreeRouterHasNoEffort() throws {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"]; app.launch()
        guard app.tabBars.buttons["Team"].waitForExistence(timeout: 5) else { throw XCTSkip("Ops routing") }
        let routing = app.buttons["ops-routing-open"]
        XCTAssertTrue(routing.waitForExistence(timeout: 10)); waitForEnabled(routing); routing.tap()
        let provider = app.descendants(matching: .any).matching(identifier: "ops-routing-provider").firstMatch
        XCTAssertTrue(provider.waitForExistence(timeout: 10)); waitForEnabled(provider); provider.tap()
        app.buttons["Grok"].tap()
        let fallback = app.switches["ops-routing-fallback"]
        XCTAssertEqual(fallback.value as? String, "0", "Manual routing must require an explicit fallback opt-in")
        app.descendants(matching: .any).matching(identifier: "ops-routing-model").firstMatch.tap(); app.buttons["Fixture model"].tap()
        app.descendants(matching: .any).matching(identifier: "ops-routing-effort").firstMatch.tap(); app.buttons["High"].tap()
        app.buttons["ops-routing-save"].tap()
        XCTAssertTrue(routing.waitForExistence(timeout: 5))
        XCTAssertTrue(routing.label.contains("Grok"))
        routing.tap()
        XCTAssertTrue(provider.waitForExistence(timeout: 10)); waitForEnabled(provider)
        XCTAssertEqual(provider.value as? String, "Grok")
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "ops-routing-model").firstMatch.value as? String, "Fixture model")
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "ops-routing-effort").firstMatch.value as? String, "High")
        capture(app, "Ops persisted manual routing")
        provider.tap(); app.buttons["Free Router"].tap()
        XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "ops-routing-effort").firstMatch.isEnabled)
        XCTAssertEqual(app.switches["ops-routing-fallback"].value as? String, "0")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "FreeRouter supports text chat")).firstMatch.exists)
        capture(app, "Ops FreeRouter chat routing")
    }
    func testOpsWorkerTimelineAndProviderSubagent() throws {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"]; app.launch()
        guard app.tabBars.buttons["Team"].waitForExistence(timeout: 5) else { throw XCTSkip("Ops worker inspector") }
        app.tabBars.buttons["Team"].tap()
        let worker = app.staticTexts["Export repair"]
        XCTAssertTrue(worker.waitForExistence(timeout: 10)); worker.tap()
        let activity = app.buttons["ops-worker-activity-toggle"]
        scrollTo(activity, in: app); activity.tap()
        XCTAssertEqual(activity.value as? String, "Expanded")
        XCTAssertTrue(app.staticTexts["Checking the export implementation."].waitForExistence(timeout: 10))
        let output = app.buttons["Show output"]
        scrollTo(output, in: app); output.tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "All 12 checks passed")).firstMatch.waitForExistence(timeout: 5))
        capture(app, "Ops structured worker tool output")
        scrollTo(activity, in: app, upward: false); activity.tap()
        let children = app.buttons["ops-subagents"]
        scrollTo(children, in: app); children.tap()
        let child = app.buttons["ops-subagent-child-1"]
        XCTAssertTrue(child.waitForExistence(timeout: 10)); scrollTo(child, in: app); child.tap()
        let childActivity = app.buttons["ops-worker-activity-toggle"]
        XCTAssertTrue(childActivity.waitForExistence(timeout: 5)); childActivity.tap()
        XCTAssertTrue(app.staticTexts["Reviewed empty exports and unicode filenames."].waitForExistence(timeout: 10))
        capture(app, "Ops saved provider subagent activity")
        XCTAssertEqual(app.webViews.count, 0)
    }
    private func waitForEnabled(_ element: XCUIElement) {
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 10), .completed)
    }
    private func scrollTo(_ element: XCUIElement, in app: XCUIApplication, upward: Bool = true) {
        // UIKit can report an invalid activation point for offscreen SwiftUI rows.
        // Scroll from geometry first, then let tap resolve the visible element.
        for _ in 0..<8 {
            if element.exists {
                let frame = element.frame
                let top = app.frame.minY + 130
                let bottom = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.minY - 12 : app.frame.maxY - 125
                if frame.width > 0 && frame.height > 0 && frame.minY >= top && frame.maxY <= bottom { return }
                if frame.height > 0 && frame.midY < top { app.swipeDown(); continue }
            }
            if upward { app.swipeUp() } else { app.swipeDown() }
        }
        XCTAssertTrue(element.exists)
    }
    func testOpsCompanyCreatesWorkWithCompletionChecks() throws {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"]; app.launch()
        guard app.tabBars.buttons["Work"].waitForExistence(timeout: 5) else { throw XCTSkip("Ops work") }
        app.tabBars.buttons["Work"].tap()
        XCTAssertTrue(app.buttons["ops-company-create"].waitForExistence(timeout: 10))
        capture(app, "Ops company overview")
        app.buttons["ops-company-create"].tap()
        fillCompanyField("ops-company-title", with: "Check the release notes", in: app)
        fillCompanyField("ops-company-objective", with: "Prepare accurate release notes", in: app)
        fillCompanyField("ops-company-criteria", with: "Every change is linked to a check", in: app)
        app.buttons["ops-company-create-save"].tap()
        let created = app.buttons["ops-kanban-card-job-2"]
        XCTAssertTrue(created.waitForExistence(timeout: 10)); created.tap()
        XCTAssertTrue(app.staticTexts["ops-company-criterion-0"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["ops-company-criterion-0"].label, "Every change is linked to a check")
        capture(app, "Ops work with completion checks")
    }
    func testOpsCompanyRecordsAnOwnerCheck() throws {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"]; app.launch()
        guard app.tabBars.buttons["Work"].waitForExistence(timeout: 5) else { throw XCTSkip("Ops work review") }
        app.tabBars.buttons["Work"].tap()
        let job = app.buttons["ops-kanban-card-job-1"]
        XCTAssertTrue(job.waitForExistence(timeout: 10)); job.tap()
        XCTAssertTrue(app.staticTexts["Make exports reliable for every project."].waitForExistence(timeout: 10))
        fillCompanyField("ops-work-review-note", with: "Checked an empty export and confirmed the download completed", in: app)
        let approve = app.buttons["ops-work-review-approve"]
        scrollTo(approve, in: app); approve.tap()
        let confirm = app.buttons.matching(identifier: "ops-work-review-confirm").firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        XCTAssertTrue(app.sheets.matching(NSPredicate(format: "label BEGINSWITH %@", "Confirm approve")).firstMatch.exists)
        confirm.tap()
        let reviewState = app.staticTexts["ops-work-review-state"]
        XCTAssertTrue(reviewState.waitForExistence(timeout: 10))
        XCTAssertEqual(reviewState.label, "Review: Approved")
        XCTAssertTrue(app.staticTexts["Checked an empty export and confirmed the download completed"].exists)
        let stage = app.staticTexts["ops-company-current-status"]; scrollTo(stage, in: app, upward: false)
        XCTAssertEqual(stage.label, "To do", "Review must not silently move the card")
        let noRuns = app.staticTexts["No confirmed runs"]; scrollTo(noRuns, in: app)
        XCTAssertTrue(noRuns.exists, "Approval must not start a run")
        capture(app, "Ops owner recorded review")
    }
    func testOpsLegacyWorkRetainsOwnerEvidenceWorkflow() throws {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"]; app.launch()
        guard app.tabBars.buttons["Work"].waitForExistence(timeout: 5) else { throw XCTSkip("Ops legacy evidence") }
        app.tabBars.buttons["Work"].tap()
        let job = app.buttons["ops-kanban-card-job-1"]
        XCTAssertTrue(job.waitForExistence(timeout: 10)); job.tap()
        let history = app.buttons["ops-work-legacy-detail"]
        XCTAssertTrue(history.waitForExistence(timeout: 10)); history.tap()
        XCTAssertTrue(app.buttons["ops-company-more"].waitForExistence(timeout: 10)); app.buttons["ops-company-more"].tap()
        let record = app.buttons.matching(identifier: "ops-company-record-check").firstMatch
        XCTAssertTrue(record.waitForExistence(timeout: 5)); record.tap()
        fillCompanyField("ops-company-check-summary", with: "Checked an empty export and confirmed the download completed", in: app)
        XCTAssertTrue(app.staticTexts["Recorded by you. This is your assessment, not an automated test result."].exists)
        app.buttons["ops-company-action-save"].tap()
        XCTAssertTrue(app.buttons["ops-company-more"].waitForExistence(timeout: 10))
        let check = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Test · Passed")).firstMatch
        XCTAssertTrue(check.waitForExistence(timeout: 10)); scrollTo(check, in: app); check.tap()
        XCTAssertTrue(app.staticTexts["Source: Recorded by you"].waitForExistence(timeout: 10))
        capture(app, "Ops legacy owner evidence")
    }
    private func fillCompanyField(_ identifier: String, with text: String, in app: XCUIApplication) {
        // SwiftUI vertical fields appear lazily and can expose either accessibility type.
        let field = app.descendants(matching: .any).matching(identifier: identifier)
            .matching(NSPredicate(format: "elementType == %d OR elementType == %d", XCUIElement.ElementType.textField.rawValue, XCUIElement.ElementType.textView.rawValue)).firstMatch
        scrollTo(field, in: app)
        XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap(); field.typeText(text)
    }
    func testOpsKanbanMovesAWorkCard() throws {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"]; app.launch()
        guard app.tabBars.buttons["Work"].waitForExistence(timeout: 5) else { throw XCTSkip("Ops board") }
        app.tabBars.buttons["Work"].tap()
        let job = app.buttons["ops-kanban-card-job-1"]
        XCTAssertTrue(job.waitForExistence(timeout: 10)); job.tap()
        let move = app.buttons["ops-work-move"]
        XCTAssertTrue(move.waitForExistence(timeout: 10)); scrollTo(move, in: app); move.tap()
        let destination = app.buttons.matching(identifier: "ops-work-move-to-doing").firstMatch
        XCTAssertTrue(destination.waitForExistence(timeout: 5)); destination.tap()
        let status = app.staticTexts["ops-company-current-status"]
        let moved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "In progress"), object: status)
        XCTAssertEqual(XCTWaiter.wait(for: [moved], timeout: 10), .completed)
        XCTAssertFalse(app.staticTexts["Review: Approved"].exists, "Moving a card must not grant approval")
        XCTAssertTrue(app.staticTexts["No confirmed runs"].exists, "Moving a card must not start a worker")
        capture(app, "Ops acknowledged board move")
    }
    func testOpsWorkRetainsConcurrentMoveConflict() throws {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-work-conflict"]; app.launch()
        guard app.tabBars.buttons["Work"].waitForExistence(timeout: 5) else { throw XCTSkip("Ops board conflict") }
        app.tabBars.buttons["Work"].tap()
        let job = app.buttons["ops-kanban-card-job-1"]
        XCTAssertTrue(job.waitForExistence(timeout: 10))
        let destination = app.buttons.matching(NSPredicate(format: "label == %@", "Move to In progress")).firstMatch
        let pending = app.descendants(matching: .any)["ops-work-outbox"].firstMatch
        // The context menu can still be animating when it first reports the
        // item, and a tap then lands nowhere. Reopen it until the move is sent.
        for _ in 0..<3 where !pending.exists {
            job.press(forDuration: 1)
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND hittable == true"), object: destination)
            guard XCTWaiter.wait(for: [ready], timeout: 5) == .completed else { continue }
            destination.tap()
            _ = pending.waitForExistence(timeout: 5)
        }
        XCTAssertTrue(pending.waitForExistence(timeout: 10)); pending.tap()
        XCTAssertTrue(app.staticTexts["Conflict: Another device moved this card to Needs review."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Dismiss intent"].exists)
        capture(app, "Ops retained move conflict")
    }
    func testOpsWorkOfflineCacheAllowsPlanningButNotDispatch() throws {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-work-offline-after-snapshot"]; app.launch()
        guard app.tabBars.buttons["Work"].waitForExistence(timeout: 5) else { throw XCTSkip("Ops offline work") }
        app.tabBars.buttons["Work"].tap()
        XCTAssertTrue(app.staticTexts["Fixture connection is offline"].waitForExistence(timeout: 10))
        let job = app.buttons["ops-kanban-card-job-1"]
        XCTAssertTrue(job.waitForExistence(timeout: 10)); job.tap()
        XCTAssertTrue(app.staticTexts["Make exports reliable for every project."].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["ops-company-assign"].isEnabled, "Cached work must not imply permission to dispatch offline")
        fillCompanyField("ops-work-comment", with: "Review this plan when connected", in: app)
        // The keyboard accessory bar can cover a row above the keyboard frame.
        let done = app.buttons["ops-work-keyboard-done"]
        XCTAssertTrue(done.waitForExistence(timeout: 5)); done.tap()
        let keyboardHidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
        XCTAssertEqual(XCTWaiter.wait(for: [keyboardHidden], timeout: 5), .completed)
        let save = app.buttons["ops-work-comment-save"]; scrollTo(save, in: app); save.tap()
        let saved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == false"), object: save)
        XCTAssertEqual(XCTWaiter.wait(for: [saved], timeout: 5), .completed, "Saving offline must durably queue the comment and clear its draft")
        let dispatch = app.buttons["ops-company-assign"]
        scrollTo(dispatch, in: app, upward: false)
        XCTAssertTrue(dispatch.exists)
        XCTAssertFalse(dispatch.isEnabled)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.descendants(matching: .any)["ops-work-outbox"].firstMatch.waitForExistence(timeout: 10))
        capture(app, "Ops offline planning")
    }
    func testOpsLiveAgentActivityOpensRealToolDetails() throws {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-live-activity"]; app.launch()
        guard app.tabBars.buttons["Team"].waitForExistence(timeout: 5) else { throw XCTSkip("Ops live activity") }
        let live = app.buttons["ops-live-activity-open"]
        XCTAssertTrue(live.waitForExistence(timeout: 10))
        capture(app, "Ops live assistant presence")
        live.tap()
        XCTAssertTrue(app.navigationBars["Live activity"].waitForExistence(timeout: 5))
        let search = app.textFields["ops-activity-search"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap(); search.typeText("npm test\n")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label == %@", "Running export checks")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["No matching activity"].exists)
        capture(app, "Ops live tool inspector")
        app.buttons["Done"].tap()
        XCTAssertTrue(live.waitForExistence(timeout: 5))
    }
    func testOpsCapacityAtLargeTextSize() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitest-fixtures", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        guard app.tabBars.buttons["Team"].waitForExistence(timeout: 3) else { throw XCTSkip("Ops capacity only") }
        app.tabBars.buttons["Usage"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["ops-provider-codex"].firstMatch.waitForExistence(timeout: 10))
        capture(app, "Ops capacity large text")
        for _ in 0..<12 {
            if app.descendants(matching: .any)["ops-provider-freerouter"].firstMatch.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(app.descendants(matching: .any)["ops-provider-freerouter"].firstMatch.isHittable)
        capture(app, "Ops route capacity large text")
    }
    // MARK: Lakeside Ask

    /// Opens the fixture conversation. Returns false in the Ops app.
    private func openAskConversation(_ app: XCUIApplication) -> Bool {
        if app.tabBars.buttons["Team"].waitForExistence(timeout: 3) { return false }
        let conversation = app.staticTexts["How does inflation work?"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 10)); conversation.tap()
        XCTAssertTrue(app.staticTexts["Prices respond to supply and demand."].waitForExistence(timeout: 10))
        return true
    }
    private func ask(_ text: String, in app: XCUIApplication) {
        let composer = app.textFields["ask-composer"].exists ? app.textFields["ask-composer"] : app.textViews["ask-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5)); composer.tap(); composer.typeText(text)
        app.buttons["Send question"].tap()
    }
    private func allowOutsideAI(_ app: XCUIApplication) {
        let allow = app.buttons["ask-consent-allow"]
        if allow.waitForExistence(timeout: 5) { allow.tap() }
    }
    private func text(containing value: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", value)).firstMatch
    }
    func testAskConsentGateHoldsQuestionsUntilAllowed() throws {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"]; app.launch()
        guard openAskConversation(app) else { throw XCTSkip("Ask consent") }
        ask("What changes prices?", in: app)
        let allow = app.buttons["ask-consent-allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 5), "A server question must wait for permission")
        XCTAssertTrue(text(containing: "DeepSeek", in: app).exists, "Every outside service from /api/me must be listed")
        capture(app, "Ask outside AI consent")
        app.buttons["ask-consent-decline"].tap()
        XCTAssertFalse(app.staticTexts["Verified final answer from the server."].waitForExistence(timeout: 2), "Declining must not send the question")
        app.buttons["Send question"].tap()
        XCTAssertTrue(allow.waitForExistence(timeout: 5)); allow.tap()
        XCTAssertTrue(app.staticTexts["Verified final answer from the server."].waitForExistence(timeout: 10))
        XCTAssertTrue(text(containing: "Verified source", in: app).exists)
        capture(app, "Ask answer with sources")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let settings = app.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10)); settings.tap()
        let status = app.staticTexts["ask-consent-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 10))
        XCTAssertEqual(status.label, "Allowed")
        capture(app, "Ask settings")
        app.buttons["ask-settings-ai-providers"].tap()
        let withdraw = app.buttons["ask-consent-withdraw"]
        XCTAssertTrue(withdraw.waitForExistence(timeout: 5)); withdraw.tap()
        app.buttons["Close"].tap()
        let withdrawn = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "Not allowed"), object: status)
        XCTAssertEqual(XCTWaiter.wait(for: [withdrawn], timeout: 5), .completed)
    }
    func testAskWatchesListAndDelete() throws {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"]; app.launch()
        if app.tabBars.buttons["Team"].waitForExistence(timeout: 3) { throw XCTSkip("Ask watches") }
        let watches = app.buttons["ask-watches"]
        XCTAssertTrue(watches.waitForExistence(timeout: 10))
        capture(app, "Ask home")
        reveal(watches, in: app)
        watches.tap()
        let watch = app.staticTexts["USD/GBP crosses above 1.30"]
        XCTAssertTrue(watch.waitForExistence(timeout: 10))
        XCTAssertTrue(text(containing: "Watch USD/GBP and tell me", in: app).exists)
        capture(app, "Ask watches")
        app.buttons["ask-watch-delete-7"].tap()
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: watch)
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 10), .completed)
        XCTAssertTrue(app.staticTexts["new war activity involving FR"].exists)
    }
    func testAskStopsAStreamingAnswer() throws {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-slow-stream"]; app.launch()
        guard openAskConversation(app) else { throw XCTSkip("Ask stop") }
        ask("What changes prices?", in: app)
        allowOutsideAI(app)
        let stop = app.buttons["Stop answer"]
        XCTAssertTrue(stop.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["A partial draft"].waitForExistence(timeout: 10))
        capture(app, "Ask streaming answer")
        stop.tap()
        XCTAssertTrue(text(containing: "This answer was not saved and used no credits", in: app).waitForExistence(timeout: 10),
                      "The server must confirm the stop before the app says no credits were used")
        XCTAssertTrue(app.buttons["Send question"].waitForExistence(timeout: 5))
        capture(app, "Ask stopped answer")
    }
    func testAskShowsQuotaErrorTruthfully() throws {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-quota"]; app.launch()
        guard openAskConversation(app) else { throw XCTSkip("Ask errors") }
        ask("What changes prices?", in: app)
        allowOutsideAI(app)
        XCTAssertTrue(app.staticTexts["Daily limit reached"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["You've used all 200 questions for today."].exists)
        XCTAssertFalse(text(containing: "sign in again", in: app).exists, "A quota error is not a sign-in problem")
        capture(app, "Ask quota error")
    }
    /// Scrolls until a list row is on screen. Lists create rows lazily.
    private func reveal(_ element: XCUIElement, in app: XCUIApplication, upward: Bool = true) {
        for _ in 0..<6 {
            if element.exists && element.isHittable { return }
            if upward { app.swipeUp() } else { app.swipeDown() }
        }
    }
    private func capture(_ app: XCUIApplication, _ name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = name; screenshot.lifetime = .keepAlways; add(screenshot)
    }
    func testAttachmentMenu() {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures"]; app.launch()
        if !app.tabBars.buttons["Team"].waitForExistence(timeout: 3) {
            let conversation = app.staticTexts["How does inflation work?"]
            XCTAssertTrue(conversation.waitForExistence(timeout: 10)); conversation.tap()
        }
        let add = app.buttons["add-attachment"]
        XCTAssertTrue(add.waitForExistence(timeout: 10)); add.tap()
        XCTAssertTrue(app.buttons["Photo library"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Choose file"].exists)
        capture(app, "Native attachment picker")
    }
    func testNativeSignInAndCancellation() {
        let app = XCUIApplication(); app.launch()
        let signIn = app.buttons["Sign in to Lakeside"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 15))
        XCTAssertEqual(app.webViews.count, 0)
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.lifetime = .keepAlways; add(screenshot)
        signIn.tap()
        let cancel = app.buttons["Cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 10))
        cancel.tap()
        XCTAssertTrue(signIn.waitForExistence(timeout: 5))
        XCTAssertEqual(app.webViews.count, 0)
    }
    func testNativeAskResearchReceipt() throws {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-research"]; app.launch()
        guard openAskConversation(app) else { throw XCTSkip("Ask research receipt") }
        ask("How does inflation work?", in: app)
        allowOutsideAI(app)
        XCTAssertTrue(app.staticTexts["Verified final answer from the server."].waitForExistence(timeout: 10))
        let receipt = app.buttons["ask-research-receipt"]
        XCTAssertTrue(receipt.waitForExistence(timeout: 5), "A finished answer keeps its research receipt")
        reveal(receipt, in: app)
        XCTAssertTrue(text(containing: "Researched 2 steps", in: app).exists)
        capture(app, "Ask research receipt")
        receipt.tap()
        XCTAssertTrue(text(containing: "Searched the source", in: app).waitForExistence(timeout: 5))
        XCTAssertTrue(text(containing: "Looked up the corporation", in: app).exists)
        XCTAssertTrue(text(containing: "5 excerpts from 3 files", in: app).exists)
        capture(app, "Ask research trail expanded")
    }
    func testNativeAskResearchConsoleRuns() throws {
        let app = XCUIApplication(); app.launchArguments = ["--uitest-fixtures", "--uitest-research-live"]; app.launch()
        guard openAskConversation(app) else { throw XCTSkip("Ask research console") }
        ask("How does inflation work?", in: app)
        allowOutsideAI(app)
        let console = app.descendants(matching: .any).matching(identifier: "ask-research-console").firstMatch
        XCTAssertTrue(console.waitForExistence(timeout: 10), "The live console appears while Ask works")
        XCTAssertTrue(text(containing: "Searched the source", in: app).waitForExistence(timeout: 5))
        XCTAssertTrue(text(containing: "Looked up the corporation", in: app).exists)
        capture(app, "Ask live research console")
    }
}
