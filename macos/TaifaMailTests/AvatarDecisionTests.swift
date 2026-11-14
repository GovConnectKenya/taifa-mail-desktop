import XCTest
@testable import TaifaMail

final class AvatarDecisionTests: XCTestCase {
    let photo = AvatarEntry(url: "/p.webp", name: "A", urlScope: nil, institution: nil)
    let platformPhoto = AvatarEntry(url: "/p.webp", name: "A", urlScope: "platform", institution: nil)
    let logo = AvatarEntry(url: nil, name: nil, urlScope: nil, institution: InstitutionLogo(name: "Org", logoUrl: "/l.png"))
    let clean = MessageAuthState()
    let verified = MessageAuthState(senderVerified: true)

    func testPendingWhenNoEntry() { XCTAssertTrue(AvatarDecision.picture(entry: nil, message: clean).pending) }

    func testOwnWorkspacePhotoShownUnlessWarned() {
        XCTAssertEqual(AvatarDecision.picture(entry: photo, message: clean).kind, .photo)
        XCTAssertEqual(AvatarDecision.picture(entry: photo, message: MessageAuthState(authLevel: .warning)).kind, .none)
        XCTAssertEqual(AvatarDecision.picture(entry: photo, message: MessageAuthState(authWarned: true)).kind, .none)
        XCTAssertEqual(AvatarDecision.picture(entry: photo, message: MessageAuthState(hasAuthWarning: true)).kind, .none)
    }

    func testCrossInstitutionPhotoNeedsVerification() {
        XCTAssertEqual(AvatarDecision.picture(entry: platformPhoto, message: clean).kind, .none)
        XCTAssertEqual(AvatarDecision.picture(entry: platformPhoto, message: verified).kind, .photo)
    }

    func testLogoOnlyWhenVerifiedAndNoPhotoAndNoWarning() {
        XCTAssertEqual(AvatarDecision.picture(entry: logo, message: clean).kind, .none)
        XCTAssertEqual(AvatarDecision.picture(entry: logo, message: verified).kind, .logo)
        XCTAssertEqual(AvatarDecision.picture(entry: logo, message: MessageAuthState(authWarned: true, senderVerified: true)).kind, .none)
        var both = logo; both.url = "/p.webp"
        XCTAssertEqual(AvatarDecision.picture(entry: both, message: verified).kind, .photo)   // photo wins
    }

    func testSentShowsRecipientWithoutTrustRules() {
        XCTAssertEqual(AvatarDecision.picture(entry: platformPhoto, message: MessageAuthState(authLevel: .danger), outgoing: true).kind, .photo)
        XCTAssertEqual(AvatarDecision.picture(entry: logo, message: clean, outgoing: true).kind, .logo)
        XCTAssertEqual(AvatarDecision.picture(entry: AvatarEntry(url: nil, name: nil, urlScope: nil, institution: nil), message: nil, outgoing: true).kind, .none)
    }

    func testPlaceholderColourIsDeterministicAndCaseInsensitive() {
        XCTAssertEqual(AvatarDecision.colorIndex(for: "A@x.ke"), AvatarDecision.colorIndex(for: "a@x.ke"))
        XCTAssertTrue((0..<8).contains(AvatarDecision.colorIndex(for: "zz@x.ke")))
        XCTAssertEqual(AvatarDecision.initial(name: "", address: "brian@x.ke"), "B")
    }
}
