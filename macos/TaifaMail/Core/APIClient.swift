import Foundation

/// A description of one HTTP call, independent of URLSession so request building is unit testable.
struct APIRequest: Equatable, Sendable {
    var method: String = "GET"
    var path: String
    var query: [URLQueryItem] = []
    var body: Data? = nil
    var timeout: TimeInterval = 30

    var isStateChanging: Bool { !["GET", "HEAD", "OPTIONS", "TRACE"].contains(method.uppercased()) }

    /// Paths that must never trigger the 401 refresh loop (sign in, second factor, csrf, refresh itself).
    var skipsRefresh: Bool {
        path.hasPrefix("/auth/mailbox-login") || path.hasPrefix("/auth/mailbox-2fa")
            || path == "/auth/csrf" || path == "/auth/mailbox/refresh"
    }
}

enum APIError: Error, Equatable, LocalizedError, Sendable {
    case http(status: Int, code: String?, message: String)
    case transport(String)
    case sessionEnded
    case decoding(String)
    case cancelled

    var errorDescription: String? {
        switch self {
        case let .http(status, _, message): return message.isEmpty ? "Request failed (\(status))." : message
        case .transport: return "Could not reach Taifa Mail."
        case .sessionEnded: return "Your session ended. Sign in again."
        case .decoding: return "Taifa Mail sent a response the app could not read."
        case .cancelled: return "Cancelled."
        }
    }

    var statusCode: Int? { if case let .http(s, _, _) = self { return s }; return nil }
    var code: String? { if case let .http(_, c, _) = self { return c }; return nil }
    var isTransport: Bool { if case .transport = self { return true }; return false }
}

/// Shared coding configuration: the backend speaks snake_case JSON.
enum Coding {
    static func decoder() -> JSONDecoder {
        let d = JSONDecoder(); d.keyDecodingStrategy = .convertFromSnakeCase; return d
    }
    static func encoder() -> JSONEncoder {
        let e = JSONEncoder(); e.keyEncodingStrategy = .convertToSnakeCase; return e
    }
}

/// Parses the two error shapes the backend produces (see API_CONTRACT section 3.1).
enum ErrorDecoder {
    static func decode(status: Int, data: Data) -> APIError {
        var code: String?
        var message = ""
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let detail = obj["detail"]
            if let s = detail as? String { message = s }
            else if let d = detail as? [String: Any] {
                code = d["code"] as? String
                message = (d["message"] as? String) ?? ""
            } else if let list = detail as? [[String: Any]] {
                message = (list.first?["msg"] as? String) ?? "The request was not valid."
            }
        }
        return .http(status: status, code: code, message: message)
    }
}

actor ClientState {
    var csrf: String?
    var refreshTask: Task<Bool, Never>?

    func setCSRF(_ t: String?) { csrf = t }

    /// Runs `work` once; concurrent callers await the same in flight refresh.
    func coalescedRefresh(_ work: @escaping @Sendable () async -> Bool) async -> Bool {
        if let t = refreshTask { return await t.value }
        let t = Task { await work() }
        refreshTask = t
        let ok = await t.value
        refreshTask = nil
        return ok
    }
}

final class APIClient: @unchecked Sendable {
    static let productionBase = URL(string: "https://mail.govconnect.ke")!

    let baseURL: URL
    let session: URLSession
    let cookieStorage: HTTPCookieStorage
    private let state = ClientState()
    /// Called once when the refresh failed and the user must sign in again.
    var onSessionEnded: (@Sendable () -> Void)?
    /// Called after responses that changed cookies, so they can be persisted.
    var onCookiesChanged: (@Sendable () -> Void)?

    init(baseURL: URL = APIClient.productionBase, protocolClasses: [AnyClass]? = nil) {
        self.baseURL = baseURL
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieAcceptPolicy = .always
        config.httpShouldSetCookies = true
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        if let protocolClasses { config.protocolClasses = protocolClasses }
        self.cookieStorage = config.httpCookieStorage ?? HTTPCookieStorage()
        config.httpCookieStorage = self.cookieStorage
        self.session = URLSession(configuration: config)
    }

    // MARK: Request building (pure, tested)

    static func makeURLRequest(base: URL, request: APIRequest, csrf: String?) -> URLRequest {
        var comps = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        comps.path = request.path
        if !request.query.isEmpty { comps.percentEncodedQuery = encodeQuery(request.query) }
        var r = URLRequest(url: comps.url!, timeoutInterval: request.timeout)
        r.httpMethod = request.method.uppercased()
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body = request.body {
            r.httpBody = body
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if request.isStateChanging, let csrf { r.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token") }
        // Native clients never send Origin or Referer: the backend only checks Origin when present.
        return r
    }

    static func encodeQuery(_ items: [URLQueryItem]) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+#?/:@;$,")
        return items.map { item in
            let k = item.name.addingPercentEncoding(withAllowedCharacters: allowed) ?? item.name
            let v = (item.value ?? "").addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
            return "\(k)=\(v)"
        }.joined(separator: "&")
    }

    // MARK: Sending

    func send<T: Decodable & Sendable>(_ request: APIRequest, as type: T.Type = T.self) async throws -> T {
        let (data, _) = try await perform(request)
        do { return try Coding.decoder().decode(T.self, from: data) }
        catch { throw APIError.decoding(String(describing: error)) }
    }

    func sendVoid(_ request: APIRequest) async throws { _ = try await perform(request) }

    func rawData(_ request: APIRequest) async throws -> (Data, HTTPURLResponse) { try await perform(request) }

    private func perform(_ request: APIRequest, csrfRetried: Bool = false, refreshed: Bool = false)
        async throws -> (Data, HTTPURLResponse) {
        var csrf: String?
        if request.isStateChanging { csrf = try await ensureCSRF() }
        let urlRequest = Self.makeURLRequest(base: baseURL, request: request, csrf: csrf)
        let (data, response) = try await transport(urlRequest)
        onCookiesChanged?()
        let status = response.statusCode
        if (200..<300).contains(status) {
            if let t = cookieValue("tfm_csrf") { await state.setCSRF(t) }
            return (data, response)
        }
        let error = ErrorDecoder.decode(status: status, data: data)
        if status == 403, error.code == "csrf_invalid", !csrfRetried {
            await state.setCSRF(nil)
            return try await perform(request, csrfRetried: true, refreshed: refreshed)
        }
        if status == 401, !request.skipsRefresh, !refreshed {
            let ok = await state.coalescedRefresh { [weak self] in await self?.refreshOnce() ?? false }
            if ok { return try await perform(request, csrfRetried: csrfRetried, refreshed: true) }
            if await lastRefreshWasAuthFailure { onSessionEnded?(); throw APIError.sessionEnded }
            throw error
        }
        throw error
    }

    private var refreshFailedAuth = false
    private var lastRefreshWasAuthFailure: Bool { get async { refreshFailedAuth } }

    private func refreshOnce() async -> Bool {
        do {
            let csrf = try await ensureCSRF()
            let req = Self.makeURLRequest(base: baseURL, request: APIRequest(method: "POST", path: "/auth/mailbox/refresh"), csrf: csrf)
            let (_, response) = try await transport(req)
            onCookiesChanged?()
            if (200..<300).contains(response.statusCode) {
                refreshFailedAuth = false
                if let t = cookieValue("tfm_csrf") { await state.setCSRF(t) }
                return true
            }
            // Only a definite 401 or 403 from the refresh ends the session.
            refreshFailedAuth = response.statusCode == 401 || response.statusCode == 403
            return false
        } catch {
            refreshFailedAuth = false // transport problem: not a sign out
            return false
        }
    }

    func ensureCSRF() async throws -> String {
        if let t = await state.csrf { return t }
        let req = Self.makeURLRequest(base: baseURL, request: APIRequest(path: "/auth/csrf"), csrf: nil)
        let (data, response) = try await transport(req)
        guard (200..<300).contains(response.statusCode) else { throw ErrorDecoder.decode(status: response.statusCode, data: data) }
        struct Body: Decodable { var csrfToken: String? }
        let body = try? Coding.decoder().decode(Body.self, from: data)
        let token = body?.csrfToken ?? response.value(forHTTPHeaderField: "X-CSRF-Token") ?? cookieValue("tfm_csrf")
        guard let token, !token.isEmpty else { throw APIError.transport("Taifa Mail could not establish a secure session.") }
        await state.setCSRF(token)
        return token
    }

    func resetCSRF() async { await state.setCSRF(nil) }

    func cookieValue(_ name: String) -> String? {
        cookieStorage.cookies(for: baseURL)?.first(where: { $0.name == name })?.value
    }

    private func transport(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw APIError.transport("Invalid response.") }
            return (data, http)
        } catch let error as APIError {
            throw error
        } catch let error as URLError where error.code == .cancelled {
            throw APIError.cancelled
        } catch is CancellationError {
            throw APIError.cancelled
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
    }

    /// Clears every cookie of the app private store (sign out).
    func clearCookies() async {
        for c in cookieStorage.cookies ?? [] { cookieStorage.deleteCookie(c) }
        await state.setCSRF(nil)
        onCookiesChanged?()
    }

    /// Direct upload to a presigned object storage URL: no cookies, no CSRF, exactly the given headers.
    func upload(data: Data, to url: URL, method: String, headers: [String: String]) async throws {
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.httpShouldHandleCookies = false
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        let plain = URLSession(configuration: .ephemeral)
        do {
            let (_, resp) = try await plain.upload(for: r, from: data)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw APIError.http(status: (resp as? HTTPURLResponse)?.statusCode ?? 0, code: nil, message: "Upload failed.")
            }
        } catch let e as APIError { throw e }
        catch { throw APIError.transport(error.localizedDescription) }
    }

    func webSocket(path: String) -> URLSessionWebSocketTask {
        var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        comps.scheme = baseURL.scheme == "http" ? "ws" : "wss"
        comps.path = path
        return session.webSocketTask(with: comps.url!)
    }
}
