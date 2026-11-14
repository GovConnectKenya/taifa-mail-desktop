import XCTest
@testable import TaifaMail

@MainActor
final class ModelTests: XCTestCase {
    func testFolderRolesAndNullCounts() {
        let f = Fixture.decode([Folder].self, "folders")
        XCTAssertEqual(f.map(\.role), [.inbox, .sent, .junk, .trash, .other])
        XCTAssertNil(f[2].unseen)
    }

    func testConversationListDecodesDefaultsAndVerdicts() {
        let l = Fixture.decode(ConversationList.self, "conversations")
        XCTAssertEqual(l.items.count, 2)
        XCTAssertEqual(l.items[0].latest.fromName, "Amina Wanjiru")
        XCTAssertTrue(l.items[0].latest.senderVerified)
        XCTAssertEqual(l.items[1].latest.authLevel, .danger)
        XCTAssertEqual(l.items[1].latest.messageId, "")      // omitted by the server
        XCTAssertNotNil(l.items[0].latest.sentAt)
        XCTAssertNotNil(l.items[1].latest.sentAt)
    }

    func testConversationWindowDecodesShellsAndInlineBody() {
        let w = Fixture.decode(ConversationWindow.self, "conversation_window")
        XCTAssertEqual(w.messages.count, 2)
        XCTAssertFalse(w.messages[0].bodyLoaded)
        let anchor = w.messages[1]
        XCTAssertTrue(anchor.bodyLoaded)
        XCTAssertEqual(anchor.html, "<p>Hello</p>")
        XCTAssertEqual(anchor.attachments.first?.filename, "a.pdf")
        XCTAssertEqual(anchor.authWarning?.level, .warning)
        XCTAssertEqual(anchor.references, "<a0@example.go.ke>")
        XCTAssertEqual(anchor.sentAt, Date(timeIntervalSince1970: 1794986400))
    }

    func testLoginResponses() {
        let two = Fixture.decode(LoginResponse.self, "login_2fa")
        XCTAssertEqual(two.requires2fa, true)
        let ok = Fixture.decode(LoginResponse.self, "login_ok")
        XCTAssertEqual(ok.mailboxId, "11111111-1111-4111-8111-111111111111")
    }

    func testSendBatchMarkReadAvatarResponses() {
        let s = Fixture.decode(SendResult.self, "send_result")
        XCTAssertEqual(s.suppressed, ["bad@example.go.ke"]); XCTAssertEqual(s.refused, [])
        let b = Fixture.decode(BatchResult.self, "batch_partial")
        XCTAssertFalse(b.ok); XCTAssertEqual(b.failed.first?.reason, "move_failed")
        let m = Fixture.decode(MarkReadResult.self, "mark_read_incomplete")
        XCTAssertFalse(m.complete)
        let a = Fixture.decode(AvatarBatchResponse.self, "avatars_batch")
        XCTAssertEqual(a.results["a@x.ke"]?.institution?.logoUrl, "/v1/avatars/org/1.webp")
        XCTAssertEqual(a.results["b@y.ke"]?.urlScope, "platform")
    }

    func testThreadMessageRoundTripsThroughTheCacheCoding() throws {
        let w = Fixture.decode(ConversationWindow.self, "conversation_window")
        let data = try Coding.encoder().encode(w)
        let back = try Coding.decoder().decode(ConversationWindow.self, from: data)
        XCTAssertEqual(back, w)
    }

    func testRealtimeParsing() {
        func p(_ s: String) -> RealtimeEvent { RealtimeEvent.parse(s, activeMailbox: "mb1") }
        XCTAssertEqual(p(#"{"type":"mailbox_message_new","mailbox_id":"mb1","folder":"INBOX"}"#), .newMail)
        XCTAssertEqual(p(#"{"type":"mailbox_message_new","mailbox_id":"other"}"#), .ignored)
        XCTAssertEqual(p(#"{"type":"mailbox_flags_changed","uid":5,"folder":"INBOX","seen":true}"#), .flagsChanged(uid: 5, folder: "INBOX", seen: true, flagged: nil))
        XCTAssertEqual(p(#"{"type":"mailbox_flags_changed","thread":true,"uids":{"INBOX":[1]}}"#), .reconcile)
        XCTAssertEqual(p(#"{"type":"mailbox_message_moved","uid":5,"from_folder":"INBOX","to_folder":"Trash"}"#), .moved(uid: 5, from: "INBOX", to: "Trash"))
        XCTAssertEqual(p(#"{"type":"mailbox_message_deleted","uid":5}"#), .reconcile)   // no folder: never patch a row
        XCTAssertEqual(p(#"{"type":"pong"}"#), .ignored)
        XCTAssertEqual(RealtimeClient.backoff(attempt: 0), 1); XCTAssertEqual(RealtimeClient.backoff(attempt: 20), 60)
    }

    func testTimeFormat() {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "Africa/Nairobi")!
        let now = cal.date(from: DateComponents(year: 2026, month: 11, day: 13, hour: 12))!
        XCTAssertEqual(TimeFormat.short(cal.date(from: DateComponents(year: 2026, month: 11, day: 12, hour: 9)), now: now, calendar: cal), "Yesterday")
        XCTAssertEqual(TimeFormat.short(nil, now: now, calendar: cal), "")
    }

    func testComposeSeedsAndAddresses() {
        let m = ThreadMessage(uid: 1, folder: "INBOX", subject: "Budget", fromName: "Amina", fromAddr: "amina@x.ke", to: ["me@x.ke", "b@x.ke"], cc: ["c@x.ke"],
                              messageId: "<1@x>", references: "<0@x>", text: "line1\nline2")
        let all = ComposeLauncher.seed(kind: .replyAll, message: m, ownAddress: "me@x.ke")
        XCTAssertEqual(all.to, ["amina@x.ke"]); XCTAssertEqual(all.cc, ["b@x.ke", "c@x.ke"])
        XCTAssertEqual(all.subject, "Re: Budget"); XCTAssertEqual(all.references, "<0@x> <1@x>")
        XCTAssertTrue(all.quote.contains("> line1"))
        let fwd = ComposeLauncher.seed(kind: .forward, message: m, ownAddress: "me@x.ke")
        XCTAssertEqual(fwd.subject, "Fwd: Budget"); XCTAssertEqual(fwd.stageUid, 1)
        XCTAssertEqual(ComposeLauncher.seed(kind: .reply, message: ThreadMessage(uid: 1, folder: "INBOX", subject: "Re: Budget", fromName: "", fromAddr: "a@x.ke"), ownAddress: "").subject, "Re: Budget")
        XCTAssertTrue(Address.isValid("a@x.ke")); XCTAssertFalse(Address.isValid("a@x"))
        XCTAssertEqual(Address.parse("a@x.ke, B <b@x.ke>;c@x.ke"), ["a@x.ke", "b@x.ke", "c@x.ke"])
    }
}
