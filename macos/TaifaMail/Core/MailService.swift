import Foundation

/// Everything the UI needs from the backend for one mailbox. The live implementation
/// talks to the real API; the Debug only preview implementation serves fixtures.
protocol MailService: Sendable {
    var mailboxId: String { get }
    func folders() async throws -> [Folder]
    func folderCounts() async throws -> [FolderCount]
    func quota() async throws -> Quota?
    func conversations(folder: String, offset: Int, limit: Int) async throws -> ConversationList
    func messages(folder: String, offset: Int, limit: Int) async throws -> MessageList
    func search(query: String, folder: String, offset: Int, limit: Int) async throws -> MessageList
    func conversation(uid: Int, folder: String, before: Int?) async throws -> ConversationWindow
    func body(uid: Int, folder: String) async throws -> ThreadMessage
    func markThreadRead(uid: Int, folder: String) async throws -> MarkReadResult
    func batch(action: BatchAction, uids: [Int], folder: String) async throws -> BatchResult
    func resolve(messageId: String, hint: String) async throws -> ResolvedMessage
    func avatars(emails: [String]) async throws -> [String: AvatarEntry]
    func attachment(uid: Int, folder: String, partId: String) async throws -> Data
    func send(_ payload: Endpoints.SendPayload) async throws -> SendResult
    func saveDraft(_ payload: Endpoints.SendPayload) async throws -> DraftResult
    func upload(filename: String, mime: String, data: Data) async throws -> StoredFile
    func contacts(matching: String) async throws -> [Contact]
    func stageAttachments(uid: Int, folder: String) async throws -> [StagedAttachment]
    func signature() async throws -> MailBlock?
    func saveSignature(html: String, text: String, existing: MailBlock?) async throws
    func autoResponder() async throws -> AutoResponder
    func saveAutoResponder(_ a: AutoResponder) async throws
    func trustedImageSenders() async throws -> [String]
}

struct LiveMailService: MailService {
    let api: APIClient
    let mailboxId: String

    func folders() async throws -> [Folder] { try await api.send(Endpoints.folders(mailboxId)) }
    func folderCounts() async throws -> [FolderCount] { try await api.send(Endpoints.folderCounts(mailboxId)) }
    func quota() async throws -> Quota? { try await api.send(Endpoints.quota(mailboxId)) }
    func conversations(folder: String, offset: Int, limit: Int) async throws -> ConversationList {
        try await api.send(Endpoints.conversations(mailboxId, folder: folder, limit: limit, offset: offset))
    }
    func messages(folder: String, offset: Int, limit: Int) async throws -> MessageList {
        try await api.send(Endpoints.messages(mailboxId, folder: folder, limit: limit, offset: offset))
    }
    func search(query: String, folder: String, offset: Int, limit: Int) async throws -> MessageList {
        try await api.send(Endpoints.search(mailboxId, query: query, folder: folder, limit: limit, offset: offset))
    }
    func conversation(uid: Int, folder: String, before: Int?) async throws -> ConversationWindow {
        try await api.send(Endpoints.conversation(mailboxId, uid: uid, folder: folder, before: before))
    }
    func body(uid: Int, folder: String) async throws -> ThreadMessage {
        try await api.send(Endpoints.conversationBody(mailboxId, uid: uid, folder: folder))
    }
    func markThreadRead(uid: Int, folder: String) async throws -> MarkReadResult {
        try await api.send(Endpoints.markThreadRead(mailboxId, uid: uid, folder: folder))
    }
    func batch(action: BatchAction, uids: [Int], folder: String) async throws -> BatchResult {
        try await api.send(Endpoints.batch(mailboxId, action: action, uids: uids, folder: folder))
    }
    func resolve(messageId: String, hint: String) async throws -> ResolvedMessage {
        try await api.send(Endpoints.resolve(mailboxId, messageId: messageId, folder: hint))
    }
    func avatars(emails: [String]) async throws -> [String: AvatarEntry] {
        let r: AvatarBatchResponse = try await api.send(Endpoints.avatars(mailboxId, emails: emails))
        return r.results
    }
    func attachment(uid: Int, folder: String, partId: String) async throws -> Data {
        try await api.rawData(Endpoints.attachment(mailboxId, uid: uid, partId: partId, folder: folder)).0
    }
    func send(_ payload: Endpoints.SendPayload) async throws -> SendResult { try await api.send(Endpoints.send(mailboxId, payload)) }
    func saveDraft(_ payload: Endpoints.SendPayload) async throws -> DraftResult { try await api.send(Endpoints.saveDraft(mailboxId, payload)) }

    func upload(filename: String, mime: String, data: Data) async throws -> StoredFile {
        let ticket: UploadTicket = try await api.send(Endpoints.createUpload(mailbox: mailboxId, filename: filename, mime: mime, size: data.count))
        guard let url = URL(string: ticket.upload.url) else { throw APIError.transport("Invalid upload address.") }
        try await api.upload(data: data, to: url, method: ticket.upload.method, headers: ticket.upload.headers)
        let done: FileEnvelope = try await api.send(Endpoints.completeUpload(ticket.file.id))
        return done.file
    }

    func stageAttachments(uid: Int, folder: String) async throws -> [StagedAttachment] {
        let r: StagedAttachments = try await api.send(Endpoints.stageAttachments(mailboxId, uid: uid, folder: folder))
        return r.files
    }

    func contacts(matching text: String) async throws -> [Contact] {
        let data = try await api.rawData(Endpoints.contacts(query: text)).0
        let dec = Coding.decoder()
        if let list = try? dec.decode([Contact].self, from: data) { return list }
        return (try? dec.decode(ContactList.self, from: data))?.items ?? []
    }

    func signature() async throws -> MailBlock? {
        let b: MailBlocks = try await api.send(Endpoints.blocks)
        return b.signatures.first(where: { $0.isDefault && $0.scope != "org" }) ?? b.signatures.first(where: { $0.scope != "org" })
    }
    func saveSignature(html: String, text: String, existing: MailBlock?) async throws {
        if let existing { try await api.sendVoid(Endpoints.updateBlock(existing.id, html: html, text: text)) }
        else { try await api.sendVoid(Endpoints.createBlock(name: "Signature", html: html, text: text)) }
    }
    func autoResponder() async throws -> AutoResponder { try await api.send(Endpoints.autoresponder) }
    func saveAutoResponder(_ a: AutoResponder) async throws { try await api.sendVoid(Endpoints.putAutoresponder(a)) }
    func trustedImageSenders() async throws -> [String] {
        let s: MailboxSettings = try await api.send(Endpoints.settings)
        return s.trustedImageSenders ?? []
    }
}

/// Authentication calls (not mailbox scoped).
struct AuthService: Sendable {
    let api: APIClient

    private func outcome(_ r: LoginResponse) throws -> LoginOutcome {
        if r.requires2fa == true { return .secondFactor(address: r.address ?? "") }
        guard let id = r.mailboxId, let address = r.address else { throw APIError.decoding("missing session") }
        return .signedIn(MailboxSession(mailboxId: id, address: address, orgId: r.orgId))
    }

    func login(address: String, password: String) async throws -> LoginOutcome {
        await api.resetCSRF()
        return try outcome(try await api.send(Endpoints.login(address: address, password: password)))
    }
    func requestCode(address: String) async throws { try await api.sendVoid(Endpoints.requestLoginCode(address: address)) }
    func verifyCode(address: String, code: String) async throws -> LoginOutcome {
        try outcome(try await api.send(Endpoints.verifyLoginCode(address: address, code: code)))
    }
    func emailSecondFactor() async throws { try await api.sendVoid(Endpoints.challengeSecondFactor) }
    func verifySecondFactor(code: String) async throws -> LoginOutcome {
        try outcome(try await api.send(Endpoints.verifySecondFactor(code: code)))
    }
    func me() async throws -> MailboxSession { try await api.send(Endpoints.me) }
    func switchable() async throws -> [SwitchableMailbox] { try await api.send(Endpoints.switchable) }
    func switchTo(_ id: String) async throws -> MailboxSession { try await api.send(Endpoints.switchMailbox(id)) }
    func logout() async { try? await api.sendVoid(Endpoints.logout) }
}
