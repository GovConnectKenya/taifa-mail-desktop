import Foundation

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
    private let encoder = Coding.encoder()
    private let decoder = Coding.decoder()

    init(directory: URL, maxConversations: Int = 300) {
        self.root = directory
        self.maxConversations = maxConversations
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    static func defaultDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("TaifaMail/Cache", isDirectory: true)
    }

    private func dir(_ mailbox: String) -> URL {
        let d = root.appendingPathComponent(Self.safe(mailbox), isDirectory: true)
        try? fm.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    static func safe(_ s: String) -> String {
        String(s.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "~" })
            + "-" + String(format: "%08x", UInt32(truncatingIfNeeded: s.utf8.reduce(UInt64(5381)) { ($0 &* 33) &+ UInt64($1) }))
    }

    private func write<T: Encodable>(_ value: T, to url: URL) {
        guard let data = try? encoder.encode(value) else { return }
        try? data.write(to: url, options: .atomic)
    }

    private func read<T: Decodable>(_ type: T.Type, from url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(T.self, from: data)
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
        let convs = files.filter { $0.lastPathComponent.hasPrefix("conv-") }
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
        try? fm.createDirectory(at: root, withIntermediateDirectories: true)
    }

    func clear(mailbox: String) { try? fm.removeItem(at: dir(mailbox)) }

    func isEmpty() -> Bool {
        ((try? fm.contentsOfDirectory(atPath: root.path)) ?? []).isEmpty
    }
}
