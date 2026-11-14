import Foundation
import CryptoKit

/// A cached first page of a thread list.
struct CachedList: Codable, Equatable, Sendable {
    var items: [ConversationSummary]
    var total: Int
    var savedAt: Date
}

/// Disk cache for offline reading: folders, the first page of each thread list and opened
/// conversations. Foundation only (one JSON file per entry, atomic writes), scoped per mailbox,
/// wiped on sign out. All access is serialized by the actor, never on the main thread.
actor OfflineCache {
    private let root: URL
    private let fm = FileManager.default
    private let maxConversations: Int
    private let maxAge: TimeInterval
    private var key: SymmetricKey
    private let encoder = Coding.encoder()
    private let decoder = Coding.decoder()

    /// `key` encrypts every file at rest (AES-GCM). The app keeps it in the Keychain, per install.
    init(directory: URL, key: SymmetricKey = SymmetricKey(size: .bits256), maxConversations: Int = 300, maxAgeDays: Double = 30) {
        self.root = directory
        self.key = key
        self.maxConversations = maxConversations
        self.maxAge = maxAgeDays * 86_400
        Self.prepare(directory)
    }

    private static func prepare(_ dir: URL) {
        let fm = FileManager.default
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var u = dir
        var v = URLResourceValues(); v.isExcludedFromBackup = true
        try? u.setResourceValues(v)
    }

    var keyData: Data { key.withUnsafeBytes { Data($0) } }

    static func defaultDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("TaifaMail/Cache", isDirectory: true)
    }

    private func dir(_ mailbox: String) -> URL {
        let d = root.appendingPathComponent(Self.safe(mailbox), isDirectory: true)
        try? fm.createDirectory(at: d, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return d
    }

    static func safe(_ s: String) -> String {
        String(s.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "~" })
            + "-" + String(format: "%08x", UInt32(truncatingIfNeeded: s.utf8.reduce(UInt64(5381)) { ($0 &* 33) &+ UInt64($1) }))
    }

    private func write<T: Encodable>(_ value: T, to url: URL) {
        guard let plain = try? encoder.encode(value), let sealed = try? AES.GCM.seal(plain, using: key).combined else { return }
        try? sealed.write(to: url, options: .atomic)
        try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private func read<T: Decodable>(_ type: T.Type, from url: URL) -> T? {
        guard let blob = try? Data(contentsOf: url) else { return nil }
        guard let box = try? AES.GCM.SealedBox(combined: blob), let plain = try? AES.GCM.open(box, using: key) else {
            try? fm.removeItem(at: url)   // unreadable (old key or tampered): treat as a miss
            return nil
        }
        // Opening counts as use: the age cap drops what has not been opened for 30 days.
        try? fm.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        return try? decoder.decode(T.self, from: plain)
    }

    // MARK: Folders
    func saveFolders(_ folders: [Folder], mailbox: String) { write(folders, to: dir(mailbox).appendingPathComponent("folders.json")) }
    func folders(mailbox: String) -> [Folder]? { read([Folder].self, from: dir(mailbox).appendingPathComponent("folders.json")) }

    // MARK: Lists
    private func listURL(_ mailbox: String, _ folder: String) -> URL { dir(mailbox).appendingPathComponent("list-\(Self.safe(folder)).json") }
    func saveList(_ list: CachedList, mailbox: String, folder: String) { write(list, to: listURL(mailbox, folder)) }
    func list(mailbox: String, folder: String) -> CachedList? { read(CachedList.self, from: listURL(mailbox, folder)) }

    // MARK: Opened conversations
    private func convURL(_ mailbox: String, _ folder: String, _ uid: Int) -> URL {
        dir(mailbox).appendingPathComponent("conv-\(Self.safe(folder))-\(uid).json")
    }
    func saveConversation(_ window: ConversationWindow, mailbox: String, folder: String, uid: Int) {
        write(window, to: convURL(mailbox, folder, uid))
        trimConversations(mailbox: mailbox)
    }
    func conversation(mailbox: String, folder: String, uid: Int) -> ConversationWindow? {
        read(ConversationWindow.self, from: convURL(mailbox, folder, uid))
    }

    private func trimConversations(mailbox: String) {
        let d = dir(mailbox)
        guard let files = try? fm.contentsOfDirectory(at: d, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        var convs = files.filter { $0.lastPathComponent.hasPrefix("conv-") }
        let cutoff = Date().addingTimeInterval(-maxAge)
        for url in convs where ((try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) < cutoff {
            try? fm.removeItem(at: url)
        }
        convs = convs.filter { fm.fileExists(atPath: $0.path) }
        guard convs.count > maxConversations else { return }
        let sorted = convs.sorted {
            let a = (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let b = (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return a < b
        }
        for url in sorted.prefix(convs.count - maxConversations) { try? fm.removeItem(at: url) }
    }

    func conversationCount(mailbox: String) -> Int {
        ((try? fm.contentsOfDirectory(atPath: dir(mailbox).path)) ?? []).filter { $0.hasPrefix("conv-") }.count
    }

    // MARK: Lifecycle
    /// Called on sign out: nothing readable may stay behind.
    func clearAll() {
        try? fm.removeItem(at: root)
        Self.prepare(root)
        key = SymmetricKey(size: .bits256)   // the old key is gone for good
    }

    /// Removes conversations not opened within the age cap (also runs after every save).
    func purgeStale() { for d in (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] { trimConversations(mailbox: d.lastPathComponent) } }

    /// Test hook: back dates a cached file.
    func backdate(mailbox: String, folder: String, uid: Int, by seconds: TimeInterval) {
        try? fm.setAttributes([.modificationDate: Date().addingTimeInterval(-seconds)], ofItemAtPath: convURL(mailbox, folder, uid).path)
    }

    /// Raw bytes of a cached conversation file, for tests that prove nothing is stored in clear.
    func rawConversationBytes(mailbox: String, folder: String, uid: Int) -> Data? { try? Data(contentsOf: convURL(mailbox, folder, uid)) }

    func clear(mailbox: String) { try? fm.removeItem(at: dir(mailbox)) }

    func isEmpty() -> Bool {
        ((try? fm.contentsOfDirectory(atPath: root.path)) ?? []).isEmpty
    }
}


enum CacheKey {
    static let name = "cache-key"
    /// The per-install key lives in the Keychain; a fresh install (or a wiped one) gets a new random key.
    static func loadOrCreate(_ secrets: SecretStore) -> SymmetricKey {
        if let d = secrets.read(name), d.count == 32 { return SymmetricKey(data: d) }
        let k = SymmetricKey(size: .bits256)
        _ = secrets.write(name, k.withUnsafeBytes { Data($0) })
        return k
    }
}
