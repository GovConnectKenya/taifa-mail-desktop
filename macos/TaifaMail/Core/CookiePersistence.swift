import Foundation
import Security

/// A place for the one secret the app keeps: the serialized session cookies.
protocol SecretStore: Sendable {
    func read(_ key: String) -> Data?
    func write(_ key: String, _ data: Data) -> Bool
    func delete(_ key: String)
}

final class KeychainSecretStore: SecretStore, @unchecked Sendable {
    private let service: String
    init(service: String = "ke.govconnect.TaifaMail") { self.service = service }

    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
    }

    func read(_ key: String) -> Data? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    func write(_ key: String, _ data: Data) -> Bool {
        let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock]
        if SecItemUpdate(query(key) as CFDictionary, attrs as CFDictionary) == errSecSuccess { return true }
        var add = query(key); add.merge(attrs) { $1 }
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    func delete(_ key: String) { SecItemDelete(query(key) as CFDictionary) }
}

final class MemorySecretStore: SecretStore, @unchecked Sendable {
    private var items: [String: Data] = [:]
    private let lock = NSLock()
    func read(_ key: String) -> Data? { lock.lock(); defer { lock.unlock() }; return items[key] }
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
        _ = store.write(Self.key, data)
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
