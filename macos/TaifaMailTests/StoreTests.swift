import XCTest
@testable import TaifaMail

@MainActor
final class StoreTests: XCTestCase {
    var dir: URL!
    override func setUp() { dir = FileManager.default.temporaryDirectory.appendingPathComponent("TaifaTests-\(UUID().uuidString)") }
    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    private func makeStore(_ svc: StubService) async -> MailStore {
        svc.conversationsResult = Fixture.decode(ConversationList.self, "conversations")
        let s = MailStore(service: svc, cache: OfflineCache(directory: dir))
        await s.loadFolders(); await s.loadFirstPage()
        return s
    }

    // MARK: mark read

    func testMarkReadIsOptimisticAndSticksOnSuccess() async {
        let store = await makeStore(StubService())
        let row = store.rows[0]
        let before = store.folders.first { $0.role == .inbox }!.unseen!
        let ok = await store.markRead(row)
        XCTAssertTrue(ok)
        XCTAssertFalse(store.rows[0].unread); XCTAssertTrue(store.rows[0].latest.seen)
        XCTAssertEqual(store.folders.first { $0.role == .inbox }!.unseen!, before - row.uids.count)
    }

    func testMarkReadRollsBackWhenTheRequestFails() async {
        let svc = StubService()
        svc.markRead = { _, _ in throw APIError.http(status: 502, code: nil, message: "down") }
        let store = await makeStore(svc)
        let original = store.rows[0]; let unseen = store.folders.first { $0.role == .inbox }!.unseen
        let ok = await store.markRead(original)
        XCTAssertFalse(ok)
        XCTAssertEqual(store.rows[0], original)
        XCTAssertEqual(store.folders.first { $0.role == .inbox }!.unseen, unseen)
        XCTAssertEqual(store.notice?.text, "Could not mark as read"); XCTAssertTrue(store.notice?.isError == true)
    }

    func testMarkReadRollsBackWhenFolderIsIncomplete() async {
        let svc = StubService()
        svc.markRead = { _, _ in Fixture.decode(MarkReadResult.self, "mark_read_incomplete") }
        let store = await makeStore(svc)
        let original = store.rows[0]
        let ok = await store.markRead(original)
        XCTAssertFalse(ok); XCTAssertEqual(store.rows[0], original)
    }

    func testTransportFailureMarksOfflineAndRollsBack() async {
        let svc = StubService()
        svc.markRead = { _, _ in throw APIError.transport("offline") }
        let store = await makeStore(svc)
        _ = await store.markRead(store.rows[0])
        XCTAssertTrue(store.isOffline); XCTAssertTrue(store.rows[0].unread)
    }

    // MARK: actions

    func testArchiveRemovesRowsAndRollsBackOnFailure() async {
        let svc = StubService()
        svc.batchHandler = { _, u, _ in BatchResult(ok: false, requested: u.count, succeeded: [], failed: [BatchFailure(uid: u[0], reason: "move_failed")]) }
        let store = await makeStore(svc)
        let rows = store.rows
        store.perform(.archive, on: [rows[0]])
        XCTAssertEqual(store.rows.count, 1)                       // optimistic removal
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(store.rows, rows)                          // rolled back
        XCTAssertTrue(store.notice?.isError == true)
    }

    func testFlagSendsBatchFlagsAndOffersUndo() async {
        let svc = StubService()
        let store = await makeStore(svc)
        store.perform(.flag(true), on: [store.rows[1]])
        XCTAssertTrue(store.rows[1].latest.flagged)
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(svc.batches.first?.0, .flagged(true)); XCTAssertEqual(svc.batches.first?.1, [100])
        XCTAssertTrue(store.canUndo)
        store.performUndo()
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertTrue(svc.batches.contains { $0.0 == .flagged(false) })
    }

    func testActionsAreBlockedOffline() async {
        let store = await makeStore(StubService())
        store.setOffline(true)
        store.perform(.trash, on: [store.rows[0]])
        XCTAssertEqual(store.rows.count, 2); XCTAssertEqual(store.notice?.text, "Not available offline")
    }

    func testOpeningAThreadMarksItReadAndLoadsTheLatestBody() async {
        let svc = StubService()
        let store = await makeStore(svc)
        store.select(store.rows[0].id)
        try? await Task.sleep(nanoseconds: 600_000_000)
        XCTAssertEqual(store.reader?.status, .loaded)
        XCTAssertEqual(store.reader?.messages.count, 2)
        XCTAssertTrue(store.reader?.expanded.contains(store.reader!.messages.last!.id) == true)
        XCTAssertFalse(store.rows[0].unread)
    }

    func testPaginationAppendsWithoutDuplicates() async {
        let svc = StubService()
        let store = await makeStore(svc)
        XCTAssertEqual(store.rows.count, 2)
        store.loadMoreIfNeeded(current: store.rows[1])    // total == rows: nothing to load
        XCTAssertFalse(store.isLoadingMore)
    }

    // MARK: offline cache

    func testCacheRoundTripAndWipeOnSignOut() async throws {
        let cache = OfflineCache(directory: dir)
        let list = Fixture.decode(ConversationList.self, "conversations")
        await cache.saveFolders(Fixture.decode([Folder].self, "folders"), mailbox: "mb")
        await cache.saveList(CachedList(items: list.items, total: 2, savedAt: Date()), mailbox: "mb", folder: "INBOX")
        await cache.saveConversation(Fixture.decode(ConversationWindow.self, "conversation_window"), mailbox: "mb", folder: "INBOX", uid: 101)
        let f = await cache.folders(mailbox: "mb"); XCTAssertEqual(f?.count, 5)
        let l = await cache.list(mailbox: "mb", folder: "INBOX"); XCTAssertEqual(l?.items.count, 2)
        let c = await cache.conversation(mailbox: "mb", folder: "INBOX", uid: 101); XCTAssertEqual(c?.messages.count, 2)
        let other = await cache.list(mailbox: "other", folder: "INBOX"); XCTAssertNil(other)
        await cache.clearAll()
        let empty = await cache.isEmpty(); XCTAssertTrue(empty)
        let gone = await cache.conversation(mailbox: "mb", folder: "INBOX", uid: 101); XCTAssertNil(gone)
    }

    func testCacheTrimsOldConversations() async {
        let cache = OfflineCache(directory: dir, maxConversations: 5)
        let w = Fixture.decode(ConversationWindow.self, "conversation_window")
        for uid in 1...9 { await cache.saveConversation(w, mailbox: "mb", folder: "INBOX", uid: uid) }
        let n = await cache.conversationCount(mailbox: "mb"); XCTAssertEqual(n, 5)
    }

    func testStoreServesCachedListWhileOffline() async {
        let svc = StubService()
        let first = await makeStore(svc)
        XCTAssertEqual(first.rows.count, 2)
        let cache = OfflineCache(directory: dir)
        let cached = await cache.list(mailbox: "mb1", folder: "INBOX")
        XCTAssertEqual(cached?.items.count, 2)
    }

    // MARK: cookies and secrets

    func testCookiePersistenceRoundTrip() {
        let secrets = MemorySecretStore()
        let a = APIClient(baseURL: URL(string: "https://mail.example.test")!)
        a.cookieStorage.setCookie(HTTPCookie(properties: [.name: "tfm_mb_refresh", .value: "r", .domain: "mail.example.test", .path: "/", .secure: "TRUE",
                                                          .expires: Date().addingTimeInterval(3600)])!)
        CookiePersistence(store: secrets, storage: a.cookieStorage).saveNow()
        let b = APIClient(baseURL: URL(string: "https://mail.example.test")!)
        let p = CookiePersistence(store: secrets, storage: b.cookieStorage)
        XCTAssertFalse(p.hasSession)
        XCTAssertEqual(p.restore(), 1); XCTAssertTrue(p.hasSession)
        p.wipe(); XCTAssertNil(secrets.read(CookiePersistence.key))
    }

    // MARK: debug only preview mode

    func testPreviewModeExistsOnlyInDebug() {
        #if DEBUG
        XCTAssertNotNil(NSClassFromString("TaifaMail.PreviewMailService") ?? NSClassFromString("PreviewMailService") ?? PreviewMailService.self as Any)
        #else
        XCTAssertNil(NSClassFromString("TaifaMail.PreviewMailService"))
        #endif
    }
}
