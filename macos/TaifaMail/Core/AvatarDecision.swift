import Foundation

/// The server's verdict fields for one message (port of webmail/src/mail/sender-logo.ts MessageAuthState).
struct MessageAuthState: Equatable, Sendable {
    var authLevel: AuthLevel?
    var hasAuthWarning: Bool
    var authWarned: Bool
    var senderVerified: Bool

    init(authLevel: AuthLevel? = nil, hasAuthWarning: Bool = false, authWarned: Bool = false, senderVerified: Bool = false) {
        self.authLevel = authLevel; self.hasAuthWarning = hasAuthWarning
        self.authWarned = authWarned; self.senderVerified = senderVerified
    }

    init(_ e: Envelope) {
        self.init(authLevel: e.authLevel, hasAuthWarning: false, authWarned: e.authWarned, senderVerified: e.senderVerified)
    }

    /// A warning at ANY level.
    var warned: Bool { authLevel != nil || hasAuthWarning || authWarned }
    /// An explicit server verdict with no warning at any level.
    var verified: Bool { senderVerified && !warned }
}

enum PictureKind: Equatable, Sendable { case photo, logo, none }

struct SenderPicture: Equatable, Sendable {
    var kind: PictureKind
    var url: String?
    var label: String?
    var pending: Bool

    static let none = SenderPicture(kind: .none, url: nil, label: nil, pending: false)
    static let pendingPicture = SenderPicture(kind: .none, url: nil, label: nil, pending: true)
}

/// The ONE avatar decision (docs/native/DESIGN_SPEC.md section 7): whether a picture may be shown and which kind.
enum AvatarDecision {
    static func picture(entry: AvatarEntry?, message: MessageAuthState?, outgoing: Bool = false) -> SenderPicture {
        guard let entry else { return .pendingPicture }
        let photoURL = (entry.url?.isEmpty == false) ? entry.url : nil
        let logoURL = (entry.institution?.logoUrl.isEmpty == false) ? entry.institution?.logoUrl : nil
        func photo() -> SenderPicture { SenderPicture(kind: .photo, url: photoURL, label: entry.name, pending: false) }
        func logo() -> SenderPicture { SenderPicture(kind: .logo, url: logoURL, label: entry.institution?.name, pending: false) }
        if outgoing {
            if photoURL != nil { return photo() }
            return logoURL != nil ? logo() : .none
        }
        if message?.warned == true { return .none }
        let verified = message?.verified ?? false
        if photoURL != nil && !(entry.urlScope == "platform" && !verified) { return photo() }
        if photoURL == nil && verified && logoURL != nil { return logo() }
        return .none
    }

    /// Deterministic placeholder colour index: FNV-1a 32 bit of the lowercased address modulo 8.
    static func colorIndex(for address: String) -> Int {
        var h: UInt32 = 2166136261
        for b in address.lowercased().utf8 { h ^= UInt32(b); h = h &* 16777619 }
        return Int(h % 8)
    }

    static func initial(name: String, address: String) -> String {
        let source = name.trimmingCharacters(in: .whitespaces).isEmpty ? address : name
        guard let ch = source.first(where: { $0.isLetter || $0.isNumber }) else { return "?" }
        return String(ch).uppercased()
    }
}
