import XCTest
import WebKit
@testable import TaifaMail

@MainActor
final class BodyLockdownTests: XCTestCase {
    func testConfigurationIsLockedDown() async {
        let rules = await BodyLockdown.compileRules()
        XCTAssertNotNil(rules, "the remote block rules must compile")
        let c = BodyLockdown.makeConfiguration(ruleList: rules, allowRemoteImages: false)
        XCTAssertFalse(c.defaultWebpagePreferences.allowsContentJavaScript)
        XCTAssertFalse(c.websiteDataStore.isPersistent)
        XCTAssertFalse(c.preferences.javaScriptCanOpenWindowsAutomatically)
        XCTAssertEqual(c.mediaTypesRequiringUserActionForPlayback, .all)
    }

    func testRulesBlockAllHttpAndHttps() throws {
        let json = try JSONSerialization.jsonObject(with: Data(BodyLockdown.blockAllRemoteRulesJSON.utf8)) as! [[String: Any]]
        XCTAssertEqual(json.count, 1)
        XCTAssertEqual((json[0]["action"] as! [String: String])["type"], "block")
        XCTAssertEqual((json[0]["trigger"] as! [String: String])["url-filter"], "^https?://")
    }

    func testRemoteImagesStayJavaScriptFree() async {
        let c = BodyLockdown.makeConfiguration(ruleList: await BodyLockdown.compileRules(), allowRemoteImages: true)
        XCTAssertFalse(c.defaultWebpagePreferences.allowsContentJavaScript)
        XCTAssertFalse(c.websiteDataStore.isPersistent)
    }

    func testNavigationPolicy() {
        XCTAssertEqual(BodyLockdown.decide(navigationType: .other, url: URL(string: "about:blank")), .allow)
        XCTAssertEqual(BodyLockdown.decide(navigationType: .other, url: URL(string: "https://evil.example")), .cancel)
        XCTAssertEqual(BodyLockdown.decide(navigationType: .linkActivated, url: URL(string: "https://a.example/x")), .openExternally(URL(string: "https://a.example/x")!))
        XCTAssertEqual(BodyLockdown.decide(navigationType: .linkActivated, url: URL(string: "javascript:alert(1)")), .cancel)
        XCTAssertEqual(BodyLockdown.decide(navigationType: .linkActivated, url: URL(string: "file:///etc/passwd")), .cancel)
        XCTAssertEqual(BodyLockdown.decide(navigationType: .formSubmitted, url: URL(string: "https://a.example")), .cancel)
        XCTAssertEqual(BodyLockdown.decide(navigationType: .backForward, url: nil), .cancel)
    }

    func testDocumentCSPBlocksScriptAndRemoteImagesByDefault() {
        let blocked = BodyLockdown.document(html: "<p>x</p>", allowRemoteImages: false)
        XCTAssertTrue(blocked.contains("script-src 'none'")); XCTAssertTrue(blocked.contains("img-src data: cid:;"))
        XCTAssertFalse(blocked.contains("https:"))
        XCTAssertTrue(BodyLockdown.document(html: "", allowRemoteImages: true).contains("img-src data: cid: https: http:"))
    }

    func testRemoteContentDetection() {
        XCTAssertTrue(BodyLockdown.hasRemoteContent(#"<img src="https://x.example/a.png">"#))
        XCTAssertFalse(BodyLockdown.hasRemoteContent(#"<img src="data:image/png;base64,AAAA"><a href="https://x.example">l</a>"#))
    }

    func testLinkCheckShowsTheRealHost() {
        let c = BodyLockdown.linkCheck(URL(string: "https://Xn--e1afmkfd.example/path")!)
        XCTAssertEqual(c.rawHost, "xn--e1afmkfd.example"); XCTAssertTrue(c.isUnicodeHost)
    }

    /// The loaded page cannot run scripts: a script in the body must not execute.
    func testScriptInBodyDoesNotRun() async throws {
        let rules = await BodyLockdown.compileRules()
        let web = WKWebView(frame: .zero, configuration: BodyLockdown.makeConfiguration(ruleList: rules, allowRemoteImages: false))
        let loaded = expectation(description: "loaded")
        final class D: NSObject, WKNavigationDelegate { var done: () -> Void = {}; func webView(_ w: WKWebView, didFinish n: WKNavigation!) { done() } }
        let d = D(); d.done = { loaded.fulfill() }; web.navigationDelegate = d
        web.loadHTMLString(BodyLockdown.document(html: "<p id=a>before</p><script>document.getElementById('a').textContent='ran'</script>", allowRemoteImages: false), baseURL: URL(string: "about:blank"))
        await fulfillment(of: [loaded], timeout: 10)
        let text = try await web.evaluateJavaScript("document.getElementById('a').textContent") as? String
        XCTAssertEqual(text, "before")
    }
}
