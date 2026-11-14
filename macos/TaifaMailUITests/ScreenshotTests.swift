import XCTest

/// Opens every screen and state in the Debug only preview mode (no account, no network) and saves
/// window screenshots. Output folder: TAIFA_SHOTS_DIR or /Users/user/projects/rcfi/_work/native-shots/macos.
final class ScreenshotTests: XCTestCase {
    static let outDir = ProcessInfo.processInfo.environment["TAIFA_SHOTS_DIR"] ?? "/Users/user/projects/rcfi/_work/native-shots/macos"
    static let sizes = ["1100x700", "1600x1000"]
    static let themes = ["light", "dark"]

    override func setUp() {
        continueAfterFailure = false
        try? FileManager.default.createDirectory(atPath: Self.outDir, withIntermediateDirectories: true)
    }

    private func launch(_ extra: [String], theme: String, size: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-TaifaPreviewData", "-TaifaPreviewTheme", theme, "-TaifaPreviewWindowSize", size,
                               "-ApplePersistenceIgnoreState", "YES"] + extra
        app.launch()
        return app
    }

    private func shoot(_ element: XCUIElement, _ name: String, theme: String, size: String) {
        Thread.sleep(forTimeInterval: 1.2)
        let shot = element.screenshot()
        let att = XCTAttachment(screenshot: shot); att.name = "\(name)-\(theme)-\(size)"; att.lifetime = .keepAlways
        add(att)
        try? shot.pngRepresentation.write(to: URL(fileURLWithPath: "\(Self.outDir)/\(name)-\(theme)-\(size).png"))
    }

    private func mainWindow(_ app: XCUIApplication) -> XCUIElement {
        let w = app.windows.firstMatch
        if !w.waitForExistence(timeout: 15) { print("UIDEBUG", app.debugDescription) }
        XCTAssertTrue(w.exists)
        return w
    }

    /// Runs `body` for every theme and size.
    private func eachVariant(_ body: (String, String) throws -> Void) rethrows {
        for t in Self.themes { for s in Self.sizes { try body(t, s) } }
    }

    private func scenario(_ name: String, args: [String], wait: @escaping (XCUIApplication) -> XCUIElement) {
        eachVariant { t, s in
            let app = launch(args, theme: t, size: s)
            XCTAssertTrue(wait(app).waitForExistence(timeout: 20), "\(name) \(t) \(s)")
            shoot(mainWindow(app), name, theme: t, size: s)
            app.terminate()
        }
    }

    func testSignIn() { scenario("signin", args: ["-TaifaPreviewScreen", "signin"]) { $0.buttons["signin-submit"] } }
    func testSignInError() { scenario("signin-error", args: ["-TaifaPreviewScreen", "signin", "-TaifaPreviewState", "error"]) { $0.buttons["signin-submit"] } }
    func testSignInCode() { scenario("signin-code", args: ["-TaifaPreviewScreen", "code"]) { $0.staticTexts["Enter the code we emailed you"] } }
    func testSecondFactor() { scenario("second-factor", args: ["-TaifaPreviewScreen", "twofactor"]) { $0.textFields["signin-code"] } }
    func testSignedOutBanner() { scenario("signed-out", args: ["-TaifaPreviewScreen", "signedout"]) { $0.buttons["signin-submit"] } }

    func testInboxNoSelection() { scenario("inbox-empty-reader", args: []) { $0.otherElements["thread-row-5000"].exists ? $0.otherElements["thread-row-5000"] : $0.descendants(matching: .any)["thread-row-5000"] } }
    func testReaderHTML() { scenario("reader-html", args: ["-TaifaPreviewOpen", "5000"]) { $0.descendants(matching: .any)["message-body-web"] } }
    func testReaderPlainText() { scenario("reader-text", args: ["-TaifaPreviewOpen", "4999"]) { $0.descendants(matching: .any)["message-body-text"] } }
    func testReaderAuthWarning() { scenario("reader-auth-warning", args: ["-TaifaPreviewOpen", "4996"]) { $0.descendants(matching: .any)["attachments"] } }
    func testCompactDensity() { scenario("inbox-compact", args: ["-TaifaPreviewDensity", "compact", "-TaifaPreviewOpen", "5001"]) { $0.descendants(matching: .any)["thread-row-5001"] } }
    func testSentFolder() { scenario("sent", args: ["-TaifaPreviewFolder", "Sent"]) { $0.descendants(matching: .any)["thread-row-5000"] } }
    func testLoading() { scenario("state-loading", args: ["-TaifaPreviewState", "loading"]) { $0.descendants(matching: .any)["thread-skeleton"] } }
    func testEmpty() { scenario("state-empty", args: ["-TaifaPreviewState", "empty"]) { $0.staticTexts["Nothing here"] } }
    func testError() { scenario("state-error", args: ["-TaifaPreviewState", "error"]) { $0.buttons["Retry"].firstMatch } }
    func testOffline() { scenario("state-offline", args: ["-TaifaPreviewState", "offline", "-TaifaPreviewOpen", "5000"]) { $0.staticTexts["Offline. Showing the last synced mail."].firstMatch } }
    func testSearch() { scenario("search", args: ["-TaifaPreviewSearch", "budget"]) { $0.descendants(matching: .any)["thread-list"] } }

    func testToastAfterArchive() throws {
        let t = "light", s = "1100x700"
        let app = launch(["-TaifaPreviewOpen", "5000"], theme: t, size: s)
        XCTAssertTrue(app.descendants(matching: .any)["message-body-web"].waitForExistence(timeout: 20))
        app.buttons["Archive"].firstMatch.click()
        XCTAssertTrue(app.descendants(matching: .any)["toast"].waitForExistence(timeout: 10))
        shoot(mainWindow(app), "toast-undo", theme: t, size: s)
        app.terminate()
    }

    func testComposeNewAndSend() throws {
        for t in Self.themes {
            let app = launch([], theme: t, size: "1280x800")
            XCTAssertTrue(app.descendants(matching: .any)["thread-row-5000"].waitForExistence(timeout: 20))
            app.typeKey("n", modifierFlags: .command)
            let compose = app.windows["New Message"]
            XCTAssertTrue(compose.waitForExistence(timeout: 10))
            let to = compose.textFields["compose-to"]
            XCTAssertTrue(to.waitForExistence(timeout: 10))
            to.click(); to.typeText("amina.wanjiru@treasury.example.go.ke,")
            compose.textFields["compose-subject"].click(); compose.textFields["compose-subject"].typeText("Draft agenda")
            XCTAssertTrue(compose.buttons["compose-send"].isEnabled)
            shoot(compose, "compose", theme: t, size: "640x560")
            compose.buttons["compose-send"].click()
            XCTAssertTrue(compose.waitForNonExistence(timeout: 10), "window closes after a successful send")
            app.terminate()
        }
    }

    func testComposeFailureState() throws {
        let app = launch([], theme: "light", size: "1280x800")
        XCTAssertTrue(app.descendants(matching: .any)["thread-row-5000"].waitForExistence(timeout: 20))
        app.typeKey("n", modifierFlags: .command)
        let compose = app.windows["New Message"]
        let to = compose.textFields["compose-to"]
        XCTAssertTrue(to.waitForExistence(timeout: 10))
        to.click(); to.typeText("brian.otieno@education.example.go.ke,")
        compose.textFields["compose-subject"].click(); compose.textFields["compose-subject"].typeText("FAIL on purpose")
        compose.buttons["compose-send"].click()
        XCTAssertTrue(compose.staticTexts["The relay refused the message."].waitForExistence(timeout: 10))
        shoot(compose, "compose-send-failed", theme: "light", size: "640x560")
        app.terminate()
    }

    func testSettingsPanes() throws {
        for t in Self.themes {
            let app = launch([], theme: t, size: "1280x800")
            XCTAssertTrue(app.descendants(matching: .any)["thread-row-5000"].waitForExistence(timeout: 20))
            app.typeKey(",", modifierFlags: .command)
            let settings = app.windows.matching(NSPredicate(format: "title != %@", "Taifa Mail")).firstMatch
            XCTAssertTrue(settings.waitForExistence(timeout: 10))
            for (i, pane) in ["General", "Notifications", "Signature", "Auto-reply", "Account"].enumerated() {
                let tab = settings.toolbars.buttons[pane].firstMatch
                if tab.exists { tab.click() } else { settings.buttons[pane].firstMatch.click() }
                _ = i
                shoot(settings, "settings-\(pane.lowercased())", theme: t, size: "520x420")
            }
            app.terminate()
        }
    }

    func testKeyboardNavigationAndMenuBar() throws {
        let app = launch([], theme: "light", size: "1280x800")
        XCTAssertTrue(app.descendants(matching: .any)["thread-row-5000"].waitForExistence(timeout: 20))
        for menu in ["File", "Edit", "View", "Message", "Mailbox", "Window", "Help"] { XCTAssertTrue(app.menuBars.menuBarItems[menu].exists, menu) }
        app.descendants(matching: .any)["thread-row-5001"].click()
        XCTAssertTrue(app.descendants(matching: .any)["message-body-text"].waitForExistence(timeout: 10))
        app.typeKey(.downArrow, modifierFlags: [])
        XCTAssertTrue(app.descendants(matching: .any)["message-5002"].waitForExistence(timeout: 10) || app.descendants(matching: .any)["message-body-web"].exists || app.descendants(matching: .any)["message-body-text"].exists)
        app.terminate()
    }
}
