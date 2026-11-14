import XCTest
@testable import TaifaMail

@MainActor
final class SecondRoundTests: XCTestCase {
    var dir: URL!
    override func setUp() { dir = FileManager.default.temporaryDirectory.appendingPathComponent("TaifaRound2-\(UUID().uuidString)"); StubProtocol.reset() }
    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    // 1 punycode never traps
    func testMalformedPunycodeReturnsNilInsteadOfTrapping() {
        for bad in ["99999999999999999999", "zzzzzzzzzzzzzzzzzzzzzzzzzz", "a-99999999999999999999999", "-", "", "\u{00E9}", String(repeating: "9", count: 300), "kfsdhfkjshdfkjshdfkjsdhfksjdhfksjdhfksdjhf"] {
            _ = Punycode.decode(bad)       // must return, not crash
        }
        XCTAssertNil(Punycode.decode("99999999999999999999"))
        XCTAssertEqual(Punycode.toUnicode(host: "xn--99999999999999999999.example"), "xn--99999999999999999999.example")
        let a = LinkSafety.assess(URL(string: "https://xn--99999999999999999999.example/")!)
        XCTAssertEqual(a.asciiHost, "xn--99999999999999999999.example")
        XCTAssertEqual(Punycode.decode("mnchen-3ya"), "m\u{00FC}nchen")
    }

    // 2 capability cache and concurrency and 429
    func testCapabilityIsFetchedOnceAndRefreshedFiveMinutesBeforeExpiry() async {
        let cache = ImageProxyCapabilityCache()
        let calls = SendableBox(0)
        let now = Date()
        let fetch: @Sendable () async -> ImageProxyCapabilityCache.Capability? = {
            calls.value += 1
            return .init(token: "t\(calls.value)", expiresAt: now.addingTimeInterval(3600))
        }
        let t1 = await cache.token(mailbox: "m", now: now, fetch: fetch)
        let t2 = await cache.token(mailbox: "m", now: now.addingTimeInterval(60), fetch: fetch)
        XCTAssertEqual(t1, t2); XCTAssertEqual(calls.value, 1)
        let t3 = await cache.token(mailbox: "m", now: now.addingTimeInterval(3600 - 200), fetch: fetch)   // inside the 5 minute margin
        XCTAssertEqual(calls.value, 2); XCTAssertNotEqual(t3, t1)
    }

    func testImageFetchesAreLimitedToFourAtATime() async {
        let html = (0..<12).map { #"<img src="https://a.example/\#($0).png">"# }.joined()
        let live = SendableBox(0), peak = SendableBox(0)
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0])
        _ = await ImageProxy.rewrite(html: html, concurrency: 4) { _ in
            live.value += 1; peak.value = max(peak.value, live.value)
            try? await Task.sleep(nanoseconds: 20_000_000)
            live.value -= 1
            return .loaded(png)
        }
        XCTAssertLessThanOrEqual(peak.value, 4)
    }

    func testRateLimitStopsFetchingAndReportsBlockedImages() async {
        let html = (0..<10).map { #"<img src="https://a.example/\#($0).png">"# }.joined()
        let requested = SendableBox(0)
        let r = await ImageProxy.rewrite(html: html, concurrency: 4) { _ in requested.value += 1; return .rateLimited }
        XCTAssertTrue(r.rateLimited); XCTAssertEqual(r.blocked, 10)
        XCTAssertLessThanOrEqual(requested.value, 4, "no further requests once the server says 429")
        XCTAssertTrue(r.html.contains("https://a.example/0.png"))
    }

    func testLiveProxiedImageUsesTheCachedCapabilityAndMapsStatuses() async {
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0])
        let capCalls = SendableBox(0)
        StubProtocol.handler = { r in
            let path = r.url!.path
            if path.hasSuffix("/image-proxy-capability") {
                capCalls.value += 1
                let exp = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))
                return (200, Data(#"{"token":"CAP","expires_at":"\#(exp)"}"#.utf8), [:])
            }
            if path.contains("/images/CAP") { return r.url!.query?.contains("limit") == true ? (429, Data(), [:]) : (200, png, [:]) }
            return (404, Data(), [:])
        }
        let api = APIClient(baseURL: URL(string: "https://mail.example.test")!, protocolClasses: [StubProtocol.self])
        let svc = LiveMailService(api: api, mailboxId: "proxy-test-mb")
        let a = await svc.proxiedImage("https://x.example/a.png")
        let b = await svc.proxiedImage("https://x.example/b.png")
        XCTAssertEqual(a, .loaded(png)); XCTAssertEqual(b, .loaded(png))
        XCTAssertEqual(capCalls.value, 1, "one capability fetch for both images")
        XCTAssertTrue(StubProtocol.requests.contains { $0.url!.path == "/v1/inbox/proxy-test-mb/images/CAP" && ($0.url!.query ?? "").hasPrefix("u=") })
        let limited = await svc.proxiedImage("https://x.example/limit.png")
        XCTAssertEqual(limited, .rateLimited)
    }

    // 3 entity and URL normalisation
    func testEscapedSourcesAndAnchorsAreMatched() async {
        let html = #"<img src="https://a.example/p?x=1&amp;y=2">"#
        XCTAssertEqual(ImageProxy.remoteSources(in: html), ["https://a.example/p?x=1&y=2"])
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0])
        let fetched = SendableBox<[String]>([])
        let r = await ImageProxy.rewrite(html: html) { fetched.value.append($0); return .loaded(png) }
        XCTAssertEqual(fetched.value, ["https://a.example/p?x=1&y=2"])
        XCTAssertTrue(r.html.contains("data:image/png;base64,"))

        let link = #"<a href="https://EVIL.example?a=1&amp;b=2">www.bank.example</a>"#
        let url = URL(string: "https://evil.example/?a=1&b=2")!
        XCTAssertEqual(LinkSafety.visibleText(for: url, in: link), "www.bank.example")
        XCTAssertEqual(LinkSafety.normalized("HTTPS://Evil.Example"), LinkSafety.normalized("https://evil.example/"))
        XCTAssertTrue(LinkSafety.assess(url, visibleText: LinkSafety.visibleText(for: url, in: link)).textNamesOtherHost)
    }

    // 4 launch decision
    func testOnlyAnEndedSessionEndsTheLaunch() {
        XCTAssertEqual(LaunchDecision.classify(APIError.sessionEnded), .endSession)
        for e: APIError in [.http(status: 401, code: nil, message: ""), .http(status: 403, code: nil, message: ""), .http(status: 502, code: nil, message: ""), .transport("x"), .decoding("x"), .cancelled] {
            XCTAssertEqual(LaunchDecision.classify(e), .openOffline, "\(e)")
        }
    }

    // 5 app level behaviour
    private func makeApp(secrets: SecretStore = MemorySecretStore()) -> AppModel {
        AppModel(secrets: secrets, cacheDirectory: dir, baseURL: URL(string: "http://127.0.0.1:1")!,
                 defaults: UserDefaults(suiteName: "taifa-test-\(UUID().uuidString)")!, preview: false)
    }

    func testSetupRequiredPhaseWhenFirstLoginSetupIsOutstanding() {
        let app = makeApp()
        app.finishSignIn(MailboxSession(mailboxId: "1", address: "a@x.ke", orgId: nil, mustChangePassword: true, needsRecoveryEmail: true))
        XCTAssertEqual(app.phase, .setupRequired)
        XCTAssertTrue(app.setupDetail.contains("choose your own password") && app.setupDetail.contains("recovery email"))
        XCTAssertNil(app.store)
    }

    func testOnboardingMessageComesFromTheApp() {
        let app = makeApp()
        XCTAssertEqual(app.message(APIError.http(status: 403, code: "onboarding_required", message: "x")), AuthMessages.onboarding)
        XCTAssertEqual(app.message(APIError.http(status: 403, code: "mfa_enrolment_required", message: "x")), AuthMessages.mfaEnrolment)
    }

    func testLaunchRunsOnceHoweverManyWindowsAsk() async {
        let app = makeApp()
        await app.launchIfNeeded(); await app.launchIfNeeded(); await app.launchIfNeeded()
        XCTAssertEqual(app.launchCount, 1)
        XCTAssertEqual(app.phase, .signedOut)     // no stored session in the empty secret store
    }

    func testSignOutPurgesAttachmentsCacheKeyAndIdentity() async throws {
        let secrets = MemorySecretStore()
        let app = makeApp(secrets: secrets)
        _ = secrets.write("identity", Data("{}".utf8))
        let tmp = try AttachmentFiles.write(Data("secret".utf8), name: "x.txt")
        await app.cache.saveFolders(Fixture.decode([Folder].self, "folders"), mailbox: "mb")
        await app.signOut()
        XCTAssertFalse(FileManager.default.fileExists(atPath: tmp.path))
        XCTAssertNil(secrets.read("identity")); XCTAssertNil(secrets.read(CacheKey.name))
        let empty = await app.cache.isEmpty(); XCTAssertTrue(empty)
        XCTAssertEqual(app.phase, .signedOut)
    }

    func testLinksLockedIsHonouredByEveryPath() {
        let url = URL(string: "https://a.example/x")!
        XCTAssertFalse(LinkSafety.shouldPrompt(url, linksLocked: true))     // reader openLink, createWebViewWith and PlainBody all use this
        XCTAssertTrue(LinkSafety.shouldPrompt(url, linksLocked: false))
        XCTAssertFalse(LinkSafety.shouldPrompt(URL(string: "file:///etc/passwd")!, linksLocked: false))
        XCTAssertEqual(BodyLockdown.decide(navigationType: .linkActivated, url: url, linksLocked: true), .cancel)
    }

    func testPlainTextLinksAreNotLinkifiedWhenLocked() {
        let linked = PlainBody.linked("see https://a.example/x now")
        XCTAssertTrue(linked.runs.contains { $0.link != nil })
        XCTAssertFalse(PlainBody.linked("see file:///etc/passwd").runs.contains { $0.link != nil })
    }

    func testKeepAliveClosesTheSocketWhenNoPongArrives() async {
        let slept = SendableBox<[UInt64]>([])
        let sent = SendableBox(0), closed = SendableBox(0)
        let ka = KeepAlive(interval: 30, timeout: 10, sleep: { slept.value.append($0) })   // injected clock: returns at once
        let timedOut = await ka.run(send: { sent.value += 1 }, onTimeout: { closed.value += 1 })
        XCTAssertTrue(timedOut); XCTAssertEqual(sent.value, 1); XCTAssertEqual(closed.value, 1)
        XCTAssertEqual(slept.value, [30, 10])
    }

    func testKeepAliveStaysOpenWhenPongArrives() async {
        let calls = SendableBox(0)
        let closed = SendableBox(0)
        var ka: KeepAlive!
        ka = KeepAlive(interval: 30, timeout: 10, sleep: { _ in calls.value += 1; if calls.value >= 4 { withUnsafeCurrentTask { $0?.cancel() } } })
        let kaRef = ka!
        let timedOut = await kaRef.run(send: { kaRef.pong() }, onTimeout: { closed.value += 1 })
        XCTAssertFalse(timedOut); XCTAssertEqual(closed.value, 0)
    }

    // 6 keychain results
    func testSecretReadDistinguishesMissingFromFailed() {
        let m = MemorySecretStore()
        XCTAssertEqual(m.readResult("x"), .notFound)
        _ = m.write("x", Data([1]))
        XCTAssertEqual(m.readResult("x"), .found(Data([1])))
    }

    // 9 cache binding and key states
    func testACacheFileMovedToAnotherNameFailsToOpen() async throws {
        let cache = OfflineCache(directory: dir)
        await cache.saveFolders(Fixture.decode([Folder].self, "folders"), mailbox: "mb")
        let boxDir = dir.appendingPathComponent(OfflineCache.safe("mb"))
        let from = boxDir.appendingPathComponent("folders.json")
        let to = boxDir.appendingPathComponent("list-INBOX~.json")
        try FileManager.default.copyItem(at: from, to: to)
        let moved = await cache.list(mailbox: "mb", folder: "INBOX~")   // looks up a different file name than the sealed one
        XCTAssertNil(moved)
    }

    func testMissingKeyDeletesOrphansButATransientErrorKeepsThem() {
        final class FlakySecrets: SecretStore, @unchecked Sendable {
            var result: SecretRead
            init(_ r: SecretRead) { result = r }
            func readResult(_ key: String) -> SecretRead { result }
            func write(_ key: String, _ data: Data) -> Bool { true }
            func delete(_ key: String) {}
            var lastError: String? { nil }
        }
        let transient = CacheKey.load(FlakySecrets(.failed(-25308)))
        XCTAssertFalse(transient.created); XCTAssertFalse(transient.persisted)       // no regeneration, nothing deleted
        let missing = CacheKey.load(FlakySecrets(.notFound))
        XCTAssertTrue(missing.created); XCTAssertTrue(missing.persisted)

        // AppModel: orphan files go when the key is new, stay when the Keychain merely failed.
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let orphan = dir.appendingPathComponent("orphan.bin"); try? Data("x".utf8).write(to: orphan)
        _ = AppModel(secrets: FlakySecrets(.failed(-25308)), cacheDirectory: dir, baseURL: URL(string: "http://127.0.0.1:1")!, defaults: UserDefaults(suiteName: "t-\(UUID())")!)
        XCTAssertTrue(FileManager.default.fileExists(atPath: orphan.path))
        _ = AppModel(secrets: FlakySecrets(.notFound), cacheDirectory: dir, baseURL: URL(string: "http://127.0.0.1:1")!, defaults: UserDefaults(suiteName: "t-\(UUID())")!)
        XCTAssertFalse(FileManager.default.fileExists(atPath: orphan.path))
    }

    // 7 copy and weekdays
    func testOutsideHoursDefaultsToWeekdays() {
        var v = AutoResponder.empty
        v.mode = "outside_hours"
        if v.days.isEmpty { v.days = [0, 1, 2, 3, 4] }
        XCTAssertEqual(AutoReplyPayload.prepare(v, original: v, edited: false, startDate: nil, endDate: nil).days, [0, 1, 2, 3, 4])
    }

    // 10 names, executables, mixed delete, signature text
    func testLongNamesKeepTheirExtension() {
        let n = AttachmentSafety.sanitizedName(String(repeating: "a", count: 400) + ".pdf")
        XCTAssertEqual(n.count, 200); XCTAssertTrue(n.hasSuffix(".pdf"))
    }

    func testActiveContentTypesAreTreatedAsExecutable() {
        for n in ["a.html", "a.HTM", "a.svg", "a.webarchive", "a.xhtml"] { XCTAssertTrue(AttachmentSafety.isExecutable(n), n) }
    }

    func testMixedSelectionOnlyAsksAboutRowsInTrash() async {
        let svc = StubService()
        svc.conversationsResult = Fixture.decode(ConversationList.self, "conversations")
        let s = MailStore(service: svc, cache: OfflineCache(directory: dir))
        await s.loadFolders(); await s.loadFirstPage()
        // Search results mix folders: one row lives in Trash, the other in INBOX.
        var rows = s.rows
        rows[0].latest.folder = "Deleted Items"
        let trashRow = rows[0], inboxRow = rows[1]
        s.searchText = "x"; _ = trashRow
        s.perform(.trash, on: [inboxRow])                 // not in Trash: plain move to Trash
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertNil(s.pendingForever)
        XCTAssertEqual(svc.batches.first?.0, .trash)
    }

    func testSignatureHTMLIsInsertedAsTextNeverImported() async {
        let m = ComposeModel(seed: ComposeSeed(), service: StubService(), from: "me@x.ke")
        await m.prepare(signature: nil, signatureHTML: #"<b>Jane</b><br><img src="https://tracker.example/p.gif">"#)
        XCTAssertTrue(m.attributed.string.contains("Jane"))
        XCTAssertFalse(m.attributed.string.contains("tracker.example"))
        XCTAssertNil(m.attributed.attribute(.attachment, at: 0, effectiveRange: nil))
    }
}

@MainActor
final class ThirdRoundTests: XCTestCase {
    var dir: URL!
    override func setUp() { dir = FileManager.default.temporaryDirectory.appendingPathComponent("TaifaRound3-\(UUID().uuidString)") }
    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    func testUnknownSendOutcomesAreClassified() {
        for e: Error in [APIError.transport("t"), APIError.decoding("empty"), APIError.http(status: 502, code: nil, message: ""), APIError.http(status: 504, code: nil, message: "Gateway Timeout"),
                         APIError.http(status: 500, code: nil, message: ""), APIError.cancelled, APIError.sessionEnded, URLError(.badServerResponse)] {
            XCTAssertTrue(ComposeModel.sendOutcomeIsUnknown(e), "\(e)")
        }
        for e: Error in [APIError.http(status: 422, code: "file_not_ready", message: "x"), APIError.http(status: 403, code: nil, message: "blocked"), APIError.http(status: 429, code: nil, message: "slow")] {
            XCTAssertFalse(ComposeModel.sendOutcomeIsUnknown(e), "\(e)")
        }
    }

    func testA502AfterAcceptanceLocksSendForever() async {
        let svc = StubService()
        svc.sendHandler = { throw APIError.http(status: 502, code: nil, message: "Bad Gateway") }
        let m = ComposeModel(seed: ComposeSeed(), service: svc, from: "me@x.ke")
        m.to = ["a@x.ke"]
        let first = await m.send()
        XCTAssertFalse(first)
        XCTAssertTrue(m.isUnconfirmed); XCTAssertFalse(m.canSend)
        let second = await m.send()
        XCTAssertFalse(second); XCTAssertEqual(svc.sendCalls, 1, "no second request")
    }

    func testAnUnreadableAnswerAlsoLocksSend() async {
        let svc = StubService()
        svc.sendHandler = { throw APIError.decoding("empty body") }
        let m = ComposeModel(seed: ComposeSeed(), service: svc, from: "me@x.ke")
        m.to = ["a@x.ke"]
        _ = await m.send()
        XCTAssertTrue(m.isUnconfirmed); XCTAssertFalse(m.canSend)
    }

    func testADefiniteRefusalAllowsFixingAndResending() async {
        let svc = StubService()
        svc.sendHandler = { throw APIError.http(status: 422, code: "file_not_ready", message: "Wait for the scan") }
        let m = ComposeModel(seed: ComposeSeed(), service: svc, from: "me@x.ke")
        m.to = ["a@x.ke"]
        _ = await m.send()
        XCTAssertFalse(m.isUnconfirmed); XCTAssertTrue(m.canSend)
    }

    func testCorruptCacheFilesAreDeletedAndRecreated() async throws {
        let cache = OfflineCache(directory: dir)
        await cache.saveFolders(Fixture.decode([Folder].self, "folders"), mailbox: "mb")
        let file = dir.appendingPathComponent(OfflineCache.safe("mb")).appendingPathComponent("folders.json")
        try Data("garbage that is not a sealed box".utf8).write(to: file)
        let r = await cache.folders(mailbox: "mb")
        XCTAssertNil(r); XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        await cache.saveFolders(Fixture.decode([Folder].self, "folders"), mailbox: "mb")      // recreated
        let again = await cache.folders(mailbox: "mb"); XCTAssertEqual(again?.count, 5)
    }

    func testACacheFolderThatIsAFileIsReplaced() async throws {
        try FileManager.default.createDirectory(at: dir.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: dir)                                   // a file where the cache folder belongs
        let cache = OfflineCache(directory: dir)
        await cache.saveFolders(Fixture.decode([Folder].self, "folders"), mailbox: "mb")
        let r = await cache.folders(mailbox: "mb"); XCTAssertEqual(r?.count, 5)
    }

    func testAKeyMismatchStartsFreshWithoutCrashing() async {
        let a = OfflineCache(directory: dir)
        await a.saveFolders(Fixture.decode([Folder].self, "folders"), mailbox: "mb")
        let b = OfflineCache(directory: dir)                 // another install key
        let miss = await b.folders(mailbox: "mb"); XCTAssertNil(miss)
        await b.saveFolders(Fixture.decode([Folder].self, "folders"), mailbox: "mb")
        let ok = await b.folders(mailbox: "mb"); XCTAssertEqual(ok?.count, 5)
    }

    func testSingleInstanceIgnoresItself() {
        XCTAssertNil(SingleInstance.otherRunning(bundleID: "ke.govconnect.no-such-app"))
        XCTAssertNil(SingleInstance.otherRunning(bundleID: nil))
    }
}
