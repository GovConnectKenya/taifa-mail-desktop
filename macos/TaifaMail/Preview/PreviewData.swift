#if DEBUG
import Foundation
import AppKit

// DEBUG ONLY. Fixture backed preview mode (launch argument -TaifaPreviewData). This whole file is
// compiled out of Release builds; macos/scripts/check-release-no-preview.sh proves it.
// Every name and address below is invented. Addresses use the example.go.ke style.

enum PreviewFixtures {
    static let me = MailboxSession(mailboxId: "00000000-0000-4000-8000-000000000001", address: "wanjiku.kamau@health.example.go.ke",
                                   orgId: nil, displayName: "Wanjiku Kamau", institution: "Ministry of Health (example)", avatarUrl: nil)

    static let folders: [Folder] = [
        Folder(name: "INBOX", path: "INBOX", specialUse: nil, unseen: 14, total: 1200),
        Folder(name: "Drafts", path: "Drafts", specialUse: "drafts", unseen: 0, total: 2),
        Folder(name: "Sent", path: "Sent", specialUse: "sent", unseen: 0, total: 48),
        Folder(name: "Archive", path: "Archive", specialUse: "archive", unseen: 0, total: 310),
        Folder(name: "Junk", path: "Junk", specialUse: "junk", unseen: 3, total: 9),
        Folder(name: "Trash", path: "Trash", specialUse: "trash", unseen: 0, total: 21),
        Folder(name: "Budget 2027", path: "Projects/Budget 2027", specialUse: nil, unseen: 2, total: 37),
        Folder(name: "Procurement", path: "Procurement", specialUse: nil, unseen: 0, total: 64),
    ]

    static let people: [(name: String, addr: String)] = [
        ("Amina Wanjiru", "amina.wanjiru@treasury.example.go.ke"), ("Brian Otieno", "brian.otieno@education.example.go.ke"),
        ("Grace Mutua", "grace.mutua@nairobi.example.go.ke"), ("Peter Kiprop", "peter.kiprop@roads.example.go.ke"),
        ("Fatuma Hassan", "fatuma.hassan@mombasa.example.go.ke"), ("Joseph Njoroge", "joseph.njoroge@icta.example.go.ke"),
        ("Lucy Achieng", "lucy.achieng@health.example.go.ke"), ("David Mwangi", "david.mwangi@lands.example.go.ke"),
        ("Esther Chebet", "esther.chebet@water.example.go.ke"), ("Samuel Odhiambo", "samuel.odhiambo@kisumu.example.go.ke"),
    ]

    static let subjects = [
        "Q3 budget review meeting", "Procurement plan for FY 2026/27", "Draft circular on remote work", "Clinic supplies delivery schedule",
        "Minutes of the steering committee", "Please review the attached tender document", "County liaison visit next week",
        "Network outage report", "Training calendar for new staff", "Updated leave roster", "Reminder: submit your timesheet",
        "Revised terms of reference", "Invitation: digital government workshop", "Audit queries, round two",
    ]
    static let snippets = [
        "Please find the latest figures attached. Let me know if the totals reconcile with your records.",
        "Following our call this morning, I have updated the plan and shared it with the team.",
        "Kindly confirm your availability for Thursday so we can finalise the agenda.",
        "The supplier has confirmed delivery for the end of the month, pending final approval.",
        "Attached are the minutes. Action owners are highlighted, please respond by Friday.",
    ]

    /// Fixed reference time so screenshots are stable: 2026-11-13 09:30 local.
    static let now: Date = {
        var c = DateComponents(); c.year = 2026; c.month = 11; c.day = 13; c.hour = 9; c.minute = 30
        return Calendar.current.date(from: c) ?? Date()
    }()

    static func iso(_ d: Date) -> String { ISO8601DateFormatter().string(from: d) }

    static func envelope(_ i: Int, folder: String = "INBOX") -> Envelope {
        let p = people[i % people.count]
        let unread = folder == "INBOX" && i % 7 < 2
        let date = now.addingTimeInterval(-Double(i) * 5_400 - Double(i % 3) * 600)
        var e = Envelope(uid: 5000 - i, folder: folder, messageId: "<fx\(i)@example.go.ke>", subject: subjects[i % subjects.count],
                         fromName: p.name, fromAddr: p.addr, to: [me.address], date: iso(date), seen: !unread, flagged: i % 11 == 3,
                         hasAttachments: i % 5 == 0, snippet: snippets[i % snippets.count])
        if folder == "Sent" || folder == "Drafts" { e.fromName = me.displayName ?? ""; e.fromAddr = me.address; e.to = ["\(p.name) <\(p.addr)>"]; e.seen = true }
        if i == 4 { e.authLevel = .warning; e.authCode = "spf_fail" }
        if i % 4 == 1 { e.senderVerified = true }
        return e
    }

    static func summary(_ i: Int, folder: String = "INBOX") -> ConversationSummary {
        let e = envelope(i, folder: folder)
        let count = i % 6 == 0 ? 4 : (i % 9 == 2 ? 2 : 1)
        return ConversationSummary(threadKey: "\(folder)#\(e.uid)", latest: e, count: count, unread: !e.seen, uids: [e.uid])
    }

    static func total(for folder: String) -> Int { folders.first(where: { $0.path == folder })?.total ?? 0 }

    static let htmlBody = """
    <div style="font-family:sans-serif">
    <p>Dear colleagues,</p>
    <p>The quarterly review is scheduled for <b>Thursday at 10:00</b>. Please bring your updated figures. The summary table is below.</p>
    <table border="0" cellpadding="6" style="border-collapse:collapse"><tr style="background:#eee"><th align="left">Programme</th><th align="right">Spend (KES m)</th></tr>
    <tr><td>Primary care</td><td align="right">412.5</td></tr><tr><td>Vaccination</td><td align="right">198.0</td></tr><tr><td>Facilities</td><td align="right">86.3</td></tr></table>
    <p><img src="https://images.example.com/logo.png" alt="Remote logo" width="120" height="40"></p>
    <blockquote>Please check the figures against the ledger before the meeting.</blockquote>
    <p>Details: <a href="https://www.example.go.ke/budget/q3">budget page</a>.</p><p>Regards,<br>Amina</p></div>
    """

    static func thread(for uid: Int, folder: String) -> ConversationWindow {
        let i = max(0, 5000 - uid)
        let p = people[i % people.count]
        let subject = subjects[i % subjects.count]
        func msg(_ n: Int, mine: Bool, html: Bool = false, seen: Bool = true) -> ThreadMessage {
            let from = mine ? (me.displayName ?? "", me.address) : (p.name, p.addr)
            return ThreadMessage(uid: uid - 100 - n, folder: folder, subject: (n == 0 ? "" : "Re: ") + subject, fromName: from.0, fromAddr: from.1,
                                 to: mine ? [p.addr] : [me.address], cc: n == 1 ? ["registry@health.example.go.ke"] : [],
                                 date: iso(now.addingTimeInterval(-Double(4 - n) * 7_200)), dateTs: Int(now.addingTimeInterval(-Double(4 - n) * 7_200).timeIntervalSince1970),
                                 seen: seen, messageId: "<m\(n)-\(uid)@example.go.ke>", snippet: snippets[(i + n) % snippets.count],
                                 hasAttachments: n == 0, authWarning: nil, senderVerified: !mine,
                                 text: html ? nil : "Hello,\n\n\(snippets[(i + n) % snippets.count])\n\nSee https://www.example.go.ke/notes for the background.\n\nThanks,\n\(from.0)",
                                 html: html ? htmlBody : nil,
                                 attachments: n == 0 ? [Attachment(partId: "2", filename: "Q3-budget-summary.pdf", contentType: "application/pdf", size: 482_113),
                                                        Attachment(partId: "3", filename: "figures.xlsx", contentType: "application/vnd.ms-excel", size: 52_300)] : [],
                                 bodyLoaded: true)
        }
        var messages = [msg(0, mine: false), msg(1, mine: true), msg(2, mine: false), msg(3, mine: true, seen: true)]
        if i % 2 == 0 { messages[3] = msg(3, mine: false, html: true, seen: false) }
        if i == 4 {
            messages[3].authWarning = AuthWarning(level: .warning, code: "spf_fail", title: "This message could not be verified",
                                                  message: "The sender's domain did not pass authentication. Be careful with links and attachments.",
                                                  claimedDomain: "treasury.example.go.ke", reasons: [AuthReason(code: "spf", label: "SPF failed")], linksDisabled: true)
        }
        return ConversationWindow(messages: messages, sourceUidvalidity: 1, total: messages.count, hasMoreOlder: false, nextBefore: 0)
    }

    // Generated avatar and logo images (no files, no network).
    static func imageData(for url: String) -> Data? {
        let isLogo = url.contains("logo")
        let size = NSSize(width: 128, height: 128)
        let img = NSImage(size: size, flipped: false) { rect in
            let hue = CGFloat(abs(url.hashValue) % 100) / 100
            (isLogo ? NSColor.white : NSColor(hue: hue, saturation: 0.45, brightness: 0.75, alpha: 1)).setFill()
            rect.fill()
            if isLogo {
                NSColor(hex: 0x006900).setFill(); NSBezierPath(roundedRect: rect.insetBy(dx: 28, dy: 28), xRadius: 14, yRadius: 14).fill()
                NSColor(hex: 0x860000).setFill(); NSBezierPath(rect: NSRect(x: 28, y: 56, width: 72, height: 16)).fill()
            }
            return true
        }
        guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }
}

struct PreviewMailService: MailService {
    let mailboxId = PreviewFixtures.me.mailboxId
    var state: String = "loaded"   // loaded, loading, empty, error, offline

    private func gate() async throws {
        switch state {
        case "loading": try await Task.sleep(nanoseconds: 3_600_000_000_000)
        case "error": throw APIError.http(status: 502, code: nil, message: "The mail server did not answer. Try again in a moment.")
        default: break
        }
    }

    func folders() async throws -> [Folder] {
        try await gate()
        return state == "empty" ? PreviewFixtures.folders.map { var f = $0; f.unseen = 0; f.total = 0; return f } : PreviewFixtures.folders
    }
    func folderCounts() async throws -> [FolderCount] { PreviewFixtures.folders.map { FolderCount(path: $0.path, unseen: $0.unseen ?? 0, total: $0.total ?? 0) } }
    func quota() async throws -> Quota? { Quota(usedBytes: 3_400_000_000, limitBytes: 10_000_000_000, percent: 34) }

    func conversations(folder: String, offset: Int, limit: Int) async throws -> ConversationList {
        try await gate()
        let total = state == "empty" ? 0 : PreviewFixtures.total(for: folder)
        let items = (offset..<min(total, offset + limit)).map { PreviewFixtures.summary($0, folder: folder) }
        return ConversationList(folder: folder, total: total, limit: limit, offset: offset, items: items)
    }
    func messages(folder: String, offset: Int, limit: Int) async throws -> MessageList {
        try await gate()
        let total = state == "empty" ? 0 : PreviewFixtures.total(for: folder)
        return MessageList(folder: folder, total: total, limit: limit, offset: offset,
                           items: (offset..<min(total, offset + limit)).map { PreviewFixtures.envelope($0, folder: folder) })
    }
    func search(query: String, folder: String, offset: Int, limit: Int) async throws -> MessageList {
        try await gate()
        let q = query.lowercased()
        let hits = (0..<200).map { PreviewFixtures.envelope($0, folder: folder) }.filter { ($0.subject + $0.fromName + $0.snippet).lowercased().contains(q) }
        return MessageList(folder: folder, total: hits.count, limit: limit, offset: offset, items: Array(hits.dropFirst(offset).prefix(limit)))
    }
    func conversation(uid: Int, folder: String, before: Int?) async throws -> ConversationWindow { try await gate(); return PreviewFixtures.thread(for: uid, folder: folder) }
    func body(uid: Int, folder: String) async throws -> ThreadMessage { PreviewFixtures.thread(for: uid, folder: folder).messages[0] }
    func markThreadRead(uid: Int, folder: String) async throws -> MarkReadResult {
        MarkReadResult(marked: 1, folders: [folder: 1], uids: [folder: [uid]], complete: true, failedFolders: [])
    }
    func batch(action: BatchAction, uids: [Int], folder: String) async throws -> BatchResult {
        BatchResult(ok: true, requested: uids.count, succeeded: uids, failed: [])
    }
    func resolve(messageId: String, hint: String) async throws -> ResolvedMessage { ResolvedMessage(folder: hint, uid: 9000) }
    func avatars(emails: [String]) async throws -> [String: AvatarEntry] {
        var out: [String: AvatarEntry] = [:]
        for (i, e) in emails.enumerated() {
            switch i % 4 {
            case 0: out[e] = AvatarEntry(url: "/v1/avatars/mailbox/00000000-0000-4000-8000-\(String(format: "%012d", i)).webp", name: nil, urlScope: nil, institution: nil)
            case 1: out[e] = AvatarEntry(url: nil, name: nil, urlScope: nil, institution: InstitutionLogo(name: "Treasury (example)", logoUrl: "/v1/organizations/00000000-0000-4000-8000-\(String(format: "%012d", 200 + i))/logo"))
            case 2: out[e] = AvatarEntry(url: "/v1/avatars/user/00000000-0000-4000-8000-\(String(format: "%012d", 100 + i)).webp", name: nil, urlScope: "platform", institution: nil)
            default: out[e] = AvatarEntry(url: nil, name: nil, urlScope: nil, institution: nil)
            }
        }
        return out
    }
    func attachment(uid: Int, folder: String, partId: String) async throws -> Data { Data("Preview attachment".utf8) }
    func send(_ payload: Endpoints.SendPayload) async throws -> SendResult {
        try await Task.sleep(nanoseconds: 600_000_000)
        if payload.subject.contains("FAIL") { throw APIError.http(status: 502, code: nil, message: "The relay refused the message.") }
        return SendResult(ok: true, messageId: "<preview@example.go.ke>")
    }
    func saveDraft(_ payload: Endpoints.SendPayload) async throws -> DraftResult { DraftResult(uid: 77, folder: "Drafts") }
    func upload(filename: String, mime: String, data: Data) async throws -> StoredFile { StoredFile(id: UUID().uuidString, filename: filename, mime: mime, sizeBytes: data.count, status: "ready", scanVerdict: nil) }
    func contacts(matching: String) async throws -> [Contact] {
        PreviewFixtures.people.filter { ($0.name + $0.addr).lowercased().contains(matching.lowercased()) }.map { Contact(id: $0.addr, displayName: $0.name, emails: [ContactEmail(type: "work", value: $0.addr, primary: true)]) }
    }
    func stageAttachments(uid: Int, folder: String) async throws -> [StagedAttachment] { [] }
    func proxiedImage(_ url: String) async -> ImageProxy.Outcome { .failed }
    func fileStatus(_ id: String) async throws -> StoredFile { StoredFile(id: id, filename: "f", mime: nil, sizeBytes: nil, status: "ready", scanVerdict: nil) }
    func signature() async throws -> MailBlock? {
        MailBlock(id: "sig1", blockType: "signature", name: "Signature", html: "Wanjiku Kamau<br>Ministry of Health (example)", text: "Wanjiku Kamau\nMinistry of Health (example)", isDefault: true, scope: "mine")
    }
    func saveSignature(html: String, text: String, existing: MailBlock?) async throws {}
    func autoResponder() async throws -> AutoResponder {
        AutoResponder(enabled: false, subject: "Out of office", html: "", text: "I am away until Monday.", mode: "always", startAt: nil, endAt: nil, days: [], startHour: 9, endHour: 17)
    }
    func saveAutoResponder(_ a: AutoResponder) async throws {}
    func trustedImageSenders() async throws -> [String] { [] }
}

extension AppModel {
    /// Reads the preview launch arguments and fills the app with fixtures. No network, no Keychain, no account.
    func startPreview() {
        let args = ProcessInfo.processInfo.arguments
        func value(_ name: String) -> String? { args.firstIndex(of: name).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
        let state = value("-TaifaPreviewState") ?? "loaded"
        let screen = value("-TaifaPreviewScreen") ?? "main"
        ImageLoader.shared.fixtureData = { PreviewFixtures.imageData(for: $0) }
        if let t = value("-TaifaPreviewTheme"), let pref = ThemePreference(rawValue: t) { prefs.theme = pref }
        if let d = value("-TaifaPreviewDensity"), let den = Density(rawValue: d) { prefs.density = den }
        if let size = value("-TaifaPreviewWindowSize") {
            let parts = size.split(separator: "x").compactMap { Double($0) }
            if parts.count == 2 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    NSApp.windows.first(where: { $0.canBecomeMain })?.setContentSize(NSSize(width: parts[0], height: parts[1]))
                }
            }
        }
        switch screen {
        case "signin", "code", "twofactor", "signedout":
            signIn.address = "wanjiku.kamau@health.example.go.ke"
            if screen == "code" { signIn.step = .codeEntry; signIn.info = "If that mailbox exists, a sign-in code has been sent to its recovery email." }
            if screen == "twofactor" { signIn.step = .secondFactor }
            if screen == "signedout" { sessionBanner = "Your session ended. Sign in again." }
            if state == "error" { signIn.error = "Invalid address or password" }
            phase = .signedOut
        default:
            session = PreviewFixtures.me
            switchable = [SwitchableMailbox(mailboxId: "2", address: "registry@health.example.go.ke", displayName: "Registry", avatarUrl: nil, access: "full")]
            let st = MailStore(service: PreviewMailService(state: state), cache: cache)
            store = st
            phase = .signedIn
            if let f = value("-TaifaPreviewFolder") { st.selectedFolder = f }
            Task {
                await st.bootstrap()
                if let open = value("-TaifaPreviewOpen"), let uid = Int(open), let row = st.rows.first(where: { $0.latest.uid == uid }) { st.select(row.id) }
                if let q = value("-TaifaPreviewSearch") { st.searchText = q; await st.runSearch() }
                if state == "offline" { try? await Task.sleep(nanoseconds: 1_500_000_000); st.setOffline(true) }
            }
        }
    }
}
#endif
