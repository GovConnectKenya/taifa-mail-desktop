import Foundation
import Security

/// Result of a secret read: a missing item is not the same as a Keychain that failed.
enum SecretRead: Equatable {
    case found(Data)
    case notFound
    case failed(OSStatus)
}

/// A place for the secrets the app keeps: the serialized session cookies and the cache key.
protocol SecretStore: Sendable {
    func readResult(_ key: String) -> SecretRead
    func write(_ key: String, _ data: Data) -> Bool
    func delete(_ key: String)
    /// Human readable reason of the last failed operation, for the UI.
    var lastError: String? { get }
}

extension SecretStore {
    func read(_ key: String) -> Data? { if case let .found(d) = readResult(key) { return d }; return nil }
}

final class KeychainSecretStore: SecretStore, @unchecked Sendable {
    private let service: String
    private let lock = NSLock()
    private var _lastError: String?
    /// The data protection keychain needs a signed app with a team; an ad hoc Debug build answers -34018, and then
    /// the file keychain is used instead (never silently dropped).
    private var useDataProtection = true

    init(service: String = "ke.govconnect.TaifaMail") { self.service = service }

    var lastError: String? { lock.lock(); defer { lock.unlock() }; return _lastError }
    private func fail(_ status: OSStatus, _ what: String) {
        let msg = (SecCopyErrorMessageString(status, nil) as String?) ?? "error \(status)"
        lock.lock(); _lastError = "Keychain \(what) failed: \(msg)"; lock.unlock()
    }

    private func query(_ key: String, dataProtection: Bool) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
        if dataProtection { q[kSecUseDataProtectionKeychain as String] = true }
        return q
    }

    func readResult(_ key: String) -> SecretRead {
        for dp in useDataProtection ? [true, false] : [false] {
            var q = query(key, dataProtection: dp)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var out: CFTypeRef?
            let st = SecItemCopyMatching(q as CFDictionary, &out)
            if st == errSecSuccess, let d = out as? Data { return .found(d) }
            if st == errSecItemNotFound { continue }
            if st == errSecMissingEntitlement { useDataProtection = false; continue }
            fail(st, "read"); return .failed(st)
        }
        return .notFound
    }

    func write(_ key: String, _ data: Data) -> Bool {
        let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        for dp in useDataProtection ? [true, false] : [false] {
            var st = SecItemUpdate(query(key, dataProtection: dp) as CFDictionary, attrs as CFDictionary)
            if st == errSecItemNotFound {
                var add = query(key, dataProtection: dp); add.merge(attrs) { $1 }
                st = SecItemAdd(add as CFDictionary, nil)
            }
            if st == errSecSuccess { return true }
            if st == errSecMissingEntitlement && dp { useDataProtection = false; continue }
            fail(st, "write"); return false
        }
        return false
    }

    func delete(_ key: String) {
        for dp in [true, false] {
            let st = SecItemDelete(query(key, dataProtection: dp) as CFDictionary)
            if st != errSecSuccess && st != errSecItemNotFound && st != errSecMissingEntitlement { fail(st, "delete") }
        }
    }
}

final class MemorySecretStore: SecretStore, @unchecked Sendable {
    private var items: [String: Data] = [:]
    private let lock = NSLock()
    func readResult(_ key: String) -> SecretRead { lock.lock(); defer { lock.unlock() }; return items[key].map(SecretRead.found) ?? .notFound }
    var lastError: String? { nil }
    func write(_ key: String, _ data: Data) -> Bool { lock.lock(); items[key] = data; lock.unlock(); return true }
    func delete(_ key: String) { lock.lock(); items[key] = nil; lock.unlock() }
}

/// Persists the app private cookie jar in the Keychain and restores it at launch.
final class CookiePersistence: @unchecked Sendable {
    static let key = "session-cookies"
    private let store: SecretStore
    private let storage: HTTPCookieStorage
    private let queue = DispatchQueue(label: "ke.govconnect.TaifaMail.cookies")
    private var pending = false
    /// Called when the Keychain refuses a write, so the app can say so instead of losing the session silently.
    var onError: (@Sendable (String) -> Void)?

    init(store: SecretStore, storage: HTTPCookieStorage) { self.store = store; self.storage = storage }

    private struct Record: Codable {
        var name, value, domain, path: String
        var expires: Date?
        var secure: Bool
        var httpOnly: Bool
    }

    /// Debounced: many responses in a row write once.
    func scheduleSave() {
        queue.async { [self] in
            guard !pending else { return }
            pending = true
            queue.asyncAfter(deadline: .now() + 0.5) { [self] in pending = false; saveNow() }
        }
    }

    func saveNow() {
        let now = Date()
        let records = (storage.cookies ?? []).filter { $0.expiresDate.map { $0 > now } ?? true }.map {
            Record(name: $0.name, value: $0.value, domain: $0.domain, path: $0.path, expires: $0.expiresDate,
                   secure: $0.isSecure, httpOnly: $0.isHTTPOnly)
        }
        guard let data = try? JSONEncoder().encode(records) else { return }
        if !store.write(Self.key, data) { onError?(store.lastError ?? "The session could not be saved to the Keychain.") }
    }

    @discardableResult
    func restore() -> Int {
        guard let data = store.read(Self.key), let records = try? JSONDecoder().decode([Record].self, from: data) else { return 0 }
        var n = 0
        let now = Date()
        for r in records {
            if let e = r.expires, e <= now { continue }
            var props: [HTTPCookiePropertyKey: Any] = [.name: r.name, .value: r.value, .domain: r.domain, .path: r.path]
            if let e = r.expires { props[.expires] = e }
            if r.secure { props[.secure] = "TRUE" }
            if r.httpOnly { props[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
            if let c = HTTPCookie(properties: props) { storage.setCookie(c); n += 1 }
        }
        return n
    }

    func wipe() { store.delete(Self.key) }

    var hasSession: Bool { (storage.cookies ?? []).contains { $0.name == "tfm_mb_refresh" || $0.name == "tfm_mb_access" } }
}
