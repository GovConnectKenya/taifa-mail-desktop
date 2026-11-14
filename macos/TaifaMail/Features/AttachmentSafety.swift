import Foundation

enum AttachmentSafety {
    /// Bidirectional controls (U+202A to U+202E, U+2066 to U+2069) can disguise an extension ("invoice\u{202E}fdp.exe").
    static func sanitizedName(_ name: String) -> String {
        let bidi: Set<UInt32> = Set(0x202A...0x202E).union(0x2066...0x2069)
        var s = String(String.UnicodeScalarView(name.unicodeScalars.filter { !bidi.contains($0.value) && $0.value >= 0x20 }))
        s = s.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        while let last = s.last, last == "." || last == " " { s.removeLast() }
        return s.isEmpty ? "attachment" : s
    }

    static let executableExtensions: Set<String> = ["app", "command", "sh", "pkg", "dmg", "terminal", "scpt", "jar", "exe", "bat", "cmd", "ps1", "js", "vbs", "workflow", "action", "pif", "scr", "msi"]

    /// Executable and script types are never previewed or opened; Save is offered with a warning.
    static func isExecutable(_ name: String) -> Bool {
        executableExtensions.contains((sanitizedName(name) as NSString).pathExtension.lowercased())
    }

    /// Marks a file as downloaded from the internet so Gatekeeper and Quick Look treat it with care.
    static func quarantine(_ url: URL) {
        var u = url
        var v = URLResourceValues()
        v.quarantineProperties = [kLSQuarantineTypeKey as String: kLSQuarantineTypeOtherDownload as String, kLSQuarantineAgentNameKey as String: "Taifa Mail"]
        try? u.setResourceValues(v)
    }
}

/// Avatar and logo URLs are trusted only on the API origin and on the paths the server serves pictures from.
enum AvatarURL {
    private static let pattern = try! NSRegularExpression(
        pattern: #"^/v1/(avatars/(?:mailbox|user)/[0-9a-f-]{36}\.webp|organizations/[0-9a-f-]{36}/logo)(?:\?[\w=&.%-]*)?$"#, options: [.caseInsensitive])

    static func trusted(_ raw: String?, base: URL) -> URL? {
        let r = (raw ?? "").trimmingCharacters(in: .whitespaces)
        let b = base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !r.isEmpty, !r.hasPrefix("//") else { return nil }
        let path: String
        if r.hasPrefix("/") { path = r } else if r.hasPrefix(b + "/") { path = String(r.dropFirst(b.count)) } else { return nil }
        guard pattern.firstMatch(in: path, range: NSRange(location: 0, length: (path as NSString).length)) != nil else { return nil }
        return URL(string: b + path)
    }
}

/// What a new mail notification shows, from the message and the user's privacy preferences.
struct NotificationText: Equatable {
    var title: String
    var subtitle: String
    var body: String

    static func make(_ e: Envelope, showSenderAndSubject: Bool, showSnippet: Bool) -> NotificationText {
        let sender = e.fromName.isEmpty ? e.fromAddr : e.fromName
        // A danger verdict reveals nothing; a warning shows only who it claims to be from.
        if e.authLevel == .danger { return NotificationText(title: "New message", subtitle: "", body: "") }
        if e.authLevel != nil || e.authWarned { return NotificationText(title: showSenderAndSubject ? "New message from \(sender)" : "New message", subtitle: "", body: "") }
        guard showSenderAndSubject else { return NotificationText(title: "New message", subtitle: "", body: "") }
        return NotificationText(title: sender, subtitle: e.subject, body: showSnippet ? e.snippet : "")
    }
}
