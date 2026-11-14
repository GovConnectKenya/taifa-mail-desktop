import XCTest
@testable import TaifaMail

final class NotificationPolicyTests: XCTestCase {
    private func row(_ uid: Int, from: String = "a@x.ke", seen: Bool = false) -> ConversationSummary {
        let e = Envelope(uid: uid, folder: "INBOX", subject: "s", fromName: "A", fromAddr: from, date: "", seen: seen)
        return ConversationSummary(threadKey: e.id, latest: e, count: 1, unread: !seen, uids: [uid])
    }

    func testFirstLoadRecordsButNeverNotifies() {
        let d = NotificationPolicy.decide(incoming: [row(1), row(2)], known: nil, ownAddress: "me@x.ke")
        XCTAssertTrue(d.notify.isEmpty); XCTAssertEqual(d.knownAfter.count, 2)
    }

    func testNewUnreadMessageNotifiesOnce() {
        let first = NotificationPolicy.decide(incoming: [row(1)], known: nil, ownAddress: "me@x.ke")
        let second = NotificationPolicy.decide(incoming: [row(2), row(1)], known: first.knownAfter, ownAddress: "me@x.ke")
        XCTAssertEqual(second.notify.map(\.uid), [2])
        let third = NotificationPolicy.decide(incoming: [row(2), row(1)], known: second.knownAfter, ownAddress: "me@x.ke")
        XCTAssertTrue(third.notify.isEmpty)
    }

    func testAlreadyReadAndOwnMailDoNotNotify() {
        let d = NotificationPolicy.decide(incoming: [row(5, seen: true), row(6, from: "ME@x.ke"), row(7)], known: [], ownAddress: "me@x.ke")
        XCTAssertEqual(d.notify.map(\.uid), [7])
    }
}
