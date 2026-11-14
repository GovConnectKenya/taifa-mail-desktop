import XCTest
import WebKit
@testable import TaifaMail

final class SecurityFixTests: XCTestCase {
    // 1 and 5: links
    func testLinksLockedMakesLinksInert() {
        XCTAssertEqual(BodyLockdown.decide(navigationType: .linkActivated, url: URL(string: "https://a.example"), linksLocked: true), .cancel)
        XCTAssertEqual(BodyLockdown.decide(navigationType: .linkActivated, url: URL(string: "https://a.example"), linksLocked: false), .openExternally(URL(string: "https://a.example")!))
    }

    func testSchemeAllowlist() {
        for ok in ["http://a.example", "https://a.example", "mailto:a@x.ke"] { XCTAssertTrue(LinkSafety.isAllowed(URL(string: ok)!)) }
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "tel:123", "smb://h/s", "x-apple.systempreferences:", "ftp://h"] { XCTAssertFalse(LinkSafety.isAllowed(URL(string: bad)!), bad) }
        XCTAssertEqual(BodyLockdown.decide(navigationType: .linkActivated, url: URL(string: "ftp://h/x")), .cancel)
    }

    // 10: host display
    func testPunycodeRoundTripAndBothForms() {
        let uni = "m\u{00FC}nchen.example"
        let ascii = Punycode.toASCII(host: uni)
        XCTAssertEqual(ascii, "xn--mnchen-3ya.example")
        XCTAssertEqual(Punycode.toUnicode(host: ascii), uni)
        let a = LinkSafety.assess(URL(string: "https://xn--mnchen-3ya.example/p")!)
        XCTAssertTrue(a.showBothForms); XCTAssertEqual(a.unicodeHost, uni); XCTAssertEqual(a.asciiHost, ascii)
        XCTAssertFalse(LinkSafety.assess(URL(string: "https://plain.example")!).showBothForms)
    }

    func testMixedScriptHostIsFlagged() {
        XCTAssertTrue(LinkSafety.mixesScripts("p\u{0430}ypal.com"))      // Cyrillic a inside Latin
        XCTAssertFalse(LinkSafety.mixesScripts("paypal.com"))
        XCTAssertFalse(LinkSafety.mixesScripts("\u{043F}\u{0440}\u{0438}\u{043C}\u{0435}\u{0440}.example"))   // all Cyrillic label
    }

    func testVisibleTextNamingAnotherHostIsFlagged() {
        XCTAssertTrue(LinkSafety.textNamesOtherHost("www.bank.example", realHost: "evil.example"))
        XCTAssertFalse(LinkSafety.textNamesOtherHost("www.bank.example", realHost: "bank.example"))
        XCTAssertFalse(LinkSafety.textNamesOtherHost("Click here", realHost: "evil.example"))
        let html = #"<p><a href="https://evil.example/x"><b>https://bank.example/login</b></a></p>"#
        let url = URL(string: "https://evil.example/x")!
        let text = LinkSafety.visibleText(for: url, in: html)
        XCTAssertEqual(text, "https://bank.example/login")
        XCTAssertTrue(LinkSafety.assess(url, visibleText: text).textNamesOtherHost)
    }

    // 4: image proxy
    func testRemoteSourcesAndInlining() async {
        let html = #"<img src="https://a.example/1.png"><img src='http://b.example/2.gif'><img src="data:image/png;base64,AA"><img src="https://a.example/1.png">"#
        XCTAssertEqual(ImageProxy.remoteSources(in: html), ["https://a.example/1.png", "http://b.example/2.gif"])
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0])
        let r = await ImageProxy.rewrite(html: html) { $0.hasSuffix("1.png") ? .loaded(png) : .loaded(Data("<svg/>".utf8)) }
        let out = r.html
        XCTAssertTrue(out.contains("data:image/png;base64,"))
        XCTAssertTrue(out.contains("http://b.example/2.gif"), "a non image answer (SVG) is refused and left to the block rule")
        XCTAssertFalse(out.contains("\"https://a.example/1.png\""))
        XCTAssertEqual(r.blocked, 1)
        XCTAssertEqual(ImageProxy.base64URL("https://a.example/x?y=1"), "aHR0cHM6Ly9hLmV4YW1wbGUveD95PTE")
    }

    // 6: notification text
    func testWarnedMessagesRevealNothing() {
        var e = Envelope(uid: 1, folder: "INBOX", subject: "Secret subject", fromName: "Bank", fromAddr: "b@x.ke", date: "", snippet: "secret preview")
        XCTAssertEqual(NotificationText.make(e, showSenderAndSubject: true, showSnippet: false), NotificationText(title: "Bank", subtitle: "Secret subject", body: ""))
        e.authWarned = true
        XCTAssertEqual(NotificationText.make(e, showSenderAndSubject: true, showSnippet: true), NotificationText(title: "New message from Bank", subtitle: "", body: ""))
        e.authLevel = .danger
        XCTAssertEqual(NotificationText.make(e, showSenderAndSubject: true, showSnippet: true), NotificationText(title: "New message", subtitle: "", body: ""))
        e.authLevel = nil; e.authWarned = false
        XCTAssertEqual(NotificationText.make(e, showSenderAndSubject: false, showSnippet: true).title, "New message")
        XCTAssertEqual(NotificationText.make(e, showSenderAndSubject: true, showSnippet: true).body, "secret preview")
    }

    // 7: attachment names
    func testAttachmentNamesLoseBidiControlsAndTrailingDots() {
        XCTAssertEqual(AttachmentSafety.sanitizedName("invoice\u{202E}fdp.exe"), "invoicefdp.exe")
        XCTAssertEqual(AttachmentSafety.sanitizedName("a\u{2066}b\u{2069}.pdf. . "), "ab.pdf")
        XCTAssertEqual(AttachmentSafety.sanitizedName("../x/y:z"), ".._x_y_z")
        XCTAssertEqual(AttachmentSafety.sanitizedName("..."), "attachment")
        for n in ["run.app", "x.command", "x.sh", "x.pkg", "x.dmg", "x.terminal", "x.scpt", "x.jar", "evil.SH"] { XCTAssertTrue(AttachmentSafety.isExecutable(n), n) }
        XCTAssertFalse(AttachmentSafety.isExecutable("report.pdf"))
        XCTAssertTrue(AttachmentSafety.isExecutable("doc.pdf\u{202E}hs.app"), "the disguised extension is still caught")
    }

    func testTempFilesAreQuarantinedAndPurged() throws {
        let url = try AttachmentFiles.write(Data("x".utf8), name: "a\u{202E}b.txt")
        XCTAssertEqual(url.lastPathComponent, "ab.txt")
        let q = try url.resourceValues(forKeys: [.quarantinePropertiesKey]).quarantineProperties
        XCTAssertNotNil(q)
        AttachmentFiles.purge()
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    // 8: avatars
    func testOnlyApiOriginAvatarPathsAreTrusted() {
        let base = URL(string: "https://mail.govconnect.ke")!
        let id = "00000000-0000-4000-8000-000000000001"
        XCTAssertNotNil(AvatarURL.trusted("/v1/avatars/mailbox/\(id).webp?v=3", base: base))
        XCTAssertNotNil(AvatarURL.trusted("/v1/organizations/\(id)/logo", base: base))
        XCTAssertNotNil(AvatarURL.trusted("https://mail.govconnect.ke/v1/avatars/user/\(id).webp", base: base))
        for bad in ["https://evil.example/v1/avatars/mailbox/\(id).webp", "//evil.example/x", "/v1/avatars/mailbox/../x.webp", "/files/a.png", "http://mail.govconnect.ke.evil.example/v1/avatars/user/\(id).webp", "/v1/avatars/mailbox/\(id).png"] {
            XCTAssertNil(AvatarURL.trusted(bad, base: base), bad)
        }
    }
}
