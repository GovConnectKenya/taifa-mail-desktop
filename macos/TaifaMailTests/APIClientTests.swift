import XCTest
@testable import TaifaMail

final class APIClientTests: XCTestCase {
    override func setUp() { StubProtocol.reset() }

    private func client() -> APIClient { APIClient(baseURL: URL(string: "https://mail.example.test")!, protocolClasses: [StubProtocol.self]) }

    func testGetRequestHasNoCSRFHeaderAndNoOrigin() {
        let r = APIClient.makeURLRequest(base: URL(string: "https://mail.example.test")!, request: Endpoints.folders("mb"), csrf: "tok")
        XCTAssertEqual(r.httpMethod, "GET")
        XCTAssertNil(r.value(forHTTPHeaderField: "X-CSRF-Token"))
        XCTAssertNil(r.value(forHTTPHeaderField: "Origin"))
        XCTAssertEqual(r.url?.path, "/v1/inbox/mb/folders")
    }

    func testPostCarriesCSRFAndJSONBody() {
        let r = APIClient.makeURLRequest(base: URL(string: "https://mail.example.test")!, request: Endpoints.login(address: " Me@X.KE ", password: "pw"), csrf: "tok")
        XCTAssertEqual(r.value(forHTTPHeaderField: "X-CSRF-Token"), "tok")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try! JSONSerialization.jsonObject(with: r.httpBody!) as! [String: String]
        XCTAssertEqual(body, ["address": "me@x.ke", "password": "pw"])
    }

    func testQueryEncodingEscapesReservedCharacters() {
        let req = Endpoints.search("mb", query: "from:a+b@x.ke has attachment&x=1", folder: "Projects/Budget", limit: 50, offset: 0)
        let r = APIClient.makeURLRequest(base: URL(string: "https://mail.example.test")!, request: req, csrf: nil)
        let s = r.url!.absoluteString
        XCTAssertTrue(s.contains("q=from%3Aa%2Bb%40x.ke%20has%20attachment%26x%3D1"), s)
        XCTAssertTrue(s.contains("folder=Projects%2FBudget"), s)
    }

    func testBatchMoveBody() {
        let req = Endpoints.batch("mb", action: .move(to: "Archive"), uids: [1, 2], folder: "INBOX")
        XCTAssertEqual(req.path, "/v1/inbox/mb/messages/batch/move")
        let body = try! JSONSerialization.jsonObject(with: req.body!) as! [String: Any]
        XCTAssertEqual(body["to_folder"] as? String, "Archive")
        XCTAssertEqual(body["uids"] as? [Int], [1, 2])
    }

    func testFetchesCSRFOnceThenEchoesIt() async throws {
        StubProtocol.handler = { r in
            if r.url!.path == "/auth/csrf" { return (200, Data(#"{"ok":true,"csrf_token":"T1"}"#.utf8), [:]) }
            return (200, Fixture.data("login_ok"), [:])
        }
        let c = client()
        _ = try await c.send(Endpoints.login(address: "a@x.ke", password: "p"), as: LoginResponse.self)
        _ = try await c.send(Endpoints.login(address: "a@x.ke", password: "p"), as: LoginResponse.self)
        let csrfCalls = StubProtocol.requests.filter { $0.url!.path == "/auth/csrf" }.count
        XCTAssertEqual(csrfCalls, 1)
        XCTAssertEqual(StubProtocol.requests.last?.value(forHTTPHeaderField: "X-CSRF-Token"), "T1")
    }

    func testCSRFInvalidRefetchesAndRetriesOnce() async throws {
        var n = 0
        var tokens = ["old", "new"]
        StubProtocol.handler = { r in
            if r.url!.path == "/auth/csrf" { return (200, Data(#"{"ok":true,"csrf_token":"\#(tokens.removeFirst())"}"#.utf8), [:]) }
            n += 1
            return n == 1 ? (403, Fixture.data("error_csrf"), [:]) : (200, Data(#"{"ok":true}"#.utf8), [:])
        }
        let c = client()
        try await c.sendVoid(Endpoints.batch("mb", action: .archive, uids: [1], folder: "INBOX"))
        XCTAssertEqual(StubProtocol.requests.last?.value(forHTTPHeaderField: "X-CSRF-Token"), "new")
    }

    func testUnauthorizedRefreshesThenRetries() async throws {
        var calls = 0
        StubProtocol.handler = { r in
            switch r.url!.path {
            case "/auth/csrf": return (200, Data(#"{"ok":true,"csrf_token":"T"}"#.utf8), [:])
            case "/auth/mailbox/refresh": return (200, Data(#"{"access_token":"x"}"#.utf8), [:])
            default:
                calls += 1
                return calls == 1 ? (401, Data(#"{"detail":{"code":"not_authenticated","message":"x"}}"#.utf8), [:]) : (200, Data("[]".utf8), [:])
            }
        }
        let folders: [Folder] = try await client().send(Endpoints.folders("mb"))
        XCTAssertTrue(folders.isEmpty)
        XCTAssertEqual(StubProtocol.requests.filter { $0.url!.path == "/auth/mailbox/refresh" }.count, 1)
    }

    func testConcurrentUnauthorizedRequestsShareOneRefresh() async throws {
        let lock = NSLock(); var served = Set<String>()
        StubProtocol.handler = { r in
            switch r.url!.path {
            case "/auth/csrf": return (200, Data(#"{"ok":true,"csrf_token":"T"}"#.utf8), [:])
            case "/auth/mailbox/refresh": Thread.sleep(forTimeInterval: 0.2); return (200, Data("{}".utf8), [:])
            default:
                lock.lock(); defer { lock.unlock() }
                let key = r.url!.absoluteString
                if served.insert(key).inserted { return (401, Data(#"{"detail":"x"}"#.utf8), [:]) }
                return (200, Data("[]".utf8), [:])
            }
        }
        let c = client()
        async let a: [Folder] = c.send(Endpoints.folders("a"))
        async let b: [Folder] = c.send(Endpoints.folders("b"))
        _ = try await (a, b)
        XCTAssertEqual(StubProtocol.requests.filter { $0.url!.path == "/auth/mailbox/refresh" }.count, 1)
    }

    func testFailedRefreshEndsTheSession() async {
        StubProtocol.handler = { r in
            switch r.url!.path {
            case "/auth/csrf": return (200, Data(#"{"ok":true,"csrf_token":"T"}"#.utf8), [:])
            case "/auth/mailbox/refresh": return (401, Data(#"{"detail":"Invalid refresh token"}"#.utf8), [:])
            default: return (401, Data(#"{"detail":"x"}"#.utf8), [:])
            }
        }
        let c = client()
        let ended = expectation(description: "ended")
        c.onSessionEnded = { ended.fulfill() }
        do { let _: [Folder] = try await c.send(Endpoints.folders("mb")); XCTFail("should throw") }
        catch { XCTAssertEqual(error as? APIError, .sessionEnded) }
        await fulfillment(of: [ended], timeout: 2)
    }

    func testSignInFailureDoesNotTriggerRefresh() async {
        StubProtocol.handler = { r in
            r.url!.path == "/auth/csrf" ? (200, Data(#"{"ok":true,"csrf_token":"T"}"#.utf8), [:]) : (401, Fixture.data("error_string"), [:])
        }
        do { _ = try await client().send(Endpoints.login(address: "a@x.ke", password: "bad"), as: LoginResponse.self); XCTFail() }
        catch let e as APIError { XCTAssertEqual(e.statusCode, 401); XCTAssertEqual(e.errorDescription, "Invalid address or password") }
        catch { XCTFail("\(error)") }
        XCTAssertTrue(StubProtocol.requests.filter { $0.url!.path == "/auth/mailbox/refresh" }.isEmpty)
    }

    func testErrorDecoding() {
        XCTAssertEqual(ErrorDecoder.decode(status: 403, data: Fixture.data("error_csrf")), .http(status: 403, code: "csrf_invalid", message: "CSRF token missing or invalid"))
        XCTAssertEqual(ErrorDecoder.decode(status: 401, data: Fixture.data("error_string")), .http(status: 401, code: nil, message: "Invalid address or password"))
        XCTAssertEqual(ErrorDecoder.decode(status: 422, data: Fixture.data("error_422")).errorDescription, "field required")
    }

    func testTransportFailureIsClassified() async {
        StubProtocol.handler = nil
        let c = APIClient(baseURL: URL(string: "https://mail.example.test")!, protocolClasses: [FailingProtocol.self])
        do { let _: [Folder] = try await c.send(Endpoints.folders("mb")); XCTFail() }
        catch { XCTAssertTrue((error as? APIError)?.isTransport == true) }
    }
}

final class FailingProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)) }
    override func stopLoading() {}
}
