import Foundation

// Wire models, copied from the backend Pydantic models (see docs/native/API_CONTRACT.md).
// Decoding uses convertFromSnakeCase; every field the server may omit has a default.

struct MailboxSession: Codable, Equatable, Sendable {
    var mailboxId: String
    var address: String
    var orgId: String?
    var displayName: String?
    var institution: String?
    var avatarUrl: String?
    var mustChangePassword: Bool?
    var needsRecoveryEmail: Bool?

    /// First login setup outstanding: the app cannot enter the mailbox until it is done on the web.
    var needsWebSetup: Bool { mustChangePassword == true || needsRecoveryEmail == true }
}

/// Answer of the sign-in, sign-in code verify and second factor endpoints.
struct LoginResponse: Decodable, Sendable {
    var mailboxId: String?
    var address: String?
    var orgId: String?
    var requires2fa: Bool?

    private struct Key: CodingKey {
        var stringValue: String; var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    init(from decoder: Decoder) throws {
        // The key `requires_2fa` has a digit, which the snake case key strategy does not map reliably,
        // so match every spelling the strategy may produce.
        let c = try decoder.container(keyedBy: Key.self)
        func str(_ names: [String]) -> String? { names.lazy.compactMap { try? c.decodeIfPresent(String.self, forKey: Key(stringValue: $0)!) }.first }
        mailboxId = str(["mailboxId", "mailbox_id"])
        address = str(["address"])
        orgId = str(["orgId", "org_id"])
        requires2fa = ["requires_2fa", "requires2fa", "requires2Fa"].lazy.compactMap { try? c.decodeIfPresent(Bool.self, forKey: Key(stringValue: $0)!) }.first
    }
}

enum LoginOutcome: Equatable, Sendable {
    case signedIn(MailboxSession)
    case secondFactor(address: String)
}

struct SwitchableMailbox: Codable, Equatable, Identifiable, Sendable {
    var mailboxId: String
    var address: String
    var displayName: String?
    var avatarUrl: String?
    var access: String?
    var id: String { mailboxId }
}

enum FolderRole: String, Sendable {
    case inbox, drafts, sent, archive, junk, quarantine, trash, other

    /// Webmail FOLDER_SPECIAL_ORDER: Inbox, Sent, Drafts, Archive, Junk, Quarantine, Trash, then the rest.
    var sortOrder: Int {
        switch self {
        case .inbox: 0
        case .sent: 1
        case .drafts: 2
        case .archive: 3
        case .junk: 4
        case .quarantine: 5
        case .trash: 6
        case .other: 7
        }
    }

    var iconName: String {
        switch self {
        case .inbox: "inbox"
        case .drafts: "drafts"
        case .sent: "sent"
        case .archive: "archive"
        case .junk, .quarantine: "junk"
        case .trash: "trash"
        case .other: "folder"
        }
    }
}

struct Folder: Codable, Equatable, Identifiable, Sendable {
    var name: String
    var path: String
    var specialUse: String?
    var unseen: Int?
    var total: Int?
    var id: String { path }

    /// special_use first (the server maps IMAP attributes to names), then the name
    /// aliases of the backend's `_folder_section_key` (api/inbox.py:2315).
    var role: FolderRole {
        switch (specialUse ?? "").lowercased() {
        case "sent": return .sent
        case "drafts": return .drafts
        case "trash": return .trash
        case "junk": return .junk
        case "archive": return .archive
        default: break
        }
        let leaf = (path.split(separator: "/").last.map(String.init) ?? name).lowercased()
        if path.lowercased() == "inbox" || leaf == "inbox" { return .inbox }
        if ["sent", "sent items", "sent mail"].contains(leaf) { return .sent }
        if ["drafts", "draft"].contains(leaf) { return .drafts }
        if ["trash", "deleted", "deleted items", "deleted messages", "bin"].contains(leaf) { return .trash }
        if ["junk", "spam", "junk email", "junk e-mail"].contains(leaf) { return .junk }
        if leaf == "archive" { return .archive }
        if leaf == "quarantine" { return .quarantine }
        return .other
    }
}

struct FolderCount: Codable, Equatable, Sendable {
    var path: String
    var unseen: Int
    var total: Int
}

struct Quota: Codable, Equatable, Sendable {
    var usedBytes: Int
    var limitBytes: Int?
    var percent: Double?
}

enum AuthLevel: String, Codable, Sendable { case warning, danger }

struct Envelope: Codable, Equatable, Identifiable, Sendable {
    var uid: Int
    var folder: String
    var messageId: String
    var subject: String
    var fromName: String
    var fromAddr: String
    var to: [String]
    var date: String
    var seen: Bool
    var flagged: Bool
    var answered: Bool
    var keywords: [String]
    var important: Bool
    var hasAttachments: Bool
    var snippet: String
    var category: String
    var authLevel: AuthLevel?
    var authCode: String?
    var senderVerified: Bool
    var authWarned: Bool

    var id: String { "\(folder)#\(uid)" }

    init(uid: Int, folder: String, messageId: String = "", subject: String, fromName: String, fromAddr: String,
         to: [String] = [], date: String, seen: Bool = true, flagged: Bool = false, answered: Bool = false,
         keywords: [String] = [], important: Bool = false, hasAttachments: Bool = false, snippet: String = "",
         category: String = "primary", authLevel: AuthLevel? = nil, authCode: String? = nil,
         senderVerified: Bool = false, authWarned: Bool = false) {
        self.uid = uid; self.folder = folder; self.messageId = messageId; self.subject = subject
        self.fromName = fromName; self.fromAddr = fromAddr; self.to = to; self.date = date; self.seen = seen
        self.flagged = flagged; self.answered = answered; self.keywords = keywords; self.important = important
        self.hasAttachments = hasAttachments; self.snippet = snippet; self.category = category
        self.authLevel = authLevel; self.authCode = authCode; self.senderVerified = senderVerified
        self.authWarned = authWarned
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        uid = try c.decode(Int.self, forKey: .uid)
        folder = try c.decodeIfPresent(String.self, forKey: .folder) ?? "INBOX"
        messageId = try c.decodeIfPresent(String.self, forKey: .messageId) ?? ""
        subject = try c.decodeIfPresent(String.self, forKey: .subject) ?? ""
        fromName = try c.decodeIfPresent(String.self, forKey: .fromName) ?? ""
        fromAddr = try c.decodeIfPresent(String.self, forKey: .fromAddr) ?? ""
        to = try c.decodeIfPresent([String].self, forKey: .to) ?? []
        date = try c.decodeIfPresent(String.self, forKey: .date) ?? ""
        seen = try c.decodeIfPresent(Bool.self, forKey: .seen) ?? false
        flagged = try c.decodeIfPresent(Bool.self, forKey: .flagged) ?? false
        answered = try c.decodeIfPresent(Bool.self, forKey: .answered) ?? false
        keywords = try c.decodeIfPresent([String].self, forKey: .keywords) ?? []
        important = try c.decodeIfPresent(Bool.self, forKey: .important) ?? false
        hasAttachments = try c.decodeIfPresent(Bool.self, forKey: .hasAttachments) ?? false
        snippet = try c.decodeIfPresent(String.self, forKey: .snippet) ?? ""
        category = try c.decodeIfPresent(String.self, forKey: .category) ?? "primary"
        authLevel = try c.decodeIfPresent(AuthLevel.self, forKey: .authLevel)
        authCode = try c.decodeIfPresent(String.self, forKey: .authCode)
        senderVerified = try c.decodeIfPresent(Bool.self, forKey: .senderVerified) ?? false
        authWarned = try c.decodeIfPresent(Bool.self, forKey: .authWarned) ?? false
    }

    var sentAt: Date? { MailDate.parse(date) }
}

struct ConversationSummary: Codable, Equatable, Identifiable, Sendable {
    var threadKey: String
    var latest: Envelope
    var count: Int
    var unread: Bool
    var uids: [Int]
    var id: String { threadKey }

    init(threadKey: String, latest: Envelope, count: Int, unread: Bool, uids: [Int]) {
        self.threadKey = threadKey; self.latest = latest; self.count = count; self.unread = unread; self.uids = uids
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        threadKey = try c.decode(String.self, forKey: .threadKey)
        latest = try c.decode(Envelope.self, forKey: .latest)
        count = try c.decodeIfPresent(Int.self, forKey: .count) ?? 1
        unread = try c.decodeIfPresent(Bool.self, forKey: .unread) ?? false
        uids = try c.decodeIfPresent([Int].self, forKey: .uids) ?? []
    }
}

struct ConversationList: Codable, Equatable, Sendable {
    var folder: String
    var total: Int
    var limit: Int
    var offset: Int
    var items: [ConversationSummary]
    var incomplete: Bool?
}

struct MessageList: Codable, Equatable, Sendable {
    var folder: String
    var total: Int
    var limit: Int
    var offset: Int
    var items: [Envelope]
    var incomplete: Bool?
    var incompleteReason: String?
}

struct Attachment: Codable, Equatable, Identifiable, Sendable {
    var partId: String
    var filename: String
    var contentType: String
    var size: Int
    var id: String { partId }
}

struct AuthReason: Codable, Equatable, Sendable { var code: String; var label: String }

struct AuthWarning: Codable, Equatable, Sendable {
    enum Level: String, Codable, Sendable { case info, warning, danger }
    var level: Level
    var code: String
    var title: String
    var message: String
    var claimedDomain: String?
    var reasons: [AuthReason]?
    var linksDisabled: Bool?
}

/// One message of a conversation window. The server answers either a full
/// MessageDetail (bodies=all) or a metadata shell with an optional inline body
/// (bodies=anchor|none). This superset decodes both.
struct ThreadMessage: Codable, Equatable, Identifiable, Sendable {
    var uid: Int
    var folder: String
    var subject: String
    var fromName: String
    var fromAddr: String
    var to: [String]
    var cc: [String]
    var date: String?
    var dateTs: Int?
    var seen: Bool
    var flagged: Bool
    var answered: Bool
    var messageId: String
    var references: String
    var replyTo: String
    var snippet: String
    var hasAttachments: Bool
    var authLevel: AuthLevel?
    var authWarning: AuthWarning?
    var authWarned: Bool
    var senderVerified: Bool
    var text: String?
    var html: String?
    var attachments: [Attachment]
    var bodyLoaded: Bool

    var id: String { "\(folder)#\(uid)" }

    var sentAt: Date? {
        if let ts = dateTs { return Date(timeIntervalSince1970: TimeInterval(ts)) }
        return date.flatMap(MailDate.parse)
    }

    init(uid: Int, folder: String, subject: String, fromName: String, fromAddr: String, to: [String] = [],
         cc: [String] = [], date: String? = nil, dateTs: Int? = nil, seen: Bool = true, flagged: Bool = false,
         answered: Bool = false, messageId: String = "", references: String = "", replyTo: String = "",
         snippet: String = "", hasAttachments: Bool = false, authLevel: AuthLevel? = nil,
         authWarning: AuthWarning? = nil, authWarned: Bool = false, senderVerified: Bool = false,
         text: String? = nil, html: String? = nil, attachments: [Attachment] = [], bodyLoaded: Bool = false) {
        self.uid = uid; self.folder = folder; self.subject = subject; self.fromName = fromName
        self.fromAddr = fromAddr; self.to = to; self.cc = cc; self.date = date; self.dateTs = dateTs
        self.seen = seen; self.flagged = flagged; self.answered = answered; self.messageId = messageId
        self.references = references; self.replyTo = replyTo; self.snippet = snippet
        self.hasAttachments = hasAttachments; self.authLevel = authLevel; self.authWarning = authWarning
        self.authWarned = authWarned; self.senderVerified = senderVerified; self.text = text; self.html = html
        self.attachments = attachments; self.bodyLoaded = bodyLoaded
    }

    private enum Keys: String, CodingKey {
        case uid, folder, subject, fromName, fromAddr, to, cc, date, dateTs, seen, flagged, answered, messageId
        case references, replyTo, snippet, hasAttachments, authLevel, authWarning, authWarned, senderVerified
        case text, html, attachments, body, bodyLoaded
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        // A shell may carry its full body under `body`; merge it over the shell.
        let inline = try c.decodeIfPresent(ThreadMessage.self, forKey: .body)
        uid = try c.decode(Int.self, forKey: .uid)
        folder = try c.decodeIfPresent(String.self, forKey: .folder) ?? "INBOX"
        subject = try c.decodeIfPresent(String.self, forKey: .subject) ?? inline?.subject ?? ""
        fromName = try c.decodeIfPresent(String.self, forKey: .fromName) ?? ""
        fromAddr = try c.decodeIfPresent(String.self, forKey: .fromAddr) ?? ""
        to = try c.decodeIfPresent([String].self, forKey: .to) ?? []
        cc = try c.decodeIfPresent([String].self, forKey: .cc) ?? []
        date = try c.decodeIfPresent(String.self, forKey: .date)
        dateTs = try c.decodeIfPresent(Int.self, forKey: .dateTs)
        seen = try c.decodeIfPresent(Bool.self, forKey: .seen) ?? false
        flagged = try c.decodeIfPresent(Bool.self, forKey: .flagged) ?? false
        answered = try c.decodeIfPresent(Bool.self, forKey: .answered) ?? false
        messageId = try c.decodeIfPresent(String.self, forKey: .messageId) ?? ""
        references = try c.decodeIfPresent(String.self, forKey: .references) ?? inline?.references ?? ""
        replyTo = try c.decodeIfPresent(String.self, forKey: .replyTo) ?? inline?.replyTo ?? ""
        snippet = try c.decodeIfPresent(String.self, forKey: .snippet) ?? ""
        let bodyAttachments = try c.decodeIfPresent([Attachment].self, forKey: .attachments)
        attachments = bodyAttachments ?? inline?.attachments ?? []
        hasAttachments = try c.decodeIfPresent(Bool.self, forKey: .hasAttachments) ?? !attachments.isEmpty
        authLevel = try c.decodeIfPresent(AuthLevel.self, forKey: .authLevel)
        authWarning = try c.decodeIfPresent(AuthWarning.self, forKey: .authWarning) ?? inline?.authWarning
        authWarned = try c.decodeIfPresent(Bool.self, forKey: .authWarned) ?? false
        senderVerified = try c.decodeIfPresent(Bool.self, forKey: .senderVerified) ?? false
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? inline?.text
        html = try c.decodeIfPresent(String.self, forKey: .html) ?? inline?.html
        let hasBody = (try c.contains(.text)) || (try c.contains(.html)) || inline != nil
        bodyLoaded = try c.decodeIfPresent(Bool.self, forKey: .bodyLoaded) ?? hasBody
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(uid, forKey: .uid); try c.encode(folder, forKey: .folder)
        try c.encode(subject, forKey: .subject); try c.encode(fromName, forKey: .fromName)
        try c.encode(fromAddr, forKey: .fromAddr); try c.encode(to, forKey: .to); try c.encode(cc, forKey: .cc)
        try c.encodeIfPresent(date, forKey: .date); try c.encodeIfPresent(dateTs, forKey: .dateTs)
        try c.encode(seen, forKey: .seen); try c.encode(flagged, forKey: .flagged)
        try c.encode(answered, forKey: .answered); try c.encode(messageId, forKey: .messageId)
        try c.encode(references, forKey: .references); try c.encode(replyTo, forKey: .replyTo)
        try c.encode(snippet, forKey: .snippet); try c.encode(hasAttachments, forKey: .hasAttachments)
        try c.encodeIfPresent(authLevel, forKey: .authLevel); try c.encodeIfPresent(authWarning, forKey: .authWarning)
        try c.encode(authWarned, forKey: .authWarned); try c.encode(senderVerified, forKey: .senderVerified)
        try c.encodeIfPresent(text, forKey: .text); try c.encodeIfPresent(html, forKey: .html)
        try c.encode(attachments, forKey: .attachments); try c.encode(bodyLoaded, forKey: .bodyLoaded)
    }

    /// The verdict fields the avatar decision reads.
    var authState: MessageAuthState {
        MessageAuthState(authLevel: authLevel, hasAuthWarning: authWarning != nil, authWarned: authWarned,
                         senderVerified: senderVerified)
    }
}

struct ConversationWindow: Codable, Equatable, Sendable {
    var messages: [ThreadMessage]
    var sourceUidvalidity: Int?
    var total: Int
    var hasMoreOlder: Bool
    var nextBefore: Int

    init(messages: [ThreadMessage], sourceUidvalidity: Int? = nil, total: Int, hasMoreOlder: Bool, nextBefore: Int) {
        self.messages = messages; self.sourceUidvalidity = sourceUidvalidity; self.total = total
        self.hasMoreOlder = hasMoreOlder; self.nextBefore = nextBefore
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messages = try c.decode([ThreadMessage].self, forKey: .messages)
        sourceUidvalidity = try c.decodeIfPresent(Int.self, forKey: .sourceUidvalidity)
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? messages.count
        hasMoreOlder = try c.decodeIfPresent(Bool.self, forKey: .hasMoreOlder) ?? false
        nextBefore = try c.decodeIfPresent(Int.self, forKey: .nextBefore) ?? 0
    }
}

struct MarkReadResult: Codable, Equatable, Sendable {
    var marked: Int
    var folders: [String: Int]
    var uids: [String: [Int]]
    var complete: Bool
    var failedFolders: [String]
}

struct BatchFailure: Codable, Equatable, Sendable { var uid: Int; var reason: String }

struct BatchResult: Codable, Equatable, Sendable {
    var ok: Bool
    var requested: Int
    var succeeded: [Int]
    var failed: [BatchFailure]
}

struct OkResponse: Codable, Equatable, Sendable { var ok: Bool }

struct SendResult: Codable, Equatable, Sendable {
    var ok: Bool
    var messageId: String
    var suppressed: [String]
    var refused: [String]

    init(ok: Bool, messageId: String, suppressed: [String] = [], refused: [String] = []) {
        self.ok = ok; self.messageId = messageId; self.suppressed = suppressed; self.refused = refused
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? true
        messageId = try c.decodeIfPresent(String.self, forKey: .messageId) ?? ""
        suppressed = try c.decodeIfPresent([String].self, forKey: .suppressed) ?? []
        refused = try c.decodeIfPresent([String].self, forKey: .refused) ?? []
    }
}

struct DraftResult: Codable, Equatable, Sendable { var uid: Int?; var folder: String }

struct InstitutionLogo: Codable, Equatable, Sendable { var name: String?; var logoUrl: String }

struct AvatarEntry: Codable, Equatable, Sendable {
    var url: String?
    var name: String?
    var urlScope: String?
    var institution: InstitutionLogo?
}

struct AvatarBatchResponse: Codable, Sendable { var results: [String: AvatarEntry] }

struct StoredFile: Codable, Equatable, Sendable {
    var id: String
    var filename: String
    var mime: String?
    var sizeBytes: Int?
    var status: String?
    var scanVerdict: String?

    /// Terminal bad outcomes of the virus scan.
    var isRejected: Bool {
        let st = (status ?? "").lowercased(), v = (scanVerdict ?? "").lowercased()
        return ["infected", "quarantined", "rejected", "failed", "blocked", "error"].contains(st) || v.contains("infected") || v.contains("malware")
    }
    var isReady: Bool { (status ?? "").lowercased() == "ready" }
}

struct UploadTicket: Codable, Sendable {
    struct Upload: Codable, Sendable { var url: String; var method: String; var headers: [String: String] }
    var file: StoredFile
    var upload: Upload
}

struct FileEnvelope: Codable, Sendable { var file: StoredFile }

struct MailBlock: Decodable, Equatable, Identifiable, Sendable {
    var id: String
    var blockType: String
    var name: String
    var html: String
    var text: String?
    var isDefault: Bool
    var scope: String?
    /// True when the web builder stored a structured config: such a block must not be overwritten with plain text.
    var hasConfig = false

    init(id: String, blockType: String, name: String, html: String, text: String?, isDefault: Bool, scope: String?, hasConfig: Bool = false) {
        self.id = id; self.blockType = blockType; self.name = name; self.html = html; self.text = text
        self.isDefault = isDefault; self.scope = scope; self.hasConfig = hasConfig
    }

    private enum Keys: String, CodingKey { case id, blockType, name, html, text, isDefault, scope, config }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        blockType = try c.decodeIfPresent(String.self, forKey: .blockType) ?? "signature"
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        html = try c.decodeIfPresent(String.self, forKey: .html) ?? ""
        text = try c.decodeIfPresent(String.self, forKey: .text)
        isDefault = try c.decodeIfPresent(Bool.self, forKey: .isDefault) ?? false
        scope = try c.decodeIfPresent(String.self, forKey: .scope)
        hasConfig = c.contains(.config) ? !(try c.decodeNil(forKey: .config)) : false
    }

    /// Plain text of the block: the text field, else the HTML with tags removed.
    var plainText: String {
        if let t = text, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return t }
        return html.replacingOccurrences(of: "<br\\s*/?>", with: "\n", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
    }
}

struct MailBlocks: Decodable, Equatable, Sendable {
    var signatures: [MailBlock]
    var headers: [MailBlock]?
    var footers: [MailBlock]?
}

struct AutoResponder: Codable, Equatable, Sendable {
    var enabled: Bool
    var subject: String
    var html: String
    var text: String
    var mode: String
    var startAt: String?
    var endAt: String?
    var days: [Int]
    var startHour: Int
    var endHour: Int

    static let empty = AutoResponder(enabled: false, subject: "", html: "", text: "", mode: "always",
                                     startAt: nil, endAt: nil, days: [], startHour: 9, endHour: 17)
}

struct MailboxSettings: Codable, Equatable, Sendable {
    var id: String?
    var displayName: String?
    var address: String
    var quota: Quota?
    var trustedImageSenders: [String]?
}

struct ContactEmail: Codable, Equatable, Sendable {
    var type: String?
    var value: String
    var primary: Bool?
}

/// One address book contact (GET /v1/mailbox/contacts/ answers a bare array of these; emails are objects).
struct Contact: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var displayName: String?
    var emails: [ContactEmail]?

    /// Primary address first.
    var addresses: [String] {
        (emails ?? []).sorted { ($0.primary ?? false) && !($1.primary ?? false) }.map(\.value).filter { !$0.isEmpty }
    }
}

/// A message envelope is enough to render a row; the reader loads the rest.
enum MailDate {
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f
    }()
    private static let isoFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private static let rfc: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEE, d MMM yyyy HH:mm:ss Z"; return f
    }()

    static func parse(_ s: String) -> Date? {
        if s.isEmpty { return nil }
        return iso.date(from: s) ?? isoFraction.date(from: s) ?? rfc.date(from: s)
    }
}


struct ResolvedMessage: Codable, Equatable, Sendable { var folder: String; var uid: Int }

/// A mutation applied to a set of UIDs of one folder (POST /messages/batch/...).
enum BatchAction: Equatable, Sendable {
    case archive, trash, junk, notJunk, permanent
    case move(to: String)
    case seen(Bool)
    case flagged(Bool)
}

struct StagedAttachment: Codable, Equatable, Sendable {
    var fileId: String
    var filename: String
    var contentType: String
    var size: Int
}
struct StagedAttachments: Codable, Sendable { var files: [StagedAttachment] }
