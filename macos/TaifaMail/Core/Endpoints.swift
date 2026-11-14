import Foundation

/// Every request the app builds, in one place (mirrors docs/native/API_CONTRACT.md).
enum Endpoints {
    private static func json<T: Encodable>(_ v: T) -> Data { (try? Coding.encoder().encode(v)) ?? Data() }
    private static func q(_ pairs: [(String, String?)]) -> [URLQueryItem] {
        pairs.compactMap { k, v in v.map { URLQueryItem(name: k, value: $0) } }
    }
    private static func box(_ mailbox: String) -> String { "/v1/inbox/\(mailbox)" }

    // MARK: Auth
    static func login(address: String, password: String) -> APIRequest {
        APIRequest(method: "POST", path: "/auth/mailbox-login",
                   body: json(["address": address.trimmingCharacters(in: .whitespaces).lowercased(), "password": password]))
    }
    static func requestLoginCode(address: String) -> APIRequest {
        APIRequest(method: "POST", path: "/auth/mailbox-login-code/request",
                   body: json(["address": address.trimmingCharacters(in: .whitespaces).lowercased()]))
    }
    static func verifyLoginCode(address: String, code: String) -> APIRequest {
        APIRequest(method: "POST", path: "/auth/mailbox-login-code/verify",
                   body: json(["address": address.trimmingCharacters(in: .whitespaces).lowercased(),
                               "code": code.trimmingCharacters(in: .whitespaces)]))
    }
    static let challengeSecondFactor = APIRequest(method: "POST", path: "/auth/mailbox-2fa/challenge")
    static func verifySecondFactor(code: String) -> APIRequest {
        APIRequest(method: "POST", path: "/auth/mailbox-2fa/verify", body: json(["code": code.trimmingCharacters(in: .whitespaces)]))
    }
    static let me = APIRequest(path: "/auth/mailbox/me")
    static let switchable = APIRequest(path: "/auth/mailbox/switchable")
    static func switchMailbox(_ id: String) -> APIRequest {
        APIRequest(method: "POST", path: "/auth/mailbox/switch", body: json(["mailbox_id": id]))
    }
    static let logout = APIRequest(method: "POST", path: "/auth/mailbox/logout", timeout: 10)

    // MARK: Folders
    static func folders(_ mb: String) -> APIRequest { APIRequest(path: box(mb) + "/folders") }
    static func folderCounts(_ mb: String) -> APIRequest { APIRequest(path: box(mb) + "/folder-counts") }
    static func quota(_ mb: String) -> APIRequest { APIRequest(path: box(mb) + "/quota") }

    // MARK: Lists
    static func conversations(_ mb: String, folder: String, limit: Int, offset: Int) -> APIRequest {
        APIRequest(path: box(mb) + "/conversations", query: q([("folder", folder), ("limit", "\(limit)"), ("offset", "\(offset)")]))
    }
    static func messages(_ mb: String, folder: String, limit: Int, offset: Int) -> APIRequest {
        APIRequest(path: box(mb) + "/messages", query: q([("folder", folder), ("limit", "\(limit)"), ("offset", "\(offset)")]))
    }
    static func search(_ mb: String, query text: String, folder: String, limit: Int, offset: Int) -> APIRequest {
        APIRequest(path: box(mb) + "/search", query: q([("q", String(text.prefix(256))), ("folder", folder), ("limit", "\(limit)"), ("offset", "\(offset)")]))
    }

    // MARK: Reader
    static func conversation(_ mb: String, uid: Int, folder: String, limit: Int = 10, before: Int? = nil,
                             markSeen: Bool = false, bodies: String = "anchor") -> APIRequest {
        APIRequest(path: box(mb) + "/conversation",
                   query: q([("uid", "\(uid)"), ("folder", folder), ("limit", "\(limit)"), ("before", before.map(String.init)),
                             ("mark_seen", markSeen ? "true" : "false"), ("bodies", bodies)]))
    }
    static func conversationBody(_ mb: String, uid: Int, folder: String) -> APIRequest {
        APIRequest(path: box(mb) + "/conversation/\(uid)/body", query: q([("folder", folder)]))
    }
    static func message(_ mb: String, uid: Int, folder: String) -> APIRequest {
        APIRequest(path: box(mb) + "/messages/\(uid)", query: q([("folder", folder)]))
    }
    static func markThreadRead(_ mb: String, uid: Int, folder: String, sender: String? = nil) -> APIRequest {
        APIRequest(method: "POST", path: box(mb) + "/conversation/\(uid)/mark-read", query: q([("folder", folder), ("sender", sender)]))
    }
    static func attachment(_ mb: String, uid: Int, partId: String, folder: String) -> APIRequest {
        APIRequest(path: box(mb) + "/attachments/\(uid)/\(partId)", query: q([("folder", folder), ("inline", "false")]), timeout: 120)
    }

    // MARK: Actions
    private struct FlagsBody: Encodable { var seen: Bool?; var flagged: Bool? }
    private struct BatchBody: Encodable { var uids: [Int]; var seen: Bool?; var flagged: Bool?; var toFolder: String? }
    static func batch(_ mb: String, action: BatchAction, uids: [Int], folder: String) -> APIRequest {
        var body = BatchBody(uids: uids)
        var name = ""
        switch action {
        case .archive: name = "archive"
        case .trash: name = "delete"
        case .junk: name = "spam"
        case .notJunk: name = "not-spam"
        case .permanent: name = "permanent"
        case let .move(to): name = "move"; body.toFolder = to
        case let .seen(v): name = "flags"; body.seen = v
        case let .flagged(v): name = "flags"; body.flagged = v
        }
        return APIRequest(method: "POST", path: box(mb) + "/messages/batch/\(name)", query: q([("folder", folder)]), body: json(body))
    }
    static func resolve(_ mb: String, messageId: String, folder: String) -> APIRequest {
        APIRequest(path: box(mb) + "/messages/resolve", query: q([("message_id", messageId), ("folder", folder)]))
    }

    // MARK: Avatars
    static func avatars(_ mb: String, emails: [String]) -> APIRequest {
        APIRequest(method: "POST", path: box(mb) + "/avatars/batch", body: json(["emails": emails]))
    }

    // MARK: Compose
    struct SendPayload: Encodable, Equatable, Sendable {
        var to: [String]
        var cc: [String]?
        var bcc: [String] = []
        var subject: String
        var text: String?
        var html: String?
        var inReplyTo: String?
        var references: String?
        var replyUid: Int?
        var replyFolder: String?
        var fileIds: [String]?
        var omitHeader = false
        var replaceUid: Int?
        var opId: String?
    }
    static func send(_ mb: String, _ p: SendPayload) -> APIRequest {
        var p = p; p.replaceUid = nil; p.opId = nil
        return APIRequest(method: "POST", path: box(mb) + "/send", body: json(p), timeout: 120)
    }
    static func saveDraft(_ mb: String, _ p: SendPayload) -> APIRequest {
        APIRequest(method: "POST", path: box(mb) + "/drafts", body: json(p), timeout: 60)
    }
    static func createUpload(mailbox: String, filename: String, mime: String, size: Int) -> APIRequest {
        struct B: Encodable { var filename: String; var mime: String; var size: Int; var access: String; var mailboxId: String; var expiresInDays: Int }
        return APIRequest(method: "POST", path: "/v1/files/", body: json(B(filename: filename, mime: mime, size: size, access: "link", mailboxId: mailbox, expiresInDays: 30)))
    }
    static func stageAttachments(_ mb: String, uid: Int, folder: String) -> APIRequest {
        APIRequest(method: "POST", path: box(mb) + "/messages/\(uid)/stage-attachments", query: q([("folder", folder)]))
    }
    static func completeUpload(_ id: String) -> APIRequest { APIRequest(method: "POST", path: "/v1/files/\(id)/complete") }
    static func contacts(query text: String) -> APIRequest {
        APIRequest(path: "/v1/mailbox/contacts/", query: q([("q", text), ("limit", "8")]))
    }

    // MARK: Settings
    static let blocks = APIRequest(path: "/v1/mailbox/blocks")
    static func createBlock(name: String, html: String, text: String) -> APIRequest {
        struct B: Encodable { var blockType = "signature"; var name: String; var html: String; var text: String; var isDefault = true }
        return APIRequest(method: "POST", path: "/v1/mailbox/blocks", body: json(B(name: name, html: html, text: text)))
    }
    static func updateBlock(_ id: String, html: String, text: String) -> APIRequest {
        struct B: Encodable { var html: String; var text: String; var isDefault = true }
        return APIRequest(method: "PATCH", path: "/v1/mailbox/blocks/\(id)", body: json(B(html: html, text: text)))
    }
    static let autoresponder = APIRequest(path: "/v1/mailbox/autoresponder")
    static func putAutoresponder(_ a: AutoResponder) -> APIRequest {
        APIRequest(method: "PUT", path: "/v1/mailbox/autoresponder", body: json(a))
    }
    static let settings = APIRequest(path: "/v1/mailbox/settings")
}
