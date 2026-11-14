import XCTest
@testable import TaifaMail

@MainActor
final class ParityFixTests: XCTestCase {
    var dir: URL!
    override func setUp() { dir = FileManager.default.temporaryDirectory.appendingPathComponent("TaifaParity-\(UUID().uuidString)") }
    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    private func store(_ svc: StubService, mutate: (inout ConversationList) -> Void = { _ in }) async -> MailStore {
        var list = Fixture.decode(ConversationList.self, "conversations")
        mutate(&list)
        svc.conversationsResult = list
        let s = MailStore(service: svc, cache: OfflineCache(directory: dir))
        await s.loadFolders(); await s.loadFirstPage()
        return s
    }

    // 1. actions use the folder the list was loaded for
    func testActionsUseTheListedFolderNotLatestFolder() async {
        let svc = StubService()
        let s = await store(svc) { $0.items[0].latest.folder = "Sent" }   // latest message lives in Sent, uids are INBOX uids
        s.perform(.archive, on: [s.rows[0]])
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(svc.batches.first?.2, "INBOX")
        XCTAssertEqual(svc.batches.first?.1, [99, 101])
    }

    func testUndoOfFlagUsesTheSameFolder() async {
        let svc = StubService()
        let s = await store(svc) { $0.items[0].latest.folder = "Sent" }
        s.perform(.flag(true), on: [s.rows[0]])
        try? await Task.sleep(nanoseconds: 300_000_000)
        s.performUndo()
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertTrue(svc.batches.allSatisfy { $0.2 == "INBOX" })
        XCTAssertTrue(svc.batches.contains { $0.0 == .flagged(false) })
    }

    // 5. delete inside Trash is permanent and confirmed
    func testDeleteInTrashAsksThenUsesPermanent() async {
        let svc = StubService()
        let s = await store(svc)
        s.selectFolder("Deleted Items")      // classified as Trash by name
        await s.loadFirstPage()
        let row = s.rows.first
        XCTAssertNotNil(row)
        s.perform(.trash, on: row.map { [$0] })
        XCTAssertNotNil(s.pendingForever); XCTAssertTrue(svc.batches.isEmpty)
        s.confirmForever()
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(svc.batches.first?.0, .permanent)
    }

    // 14. partial results
    func testPartialBatchRefreshesAndReportsCounts() async {
        let svc = StubService()
        svc.batchHandler = { _, u, _ in BatchResult(ok: false, requested: u.count, succeeded: [u[0]], failed: [BatchFailure(uid: u[1], reason: "move_failed")]) }
        let s = await store(svc)
        s.perform(.archive, on: [s.rows[0]])            // uids [99, 101]: one ok, one failed
        try? await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertEqual(s.notice?.text, "Archived 1 of 2")
        XCTAssertEqual(s.rows.count, 2)                  // refreshed from the server, not left half removed
    }

    // 8. a mailbox switch drops stale results
    func testSwitchDropsResultsOfTheOldMailbox() async {
        let slow = StubService(); slow.conversationsDelay = 400_000_000
        let s = MailStore(service: slow, cache: OfflineCache(directory: dir))
        slow.conversationsResult = Fixture.decode(ConversationList.self, "conversations")
        let load = Task { await s.loadFirstPage() }
        try? await Task.sleep(nanoseconds: 100_000_000)
        s.swapService(StubService())
        await load.value
        XCTAssertTrue(s.rows.isEmpty, "rows from the old mailbox must not appear")
        XCTAssertEqual(s.generation, 1)
    }

    // 2/3/6/7 compose
    func testReplyTargetSkipsYourOwnMessages() {
        let a = ThreadMessage(uid: 1, folder: "INBOX", subject: "s", fromName: "A", fromAddr: "a@x.ke")
        let me = ThreadMessage(uid: 2, folder: "INBOX", subject: "s", fromName: "Me", fromAddr: "me@x.ke")
        XCTAssertEqual(ComposeLauncher.replyTarget([a, me], ownAddress: "ME@x.ke")?.uid, 1)
        XCTAssertEqual(ComposeLauncher.replyTarget([me], ownAddress: "me@x.ke")?.uid, 2)
    }

    func testReplyAllNeverEndsWithEmptyToAndExcludesOnlyOwn() {
        let self2 = ThreadMessage(uid: 1, folder: "Sent", subject: "s", fromName: "Me", fromAddr: "me@x.ke", to: ["me@x.ke"])
        let seed = ComposeLauncher.seed(kind: .replyAll, message: self2, ownAddress: "me@x.ke")
        XCTAssertFalse(seed.to.isEmpty)
        let mine = ThreadMessage(uid: 2, folder: "Sent", subject: "s", fromName: "Me", fromAddr: "me@x.ke", to: ["a@x.ke"], cc: ["c@x.ke"])
        let s2 = ComposeLauncher.seed(kind: .replyAll, message: mine, ownAddress: "me@x.ke")
        XCTAssertEqual(s2.to, ["a@x.ke"]); XCTAssertEqual(s2.cc, ["c@x.ke"])
    }

    func testContactsDecodeBareArrayWithEmailObjects() throws {
        let json = #"[{"id":"1","display_name":"Amina","emails":[{"type":"home","value":"b@x.ke","primary":false},{"type":"work","value":"a@x.ke","primary":true}]}]"#
        let c = try Coding.decoder().decode([Contact].self, from: Data(json.utf8))
        XCTAssertEqual(c[0].addresses, ["a@x.ke", "b@x.ke"])      // primary first
    }

    func testScanPollingWaitsForReadyAndRemovesInfectedFiles() async {
        let svc = StubService()
        svc.fileStatuses = [StoredFile(id: "f", filename: "a", mime: nil, sizeBytes: 1, status: "scanning", scanVerdict: nil),
                            StoredFile(id: "f", filename: "a", mime: nil, sizeBytes: 1, status: "ready", scanVerdict: nil)]
        let m = ComposeModel(seed: ComposeSeed(), service: svc, from: "me@x.ke")
        m.attachments = [ComposeAttachment(name: "a", size: 1, state: .scanning, fileId: "f")]
        m.to = ["a@x.ke"]
        XCTAssertFalse(m.canSend, "scanning blocks send")
        await m.awaitScan(attachment: m.attachments[0].id, fileId: "f", name: "a", interval: 0.01)
        XCTAssertEqual(m.attachments[0].state, .ready); XCTAssertTrue(m.canSend); XCTAssertEqual(svc.fileStatusCalls, 2)

        svc.fileStatuses = [StoredFile(id: "g", filename: "b", mime: nil, sizeBytes: 1, status: "infected", scanVerdict: "infected")]
        m.attachments.append(ComposeAttachment(name: "b", size: 1, state: .scanning, fileId: "g"))
        await m.awaitScan(attachment: m.attachments[1].id, fileId: "g", name: "b", interval: 0.01)
        XCTAssertEqual(m.attachments.count, 1); XCTAssertNotNil(m.attachmentError)
    }

    func testPendingRecipientCountsAndCommitsOnSend() async {
        let svc = StubService()
        let m = ComposeModel(seed: ComposeSeed(), service: svc, from: "me@x.ke")
        m.pendingTo = "a@x.ke"
        XCTAssertTrue(m.canSend)
        let ok = await m.send()
        XCTAssertTrue(ok); XCTAssertEqual(svc.sendCalls, 1)
    }

    func testDiscardNeverSavesAndTrashesTheServerDraft() async {
        let svc = StubService()
        let m = ComposeModel(seed: ComposeSeed(), service: svc, from: "me@x.ke")
        m.subject = "hello"
        await m.saveDraft()
        XCTAssertEqual(svc.saveDraftCalls, 1)
        await m.discard()
        XCTAssertEqual(svc.batches.last?.0, .trash)
        await m.saveDraft()
        XCTAssertEqual(svc.saveDraftCalls, 1, "no save after discard")
    }

    func testTimedOutSendIsNotRetriedAndTellsTheUserToCheckSent() async {
        let svc = StubService()
        svc.sendHandler = { throw APIError.transport("timeout") }
        let m = ComposeModel(seed: ComposeSeed(), service: svc, from: "me@x.ke")
        m.to = ["a@x.ke"]
        let ok = await m.send()
        XCTAssertFalse(ok); XCTAssertEqual(svc.sendCalls, 1)
        if case let .unconfirmed(msg) = m.status { XCTAssertTrue(msg.contains("Sent folder")) } else { XCTFail() }
    }

    func testNoSaveAfterSend() async {
        let svc = StubService()
        let m = ComposeModel(seed: ComposeSeed(), service: svc, from: "me@x.ke")
        m.to = ["a@x.ke"]; m.subject = "s"
        _ = await m.send()
        let before = svc.saveDraftCalls
        await m.saveDraft()
        XCTAssertEqual(svc.saveDraftCalls, before)
    }

    // 9/10 settings
    func testAutoReplyDatesAreEastAfricaTimeAndEndInclusive() {
        let d = AutoReplyDates.calendar.date(from: DateComponents(year: 2026, month: 12, day: 24, hour: 15))!
        XCTAssertEqual(AutoReplyDates.start(d), "2026-12-24T00:00:00+03:00")
        XCTAssertEqual(AutoReplyDates.end(d), "2026-12-24T23:59:59+03:00")
        XCTAssertEqual(AutoReplyDates.parse("2026-12-24T23:59:59+03:00"), AutoReplyDates.calendar.date(from: DateComponents(year: 2026, month: 12, day: 24, hour: 23, minute: 59, second: 59)))
    }

    func testDateRangeNeedsBothDatesAndKeepsStoredHtmlWhenUnedited() {
        var v = AutoResponder.empty; v.enabled = true; v.mode = "date_range"
        XCTAssertNotNil(AutoReplyPayload.validate(v, startDate: Date(), endDate: nil))
        XCTAssertNil(AutoReplyPayload.validate(v, startDate: Date(), endDate: Date()))
        var original = AutoResponder.empty; original.html = "<table><tr><td>Rich</td></tr></table>"; original.text = "Rich"
        var edited = original; edited.text = "ignored"
        let out = AutoReplyPayload.prepare(edited, original: original, edited: false, startDate: nil, endDate: nil)
        XCTAssertEqual(out.html, original.html); XCTAssertEqual(out.text, "Rich")
        let out2 = AutoReplyPayload.prepare(edited, original: original, edited: true, startDate: nil, endDate: nil)
        XCTAssertEqual(out2.text, "ignored"); XCTAssertEqual(out2.html, "ignored")
    }

    func testStructuredSignatureIsDetected() throws {
        let json = #"{"signatures":[{"id":"1","block_type":"signature","name":"S","html":"<b>x</b>","text":"","is_default":true,"config":{"layout":"two"}},{"id":"2","block_type":"signature","name":"P","html":"p","config":null}]}"#
        let b = try Coding.decoder().decode(MailBlocks.self, from: Data(json.utf8))
        XCTAssertTrue(b.signatures[0].hasConfig); XCTAssertFalse(b.signatures[1].hasConfig)
        XCTAssertEqual(b.signatures[0].plainText, "x")      // empty text falls back to the HTML
    }

    // 12 realtime
    func testFrameTypeIsReadFromJSONNotSubstrings() {
        XCTAssertEqual(RealtimeClient.frameType(#"{"type":"pong"}"#), "pong")
        XCTAssertNil(RealtimeClient.frameType("not json"))
        XCTAssertEqual(RealtimeClient.frameType(#"{"type":"mailbox_message_new","subject":"pong connected"}"#), "mailbox_message_new")
    }

    // 15 setup gate
    func testSetupFlagsBlockTheMailbox() throws {
        let m = try Coding.decoder().decode(MailboxSession.self, from: Data(#"{"mailbox_id":"1","address":"a@x.ke","must_change_password":true,"needs_recovery_email":false}"#.utf8))
        XCTAssertTrue(m.needsWebSetup)
        let ok = try Coding.decoder().decode(MailboxSession.self, from: Data(#"{"mailbox_id":"1","address":"a@x.ke","must_change_password":false,"needs_recovery_email":false}"#.utf8))
        XCTAssertFalse(ok.needsWebSetup)
        XCTAssertEqual(AuthMessages.onboarding, "Finish setting up this mailbox on the web before signing in here.")
    }

    // 17 offline cache at rest
    func testCacheFilesAreEncryptedExpireAndRotateKeyOnWipe() async throws {
        let cache = OfflineCache(directory: dir, maxAgeDays: 30)
        let w = Fixture.decode(ConversationWindow.self, "conversation_window")
        await cache.saveConversation(w, mailbox: "mb", folder: "INBOX", uid: 101)
        let raw = await cache.rawConversationBytes(mailbox: "mb", folder: "INBOX", uid: 101)
        XCTAssertNotNil(raw)
        XCTAssertNil(raw.flatMap { String(data: $0, encoding: .utf8) }?.range(of: "Budget review"), "no plaintext at rest")
        let k1 = await cache.keyData
        await cache.backdate(mailbox: "mb", folder: "INBOX", uid: 101, by: 31 * 86_400)
        await cache.saveConversation(w, mailbox: "mb", folder: "INBOX", uid: 102)   // a save trims stale files
        let stale = await cache.conversation(mailbox: "mb", folder: "INBOX", uid: 101); XCTAssertNil(stale)
        await cache.clearAll()
        let k2 = await cache.keyData
        XCTAssertNotEqual(k1, k2)
        let fresh = await cache.conversation(mailbox: "mb", folder: "INBOX", uid: 102); XCTAssertNil(fresh)
    }

    func testAWrongKeyReadsAsAMiss() async {
        let a = OfflineCache(directory: dir)
        await a.saveFolders(Fixture.decode([Folder].self, "folders"), mailbox: "mb")
        let b = OfflineCache(directory: dir)   // different random key
        let r = await b.folders(mailbox: "mb"); XCTAssertNil(r)
    }
}

