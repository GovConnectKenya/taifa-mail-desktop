import Foundation
import Observation

enum LoadState: Equatable { case idle, loading, loaded, failed(String) }

struct Notice: Identifiable, Equatable {
    let id = UUID()
    var text: String
    var isError = false
    var canUndo = false
    static func == (l: Notice, r: Notice) -> Bool { l.id == r.id }
}

enum ReaderStatus: Equatable { case none, loading, loaded, failed(String), unavailableOffline }

/// The conversation open in the reader column.
struct ReaderState: Equatable {
    var rowId: String
    var subject: String
    var folder: String
    var uid: Int
    var messages: [ThreadMessage] = []
    var hasMoreOlder = false
    var nextBefore = 0
    var status: ReaderStatus = .loading
    var expanded: Set<String> = []
    var loadingBodies: Set<String> = []
    var imagesAllowed: Set<String> = []
    var loadingOlder = false
}

@MainActor @Observable
final class MailStore {
    // Dependencies
    @ObservationIgnored private(set) var service: MailService
    @ObservationIgnored let cache: OfflineCache
    @ObservationIgnored let avatars = AvatarStore()
    @ObservationIgnored var onBadgeChange: ((Int) -> Void)?
    @ObservationIgnored var onNewMail: (([Envelope]) -> Void)?

    // Sidebar
    private(set) var folders: [Folder] = []
    var selectedFolder: String = "INBOX"
    private(set) var foldersState: LoadState = .idle
    private(set) var quota: Quota?

    // List
    private(set) var rows: [ConversationSummary] = []
    private(set) var total = 0
    private(set) var listState: LoadState = .idle
    private(set) var isLoadingMore = false
    var selection: Set<String> = []
    @ObservationIgnored var anchorId: String?

    // Reader
    private(set) var reader: ReaderState?

    // Search
    var searchText = ""
    var searchAllFolders = false
    private(set) var isSearching = false
    private(set) var searchIncomplete = false

    // Status
    private(set) var isOffline = false
    private(set) var servedFromCache = false
    var notice: Notice?
    @ObservationIgnored private var undo: (() async -> Void)?
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    @ObservationIgnored private var readerTask: Task<Void, Never>?
    @ObservationIgnored private var listTask: Task<Void, Never>?
    @ObservationIgnored private var reconcileTask: Task<Void, Never>?
    @ObservationIgnored private var knownInbox: Set<String>?
    @ObservationIgnored var trustedImageSenders: Set<String> = []
    @ObservationIgnored var ownAddress = ""

    static let pageSize = 50

    init(service: MailService, cache: OfflineCache) {
        self.service = service
        self.cache = cache
        avatars.service = service
    }

    var mailboxId: String { service.mailboxId }
    var inboxUnseen: Int { folders.first(where: { $0.role == .inbox })?.unseen ?? 0 }
    var currentFolder: Folder? { folders.first(where: { $0.path == selectedFolder }) }
    var isOutgoingFolder: Bool { [.sent, .drafts].contains(currentFolder?.role ?? .other) }
    var composeFolders: [Folder] { folders }

    /// Bumped on every mailbox switch: results of requests started under an older generation are dropped.
    private(set) var generation = 0
    var pendingForever: [ConversationSummary]?

    func swapService(_ s: MailService) {
        generation += 1
        listTask?.cancel(); readerTask?.cancel(); reconcileTask?.cancel(); noticeTask?.cancel(); undo = nil; notice = nil
        isLoadingMore = false; pendingForever = nil
        service = s; avatars.service = s; avatars.reset()
        folders = []; rows = []; reader = nil; selection = []; knownInbox = nil; total = 0
        listState = .idle; foldersState = .idle; searchText = ""
    }

    // MARK: Bootstrap and refresh

    /// Cached folders and inbox first (instant), then the network.
    func bootstrap() async {
        let gen = generation, mb = mailboxId
        if let cached = await cache.folders(mailbox: mb), folders.isEmpty, gen == generation {
            folders = sorted(cached); foldersState = .loaded; servedFromCache = true
            publishBadge()
        }
        if rows.isEmpty, gen == generation, let l = await cache.list(mailbox: mb, folder: selectedFolder), gen == generation {
            rows = l.items; total = l.total; listState = .loaded; servedFromCache = true
            for r in l.items.prefix(30) { avatars.request(r.latest.fromAddr) }
        }
        async let f: Void = loadFolders()
        async let l: Void = loadFirstPage()
        _ = await (f, l)
        let svc = service
        Task { let t = Set((try? await svc.trustedImageSenders()) ?? []); if gen == generation { trustedImageSenders = t } }
    }

    private func sorted(_ f: [Folder]) -> [Folder] {
        f.sorted { a, b in
            let ra = a.role.sortOrder, rb = b.role.sortOrder
            if ra != rb { return ra < rb }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    func loadFolders() async {
        let gen = generation, mb = mailboxId, svc = service
        if folders.isEmpty { foldersState = .loading }
        do {
            let f = try await svc.folders()
            guard gen == generation else { return }
            folders = sorted(f); foldersState = .loaded; markOnline()
            await cache.saveFolders(f, mailbox: mb)
            publishBadge()
            if let q = try? await svc.quota(), gen == generation { quota = q }
        } catch { if gen == generation { handleListError(error, forFolders: true) } }
    }

    func refreshCounts() async {
        let gen = generation
        guard let counts = try? await service.folderCounts(), gen == generation else { return }
        markOnline()
        let map = Dictionary(uniqueKeysWithValues: counts.map { ($0.path, $0) })
        for i in folders.indices { if let c = map[folders[i].path] { folders[i].unseen = c.unseen; folders[i].total = c.total } }
        publishBadge()
    }

    private func publishBadge() { onBadgeChange?(inboxUnseen) }

    func selectFolder(_ path: String) {
        guard path != selectedFolder || isSearching else { return }
        selectedFolder = path
        searchText = ""
        selection = []; reader = nil; rows = []; total = 0
        listTask?.cancel()
        listTask = Task { await loadFirstPage(useCache: true) }
    }

    func refresh() async {
        if isSearching { await runSearch(); return }
        async let a: Void = loadFirstPage(keepRows: true)
        async let b: Void = refreshCounts()
        _ = await (a, b)
    }

    func loadFirstPage(useCache: Bool = false, keepRows: Bool = false) async {
        let folder = selectedFolder, gen = generation, mb = mailboxId, svc = service
        if useCache, let l = await cache.list(mailbox: mb, folder: folder), selectedFolder == folder, gen == generation {
            rows = l.items; total = l.total; listState = .loaded; servedFromCache = true
        }
        if rows.isEmpty { listState = .loading }
        do {
            let list: ConversationList
            if isOutgoingFolder {
                let m = try await svc.messages(folder: folder, offset: 0, limit: Self.pageSize)
                list = ConversationList(folder: folder, total: m.total, limit: m.limit, offset: 0, items: m.items.map(Self.summary))
            } else {
                list = try await svc.conversations(folder: folder, offset: 0, limit: Self.pageSize)
            }
            guard folder == selectedFolder, !isSearching, gen == generation else { return }
            // Keep the optimistic read state of the open thread if the server has not caught up.
            rows = list.items; total = list.total; listState = .loaded; servedFromCache = false; markOnline()
            for r in list.items.prefix(40) { avatars.request(r.latest.fromAddr) }
            await cache.saveList(CachedList(items: list.items, total: list.total, savedAt: Date()), mailbox: mb, folder: folder)
            trackInbox(list.items, folder: folder)
        } catch { if !(error is CancellationError), gen == generation { handleListError(error, forFolders: false) } }
    }

    static func summary(_ e: Envelope) -> ConversationSummary {
        ConversationSummary(threadKey: e.id, latest: e, count: 1, unread: !e.seen, uids: [e.uid])
    }

    func loadMoreIfNeeded(current row: ConversationSummary) {
        guard !isLoadingMore, rows.count < total, listState == .loaded, !isOffline,
              let idx = rows.firstIndex(where: { $0.id == row.id }), idx >= rows.count - 10 else { return }
        isLoadingMore = true
        let folder = selectedFolder
        let offset = rows.count
        let gen = generation
        Task {
            defer { isLoadingMore = false }
            do {
                let more: [ConversationSummary]
                if isSearching {
                    let m = try await searchResults(searchText, folder: folder, offset: offset)
                    more = m.items.map(Self.summary)
                } else if isOutgoingFolder {
                    more = try await service.messages(folder: folder, offset: offset, limit: Self.pageSize).items.map(Self.summary)
                } else {
                    more = try await service.conversations(folder: folder, offset: offset, limit: Self.pageSize).items
                }
                guard folder == selectedFolder, gen == generation else { return }
                let known = Set(rows.map(\.id))
                rows.append(contentsOf: more.filter { !known.contains($0.id) })
                for r in more.prefix(40) { avatars.request(r.latest.fromAddr) }
            } catch { handleListError(error, forFolders: false, quiet: true) }
        }
    }

    private func handleListError(_ error: Error, forFolders: Bool, quiet: Bool = false) {
        if let api = error as? APIError {
            if api.isTransport { isOffline = true }
            if api == .sessionEnded || api == .cancelled { return }
        }
        let message = (error as? LocalizedError)?.errorDescription ?? "Could not load mail."
        if forFolders { foldersState = folders.isEmpty ? .failed(message) : .loaded }
        else if !quiet { listState = rows.isEmpty ? .failed(message) : .loaded }
    }

    private func markOnline() { isOffline = false }
    func setOffline(_ v: Bool) { isOffline = v }

    private func trackInbox(_ items: [ConversationSummary], folder: String) {
        guard folders.first(where: { $0.path == folder })?.role == .inbox else { return }
        let d = NotificationPolicy.decide(incoming: items, known: knownInbox, ownAddress: ownAddress)
        knownInbox = d.knownAfter
        if !d.notify.isEmpty { onNewMail?(d.notify) }
    }

    // MARK: Search

    func runSearch() async {
        let q = searchText.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { await endSearch(); return }
        isSearching = true
        listState = .loading
        do {
            let m = try await searchResults(q, folder: selectedFolder, offset: 0)
            guard isSearching, q == searchText.trimmingCharacters(in: .whitespaces) else { return }
            rows = m.items.map(Self.summary); total = m.total; searchIncomplete = m.incomplete ?? false
            listState = .loaded; markOnline(); selection = []
            for r in rows.prefix(40) { avatars.request(r.latest.fromAddr) }
        } catch { if !(error is CancellationError) { handleListError(error, forFolders: false) } }
    }

    /// The server searches one folder per call. "All folders" fans out over every folder except
    /// Junk and Trash and merges the newest hits (no paging in that mode).
    private func searchResults(_ q: String, folder: String, offset: Int) async throws -> MessageList {
        guard searchAllFolders else { return try await service.search(query: q, folder: folder, offset: offset, limit: Self.pageSize) }
        guard offset == 0 else { return MessageList(folder: "", total: rows.count, limit: Self.pageSize, offset: offset, items: []) }
        let targets = folders.filter { ![.junk, .trash].contains($0.role) }.map(\.path)
        let svc = service
        var all: [Envelope] = []
        var incomplete = false
        try await withThrowingTaskGroup(of: MessageList?.self) { group in
            for path in targets { group.addTask { try? await svc.search(query: q, folder: path, offset: 0, limit: 30) } }
            for try await r in group { if let r { all += r.items; incomplete = incomplete || (r.incomplete ?? false) } }
        }
        all.sort { ($0.sentAt ?? .distantPast) > ($1.sentAt ?? .distantPast) }
        let top = Array(all.prefix(Self.pageSize * 2))
        return MessageList(folder: "", total: top.count, limit: Self.pageSize, offset: 0, items: top, incomplete: incomplete)
    }

    func endSearch() async {
        guard isSearching || !searchText.isEmpty else { return }
        isSearching = false; searchText = ""; searchIncomplete = false
        selection = []; reader = nil
        await loadFirstPage(useCache: true)
    }

    // MARK: Selection and opening

    func select(_ id: String, extend: Bool = false, toggle: Bool = false) {
        if toggle {
            if selection.contains(id) { selection.remove(id) } else { selection.insert(id) }
            anchorId = id
        } else if extend, let a = anchorId,
                  let i = rows.firstIndex(where: { $0.id == a }), let j = rows.firstIndex(where: { $0.id == id }) {
            selection = Set(rows[min(i, j)...max(i, j)].map(\.id))
        } else {
            selection = [id]; anchorId = id
        }
        if selection.count == 1, let row = rows.first(where: { $0.id == selection.first }) { open(row) }
        else if selection.count != 1 { readerTask?.cancel(); reader = nil }
    }

    func moveSelection(by delta: Int, extend: Bool = false) {
        guard !rows.isEmpty else { return }
        let current = anchorId.flatMap { id in rows.firstIndex(where: { $0.id == id }) } ?? (delta > 0 ? -1 : rows.count)
        let next = max(0, min(rows.count - 1, current + delta))
        select(rows[next].id, extend: extend)
    }

    var selectedRows: [ConversationSummary] { rows.filter { selection.contains($0.id) } }

    func open(_ row: ConversationSummary) {
        readerTask?.cancel()
        let envelope = row.latest
        var state = ReaderState(rowId: row.id, subject: envelope.subject, folder: envelope.folder, uid: envelope.uid)
        reader = state
        let gen = generation, mb = mailboxId, svc = service
        readerTask = Task { [weak self] in
            guard let self else { return }
            // Cached copy first: readable offline and instant when revisiting.
            if let cached = await cache.conversation(mailbox: mb, folder: envelope.folder, uid: envelope.uid) {
                guard !Task.isCancelled, reader?.rowId == row.id, gen == generation else { return }
                apply(cached, to: &state, row: row)
                reader = state
            }
            if row.unread { Task { await self.markRead(row) } }
            do {
                let window = try await svc.conversation(uid: envelope.uid, folder: envelope.folder, before: nil)
                guard !Task.isCancelled, reader?.rowId == row.id, gen == generation else { return }
                markOnline()
                apply(window, to: &state, row: row)
                state.status = .loaded
                reader = state
                await cache.saveConversation(window, mailbox: mb, folder: envelope.folder, uid: envelope.uid)
                for m in window.messages { avatars.request(m.fromAddr) }
                await ensureLatestBody(row.id)
            } catch {
                guard !Task.isCancelled, reader?.rowId == row.id, gen == generation else { return }
                if let api = error as? APIError, api.isTransport {
                    isOffline = true
                    reader?.status = reader?.messages.isEmpty == false ? .loaded : .unavailableOffline
                } else if (error as? APIError) == .cancelled { return }
                else { reader?.status = .failed((error as? LocalizedError)?.errorDescription ?? "Could not load this message.") }
            }
        }
    }

    private func apply(_ window: ConversationWindow, to state: inout ReaderState, row: ConversationSummary) {
        let sorted = window.messages.sorted { ($0.sentAt ?? .distantPast) < ($1.sentAt ?? .distantPast) }
        state.messages = sorted
        state.hasMoreOlder = window.hasMoreOlder
        state.nextBefore = window.nextBefore
        if let latest = sorted.last { state.expanded.insert(latest.id) }
        if state.status == .loading, !sorted.isEmpty { state.status = .loaded }
    }

    /// "Show earlier messages": the next older window of a long conversation (hasMoreOlder / nextBefore).
    func loadOlder() async {
        guard let r = reader, r.hasMoreOlder, !r.loadingOlder else { return }
        reader?.loadingOlder = true
        defer { reader?.loadingOlder = false }
        do {
            let w = try await service.conversation(uid: r.uid, folder: r.folder, before: r.nextBefore)
            guard var cur = reader, cur.rowId == r.rowId else { return }
            let known = Set(cur.messages.map(\.id))
            let older = w.messages.filter { !known.contains($0.id) }
            cur.messages = (older + cur.messages).sorted { ($0.sentAt ?? .distantPast) < ($1.sentAt ?? .distantPast) }
            cur.hasMoreOlder = w.hasMoreOlder; cur.nextBefore = w.nextBefore
            cur.loadingOlder = false
            reader = cur
            for m in older { avatars.request(m.fromAddr) }
        } catch { post("Could not load earlier messages", isError: true) }
    }

    /// Position of the open thread in the list, for "N of M".
    var readerPosition: (index: Int, count: Int)? {
        guard let r = reader, let i = rows.firstIndex(where: { $0.id == r.rowId }) else { return nil }
        return (i + 1, total)
    }

    func openNewer() { step(-1) }
    func openOlder() { step(1) }
    private func step(_ d: Int) {
        guard let r = reader, let i = rows.firstIndex(where: { $0.id == r.rowId }), rows.indices.contains(i + d) else { return }
        select(rows[i + d].id)
    }

    func retryReader() { if let r = reader, let row = rows.first(where: { $0.id == r.rowId }) { open(row) } }

    func toggleExpanded(_ messageId: String) {
        guard var r = reader else { return }
        if r.expanded.contains(messageId) { r.expanded.remove(messageId) } else { r.expanded.insert(messageId) }
        reader = r
        Task { await ensureBody(messageId) }
    }

    func ensureLatestBody(_ rowId: String) async {
        guard let id = reader?.messages.last?.id else { return }
        await ensureBody(id)
    }

    /// Loads the full body of an expanded message whose shell has none yet.
    func ensureBody(_ id: String) async {
        guard var r = reader, r.expanded.contains(id),
              let m = r.messages.first(where: { $0.id == id }), !m.bodyLoaded, !r.loadingBodies.contains(id) else { return }
        r.loadingBodies.insert(id); reader = r
        do {
            let full = try await service.body(uid: m.uid, folder: m.folder)
            guard var r2 = reader, r2.rowId == r.rowId, let i = r2.messages.firstIndex(where: { $0.id == id }) else { return }
            var merged = full; merged.bodyLoaded = true
            if merged.sentAt == nil { merged.dateTs = r2.messages[i].dateTs }
            r2.messages[i] = merged; r2.loadingBodies.remove(id); reader = r2
        } catch {
            if var r2 = reader { r2.loadingBodies.remove(id); reader = r2 }
        }
    }

    func allowImages(for messageId: String) {
        reader?.imagesAllowed.insert(messageId)
    }

    // MARK: Mark read (optimistic, rolls back on failure)

    /// Marks the thread read at once in the list and sidebar, then tells the server.
    /// On failure the previous state is restored and a notice explains it.
    @discardableResult
    func markRead(_ row: ConversationSummary) async -> Bool {
        guard let idx = rows.firstIndex(where: { $0.id == row.id }), rows[idx].unread else { return true }
        let before = rows[idx]
        let folderPath = before.latest.folder
        let unseenBefore = folders.first(where: { $0.path == folderPath })?.unseen
        applyRead(rowId: row.id, folder: folderPath, read: true, unseenDelta: unseenBefore.map { _ in -max(1, before.uids.count) })
        let gen = generation
        do {
            let result = try await service.markThreadRead(uid: before.latest.uid, folder: folderPath)
            guard gen == generation else { return false }
            if !result.complete, result.failedFolders.contains(folderPath) {
                restoreRead(before, unseenBefore: unseenBefore)
                post("Could not mark as read", isError: true)
                return false
            }
            markOnline()
            return true
        } catch {
            if let a = error as? APIError, a.isTransport { isOffline = true }
            restoreRead(before, unseenBefore: unseenBefore)
            post("Could not mark as read", isError: true)
            return false
        }
    }

    private func applyRead(rowId: String, folder: String, read: Bool, unseenDelta: Int?) {
        if let i = rows.firstIndex(where: { $0.id == rowId }) {
            rows[i].unread = !read
            rows[i].latest.seen = read
        }
        if reader?.rowId == rowId { for i in reader!.messages.indices { reader!.messages[i].seen = read } }
        if let d = unseenDelta, let f = folders.firstIndex(where: { $0.path == folder }) {
            folders[f].unseen = max(0, (folders[f].unseen ?? 0) + d)
            publishBadge()
        }
    }

    private func restoreRead(_ before: ConversationSummary, unseenBefore: Int?) {
        if let i = rows.firstIndex(where: { $0.id == before.id }) { rows[i] = before }
        if reader?.rowId == before.id { for i in reader!.messages.indices { reader!.messages[i].seen = false } }
        if let u = unseenBefore, let f = folders.firstIndex(where: { $0.path == before.latest.folder }) { folders[f].unseen = u; publishBadge() }
    }

    // MARK: Actions

    enum Action: Equatable {
        case archive, trash, junk, notJunk, move(String), flag(Bool), read(Bool), deleteForever
        var batch: BatchAction {
            switch self {
            case .archive: .archive
            case .trash: .trash
            case .junk: .junk
            case .notJunk: .notJunk
            case let .move(t): .move(to: t)
            case let .flag(v): .flagged(v)
            case let .read(v): .seen(v)
            case .deleteForever: .permanent
            }
        }
        var removesRow: Bool { switch self { case .flag, .read: false; default: true } }
        var partialVerb: String {
            switch self {
            case .archive: "Archived"
            case .trash, .deleteForever: "Deleted"
            case .junk, .notJunk, .move: "Moved"
            case .flag: "Updated"
            case .read: "Updated"
            }
        }
        var done: String {
            switch self {
            case .deleteForever: "Deleted forever"

            case .archive: "Archived"
            case .trash: "Moved to Trash"
            case .junk: "Moved to Junk"
            case .notJunk: "Moved to Inbox"
            case let .move(t): "Moved to \(t)"
            case .flag(true): "Flagged"
            case .flag(false): "Flag removed"
            case .read(true): "Marked as read"
            case .read(false): "Marked as unread"
            }
        }
    }

    /// The folder the row's UIDs belong to. In a conversation list `latest.folder` can be Sent or Archive while
    /// `uids` are the listed folder's UIDs, so actions use the folder the list was loaded for. Search results
    /// are single messages whose uid and folder pair correctly.
    func actingFolder(for row: ConversationSummary) -> String { isSearching ? row.latest.folder : selectedFolder }

    struct ActGroup { var folder: String; var rows: [ConversationSummary]; var uids: [Int] }

    func actGroups(_ rows: [ConversationSummary]) -> [ActGroup] {
        Dictionary(grouping: rows, by: { actingFolder(for: $0) }).map { folder, rs in
            let uids = rs.flatMap { r -> [Int] in !r.uids.isEmpty ? r.uids : (r.latest.folder == folder ? [r.latest.uid] : []) }
            return ActGroup(folder: folder, rows: rs, uids: Array(Set(uids)).sorted())
        }
    }

    func confirmForever() { if let p = pendingForever { pendingForever = nil; perform(.deleteForever, on: p) } }
    func cancelForever() { pendingForever = nil }

    func perform(_ action: Action, on targets: [ConversationSummary]? = nil) {
        let initialRows = targets ?? selectedRows
        guard !initialRows.isEmpty else { return }
        if isOffline { post("Not available offline", isError: true); return }
        // Delete inside Trash or Junk is permanent and asks first. A mixed selection splits: rows in Trash or Junk
        // ask, the rest are moved to Trash as usual.
        var rowsToAct = initialRows
        if action == .trash {
            let permanent = rowsToAct.filter { row in [.trash, .junk].contains(folders.first(where: { $0.path == actingFolder(for: row) })?.role ?? .other) }
            if !permanent.isEmpty {
                pendingForever = permanent
                let ids = Set(permanent.map(\.id))
                rowsToAct = rowsToAct.filter { !ids.contains($0.id) }
                if rowsToAct.isEmpty { return }
            }
        }
        let snapshot = rows, readerSnapshot = reader, foldersSnapshot = folders
        let groups = actGroups(rowsToAct)
        let gen = generation, svc = service
        // Optimistic local change.
        if action.removesRow {
            let ids = Set(rowsToAct.map(\.id))
            rows.removeAll { ids.contains($0.id) }
            total = max(0, total - ids.count)
            selection.subtract(ids)
            if let r = reader, ids.contains(r.rowId) { reader = nil }
            for r in rowsToAct where r.unread {
                if let f = folders.firstIndex(where: { $0.path == actingFolder(for: r) }) { folders[f].unseen = max(0, (folders[f].unseen ?? 0) - 1) }
            }
            publishBadge()
        } else {
            for r in rowsToAct {
                guard let i = rows.firstIndex(where: { $0.id == r.id }) else { continue }
                switch action {
                case let .flag(v): rows[i].latest.flagged = v
                case let .read(v):
                    rows[i].unread = !v; rows[i].latest.seen = v
                    if let f = folders.firstIndex(where: { $0.path == actingFolder(for: r) }), r.unread == v {
                        folders[f].unseen = max(0, (folders[f].unseen ?? 0) + (v ? -1 : 1))
                    }
                default: break
                }
            }
            publishBadge()
        }
        Task {
            var ok = 0, requested = 0, hadSourceChange = false
            var undoPairs: [(messageId: String, dest: String, origin: String)] = []
            for g in groups where !g.uids.isEmpty {
                requested += g.uids.count
                do {
                    let result = try await svc.batch(action: action.batch, uids: g.uids, folder: g.folder)
                    ok += result.succeeded.count
                    if gen == generation { markOnline() }
                    if action.removesRow, result.ok, action != .deleteForever {
                        let dest = destination(for: action)
                        for r in g.rows where r.count == 1 && !r.latest.messageId.isEmpty { undoPairs.append((r.latest.messageId, dest, g.folder)) }
                    }
                } catch {
                    if gen == generation, let a = error as? APIError, a.isTransport { isOffline = true }
                    if let a = error as? APIError, a.code == "mail_source_changed" { hadSourceChange = true }
                }
            }
            guard gen == generation else { return }
            if requested > 0 && ok == 0 {
                rows = snapshot; reader = readerSnapshot; folders = foldersSnapshot; publishBadge()
                post("Could not complete the action. Nothing was changed.", isError: true)
                if hadSourceChange { await refresh() }
                return
            }
            if ok < requested || hadSourceChange {
                // Something changed and something did not: take the server's truth and say how many.
                await refresh()
                post("\(action.partialVerb) \(ok) of \(requested)", isError: true)
                return
            }
            await refreshCounts()
            switch action {
            case .flag(let v): offerUndo(action.done) { await self.undoGroups(groups, .flagged(!v)) }
            case .read(let v): offerUndo(action.done) { await self.undoGroups(groups, .seen(!v)) }
            default:
                let allUndoable = undoPairs.count == rowsToAct.count && action != .deleteForever
                if allUndoable { offerUndo(action.done) { await self.undoMove(undoPairs) } } else { post(action.done) }
            }
        }
    }

    private func destination(for action: Action) -> String {
        switch action {
        case .archive: return folders.first(where: { $0.role == .archive })?.path ?? "Archive"
        case .trash: return folders.first(where: { $0.role == .trash })?.path ?? "Trash"
        case .junk: return folders.first(where: { $0.role == .junk })?.path ?? "Junk"
        case .notJunk: return folders.first(where: { $0.role == .inbox })?.path ?? "INBOX"
        case let .move(t): return t
        default: return selectedFolder
        }
    }

    private func undoMove(_ pairs: [(messageId: String, dest: String, origin: String)]) async {
        for p in pairs {
            guard let found = try? await service.resolve(messageId: p.messageId, hint: p.dest) else { continue }
            _ = try? await service.batch(action: .move(to: p.origin), uids: [found.uid], folder: found.folder)
        }
        await refresh()
    }

    /// Inverse flag or read change, on the folder each group was acted on (never `latest.folder`).
    private func undoGroups(_ groups: [ActGroup], _ inverse: BatchAction) async {
        for g in groups where !g.uids.isEmpty { _ = try? await service.batch(action: inverse, uids: g.uids, folder: g.folder) }
        await refresh()
    }

    // MARK: Notices

    func post(_ text: String, isError: Bool = false) {
        undo = nil
        notice = Notice(text: text, isError: isError, canUndo: false)
        scheduleNoticeDismiss(seconds: 5)
    }

    private func offerUndo(_ text: String, _ action: @escaping () async -> Void) {
        undo = action
        notice = Notice(text: text, isError: false, canUndo: true)
        scheduleNoticeDismiss(seconds: 8)
    }

    func performUndo() {
        guard let u = undo else { return }
        undo = nil; notice = nil; noticeTask?.cancel()
        Task { await u() }
    }

    var canUndo: Bool { undo != nil }
    func dismissNotice() { notice = nil; undo = nil; noticeTask?.cancel() }

    private func scheduleNoticeDismiss(seconds: Double) {
        noticeTask?.cancel()
        let id = notice?.id
        noticeTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled, let self, self.notice?.id == id else { return }
            self.notice = nil; self.undo = nil
        }
    }

    // MARK: Realtime

    func handle(_ event: RealtimeEvent) {
        switch event {
        case let .flagsChanged(uid, folder, seen, flagged):
            if let i = rows.firstIndex(where: { $0.latest.uid == uid && $0.latest.folder == folder }) {
                if let seen { rows[i].latest.seen = seen; rows[i].unread = !seen }
                if let flagged { rows[i].latest.flagged = flagged }
            }
            scheduleReconcile(listToo: false)
        case let .moved(uid, from, _), let .deleted(uid, from):
            rows.removeAll { $0.latest.uid == uid && $0.latest.folder == from }
            scheduleReconcile(listToo: false)
        case .newMail:
            scheduleReconcile(listToo: true, inbox: true)
        case .reconcile:
            scheduleReconcile(listToo: true)
        case .ignored: break
        }
    }

    /// Realtime is a hint: debounce, then let REST decide.
    func scheduleReconcile(listToo: Bool, inbox: Bool = false) {
        reconcileTask?.cancel()
        reconcileTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard !Task.isCancelled, let self else { return }
            await self.refreshCounts()
            if listToo && !self.isSearching { await self.loadFirstPage(keepRows: true) }
            if inbox, self.folders.first(where: { $0.path == self.selectedFolder })?.role != .inbox { await self.pollInbox() }
        }
    }

    /// Looks at the Inbox's first page quietly so a new message notifies even when another folder is open.
    private func pollInbox() async {
        guard let inbox = folders.first(where: { $0.role == .inbox }),
              let list = try? await service.conversations(folder: inbox.path, offset: 0, limit: 20) else { return }
        trackInbox(list.items, folder: inbox.path)
    }
}
