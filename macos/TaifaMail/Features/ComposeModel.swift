import Foundation
import Observation
import AppKit
import UniformTypeIdentifiers

struct ComposeSeed: Codable, Hashable, Identifiable {
    enum Kind: String, Codable { case new, reply, replyAll, forward }
    var id = UUID()
    var kind: Kind = .new
    var to: [String] = []
    var cc: [String] = []
    var subject = ""
    var quote = ""
    var inReplyTo: String?
    var references: String?
    var replyUid: Int?
    var replyFolder: String?
    var stageUid: Int?
    var stageFolder: String?
}

/// Builds seeds and opens compose windows. The scene registers the opener.
@MainActor
final class ComposeLauncher {
    static let shared = ComposeLauncher()
    var opener: ((ComposeSeed) -> Void)?
    var ownAddress = ""

    func openNew() { opener?(ComposeSeed()) }

    func open(kind: ComposeSeed.Kind, store: MailStore, row: ConversationSummary) {
        if let r = store.reader, r.rowId == row.id, let last = r.messages.last { open(kind: kind, store: store, message: last); return }
        let e = row.latest
        let m = ThreadMessage(uid: e.uid, folder: e.folder, subject: e.subject, fromName: e.fromName, fromAddr: e.fromAddr, to: e.to,
                              date: e.date, messageId: e.messageId, snippet: e.snippet, hasAttachments: e.hasAttachments)
        open(kind: kind, store: store, message: m)
    }

    func open(kind: ComposeSeed.Kind, store: MailStore, message m: ThreadMessage) {
        opener?(Self.seed(kind: kind, message: m, ownAddress: ownAddress, outgoing: store.isOutgoingFolder))
    }

    /// The message a reply answers: the latest one not from you, else the latest.
    static func replyTarget(_ messages: [ThreadMessage], ownAddress: String) -> ThreadMessage? {
        let own = ownAddress.lowercased()
        return messages.last(where: { $0.fromAddr.lowercased() != own }) ?? messages.last
    }

    static func seed(kind: ComposeSeed.Kind, message m: ThreadMessage, ownAddress: String, outgoing: Bool = false) -> ComposeSeed {
        var s = ComposeSeed(kind: kind)
        let own = ownAddress.lowercased()
        func bare(_ a: String) -> String {
            if let lt = a.firstIndex(of: "<"), let gt = a.firstIndex(of: ">"), lt < gt { return String(a[a.index(after: lt)..<gt]) }
            return a.trimmingCharacters(in: .whitespaces)
        }
        // Replying to your own message goes to its recipients; otherwise Reply-To, else the sender (webmail and
        // the Windows ComposeSeeds agree). Reply all never ends with an empty To.
        let fromMe = !own.isEmpty && m.fromAddr.lowercased() == own
        var sender: [String] = fromMe && !m.to.isEmpty ? m.to.map(bare) : [m.replyTo.isEmpty ? m.fromAddr : bare(m.replyTo)]
        switch kind {
        case .new, .forward: break
        case .reply:
            s.to = dedupe(sender)
        case .replyAll:
            var seen = Set(sender.map { $0.lowercased() }); seen.insert(own)
            var cc: [String] = []
            for a in (m.to + m.cc).map(bare) where !a.isEmpty && seen.insert(a.lowercased()).inserted { cc.append(a) }
            if sender.allSatisfy({ $0.lowercased() == own }) && !m.fromAddr.isEmpty { sender = [m.fromAddr] }
            s.to = dedupe(sender); s.cc = cc
        }
        let prefix = kind == .forward ? "Fwd: " : "Re: "
        let subject = m.subject
        let lower = subject.lowercased()
        s.subject = kind == .new ? "" : (lower.hasPrefix(prefix.lowercased()) || (kind != .forward && lower.hasPrefix("re:")) ? subject : prefix + subject)
        if kind != .new {
            let body = m.text ?? (m.html.map { $0.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression) } ?? m.snippet)
            let when = m.sentAt.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? ""
            let who = m.fromName.isEmpty ? m.fromAddr : "\(m.fromName) <\(m.fromAddr)>"
            if kind == .forward {
                s.quote = "---------- Forwarded message ----------\nFrom: \(who)\nDate: \(when)\nSubject: \(m.subject)\n\n\(body)"
                s.stageUid = m.uid; s.stageFolder = m.folder
            } else {
                s.quote = "On \(when), \(who) wrote:\n" + body.split(separator: "\n", omittingEmptySubsequences: false).map { "> \($0)" }.joined(separator: "\n")
            }
            s.inReplyTo = m.messageId.isEmpty ? nil : m.messageId
            s.references = [m.references, m.messageId].filter { !$0.isEmpty }.joined(separator: " ")
            s.replyUid = m.uid; s.replyFolder = m.folder
        }
        return s
    }

    private static func dedupe(_ a: [String]) -> [String] {
        var seen = Set<String>()
        return a.filter { seen.insert($0.lowercased()).inserted }
    }
}

struct ComposeAttachment: Identifiable, Equatable {
    enum State: Equatable { case uploading, scanning, ready, failed(String) }
    let id = UUID()
    var name: String
    var size: Int
    var state: State
    var fileId: String?
}

enum ComposeFont {
    static var body: NSFont { NSFont(name: "GoogleSans-Regular", size: 14) ?? .systemFont(ofSize: 14) }
}

enum Address {
    static func isValid(_ s: String) -> Bool {
        s.range(of: #"^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$"#, options: .regularExpression) != nil
    }
    /// Splits pasted text such as "a@x.ke, B <b@x.ke>" into addresses.
    static func parse(_ text: String) -> [String] {
        text.split(whereSeparator: { ",;\n".contains($0) }).map { part in
            let p = part.trimmingCharacters(in: .whitespaces)
            if let lt = p.firstIndex(of: "<"), let gt = p.firstIndex(of: ">"), lt < gt { return String(p[p.index(after: lt)..<gt]) }
            return p
        }.filter { !$0.isEmpty }
    }
}

@MainActor @Observable
final class ComposeModel {
    enum Status: Equatable { case editing, sending, failed(String), sent }

    var to: [String]
    var cc: [String]
    var bcc: [String] = []
    var showCc: Bool
    var showBcc = false
    var subject: String
    var attachments: [ComposeAttachment] = []
    var status: Status = .editing
    var saveState = ""
    var notice: String?
    var suggestions: [String] = []
    var pendingTo = ""
    var pendingCc = ""
    var pendingBcc = ""
    var attachmentError: String?
    let seed: ComposeSeed
    let from: String
    @ObservationIgnored var attributed = NSAttributedString()
    @ObservationIgnored private let service: MailService
    @ObservationIgnored private(set) var discarded = false
    @ObservationIgnored private var draftUid: Int?
    @ObservationIgnored private var draftFolder = "Drafts"
    @ObservationIgnored private var autosave: Task<Void, Never>?
    @ObservationIgnored private var suggestTask: Task<Void, Never>?
    @ObservationIgnored private var recents: [String]

    init(seed: ComposeSeed, service: MailService, from: String, recents: [String] = []) {
        self.seed = seed; self.service = service; self.from = from; self.recents = recents
        to = seed.to; cc = seed.cc; subject = seed.subject; showCc = !seed.cc.isEmpty
    }

    /// Uploading or still being virus scanned: the server refuses to send these (422 file_not_ready).
    var hasUploading: Bool { attachments.contains { $0.state == .uploading || $0.state == .scanning } }
    var hasFailedAttachment: Bool { attachments.contains { if case .failed = $0.state { return true }; return false } }
    /// Recipients including a token still being typed (committed on Send and on blur).
    var allTo: [String] { to + Address.parse(pendingTo) }
    var allCc: [String] { cc + Address.parse(pendingCc) }
    var allBcc: [String] { bcc + Address.parse(pendingBcc) }

    var canSend: Bool {
        !allTo.isEmpty && allTo.allSatisfy(Address.isValid) && allCc.allSatisfy(Address.isValid) && allBcc.allSatisfy(Address.isValid)
            && !hasUploading && !hasFailedAttachment && status != .sending && !closed
    }

    func commitPending() {
        for a in Address.parse(pendingTo) where !to.contains(a) { to.append(a) }
        for a in Address.parse(pendingCc) where !cc.contains(a) { cc.append(a) }
        for a in Address.parse(pendingBcc) where !bcc.contains(a) { bcc.append(a) }
        pendingTo = ""; pendingCc = ""; pendingBcc = ""
    }

    /// Initial body: a blank line, the quote, then the signature.
    func prepare(signature: String?, signatureHTML: String? = nil) async {
        var text = "\n"
        if !seed.quote.isEmpty { text += "\n" + seed.quote + "\n" }
        if let signature, !signature.isEmpty { text += "\n-- \n" + signature }
        // A signature is inserted as text: importing its HTML would fetch remote images and styles.
        let base = NSMutableAttributedString(string: text, attributes: [.font: ComposeFont.body])
        if (signature ?? "").isEmpty, let html = signatureHTML, !html.isEmpty {
            let plain = MailBlock(id: "", blockType: "signature", name: "", html: html, text: nil, isDefault: true, scope: nil).plainText
            if !plain.isEmpty { base.append(NSAttributedString(string: "\n-- \n" + plain, attributes: [.font: ComposeFont.body])) }
        }
        attributed = base
        if let uid = seed.stageUid, let folder = seed.stageFolder, seed.kind == .forward {
            do {
                let staged = try await service.stageAttachments(uid: uid, folder: folder)
                for f in staged { attachments.append(ComposeAttachment(name: f.filename, size: f.size, state: .ready, fileId: f.fileId)) }
            } catch {
                attachmentError = "The original attachments could not be added. Attach them again before sending. " + ((error as? LocalizedError)?.errorDescription ?? "")
            }
        }
    }

    // MARK: Attachments

    func addFiles(_ urls: [URL]) {
        for url in urls {
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            var a = ComposeAttachment(name: url.lastPathComponent, size: size, state: .uploading)
            if size > 50 << 20 { a.state = .failed("Larger than 50 MB"); attachments.append(a); continue }
            attachments.append(a)
            let id = a.id
            Task {
                do {
                    let data = try await Task.detached { try Data(contentsOf: url) }.value
                    let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                    let stored = try await service.upload(filename: url.lastPathComponent, mime: mime, data: data)
                    update(id) { $0.fileId = stored.id; $0.state = stored.isReady ? .ready : .scanning }
                    if !stored.isReady { await awaitScan(attachment: id, fileId: stored.id, name: url.lastPathComponent) }
                } catch { update(id) { $0.state = .failed((error as? LocalizedError)?.errorDescription ?? "Upload failed") } }
            }
        }
        scheduleAutosave()
    }

    /// Polls GET /v1/files/{id} until the virus scan finishes (the backend refuses unscanned files at send).
    func awaitScan(attachment id: UUID, fileId: String, name: String, interval: TimeInterval = 1.5, maxWait: TimeInterval = 180) async {
        let deadline = Date().addingTimeInterval(maxWait)
        while Date() < deadline, !closed {
            if let f = try? await service.fileStatus(fileId) {
                if f.isRejected {
                    attachments.removeAll { $0.id == id }
                    attachmentError = "\"\(name)\" was rejected by the virus scan and was removed."
                    return
                }
                if f.isReady { update(id) { $0.state = .ready }; scheduleAutosave(); return }
            }
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            if !attachments.contains(where: { $0.id == id }) { return }
        }
        update(id) { $0.state = .failed("Scan did not finish") }
    }

    private func update(_ id: UUID, _ f: (inout ComposeAttachment) -> Void) {
        if let i = attachments.firstIndex(where: { $0.id == id }) { f(&attachments[i]) }
    }

    func removeAttachment(_ id: UUID) { attachments.removeAll { $0.id == id }; scheduleAutosave() }

    // MARK: Suggestions

    func suggest(_ text: String) {
        suggestTask?.cancel()
        let q = text.trimmingCharacters(in: .whitespaces)
        guard q.count >= 2 else { suggestions = []; return }
        suggestions = recents.filter { $0.lowercased().contains(q.lowercased()) }.prefix(5).map { $0 }
        suggestTask = Task {
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled, let found = try? await service.contacts(matching: q) else { return }
            var merged = suggestions
            for c in found { for e in c.addresses where !merged.contains(e) { merged.append(e) } }
            suggestions = Array(merged.prefix(8))
        }
    }

    // MARK: Payload

    var readyFileIds: [String] { attachments.filter { $0.state == .ready }.compactMap(\.fileId) }

    func payload() -> Endpoints.SendPayload {
        let html = Self.html(from: attributed)
        return Endpoints.SendPayload(
            to: allTo, cc: allCc.isEmpty ? nil : allCc, bcc: allBcc, subject: subject, text: attributed.string, html: html,
            inReplyTo: seed.inReplyTo, references: seed.references, replyUid: seed.replyUid, replyFolder: seed.replyFolder,
            fileIds: readyFileIds.isEmpty ? nil : readyFileIds)
    }

    static func html(from s: NSAttributedString) -> String {
        let range = NSRange(location: 0, length: s.length)
        guard let data = try? s.data(from: range, documentAttributes: [.documentType: NSAttributedString.DocumentType.html,
                                                                     .characterEncoding: String.Encoding.utf8.rawValue]),
              let html = String(data: data, encoding: .utf8) else {
            return "<div>" + s.string.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: "\n", with: "<br>") + "</div>"
        }
        return html
    }

    // MARK: Draft and send

    /// Draft saves run one at a time through a single chain; send and discard wait for it, then trash the
    /// final server draft. Once the window is closed (sent or discarded) no save starts.
    @ObservationIgnored private var draftChain: Task<Void, Never>?
    private(set) var closed = false

    func scheduleAutosave() {
        guard !closed else { return }
        autosave?.cancel()
        autosave = Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard !Task.isCancelled else { return }
            await saveDraft()
        }
    }

    func saveDraft() async {
        guard !closed else { return }
        // The server refuses drafts that reference files still being scanned: wait for them.
        if hasUploading { scheduleAutosave(); return }
        guard !to.isEmpty || !subject.isEmpty || !attributed.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let previous = draftChain
        let task = Task { [self] in
            await previous?.value
            guard !closed else { return }
            saveState = "Saving"
            var p = payload()
            p.replaceUid = draftUid
            p.opId = "d" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
            do {
                let r = try await service.saveDraft(p)
                draftUid = r.uid; draftFolder = r.folder; saveState = "Saved"
                if closed, let uid = r.uid { _ = try? await service.batch(action: .trash, uids: [uid], folder: r.folder) }
            } catch { saveState = "Not saved" }
        }
        draftChain = task
        await task.value
    }

    /// Stops autosave and waits for any save in flight, so the final uid is known.
    private func settleDrafts() async {
        closed = true
        autosave?.cancel()
        await draftChain?.value
    }

    private func trashDraft() async {
        if let uid = draftUid { _ = try? await service.batch(action: .trash, uids: [uid], folder: draftFolder); draftUid = nil }
    }

    /// Discard never saves a draft, and deletes the one already on the server (webmail discardCompose).
    func discard() async {
        discarded = true
        await settleDrafts()
        await trashDraft()
    }

    func send() async -> Bool {
        guard status != .sending else { return false }
        commitPending()
        guard canSend else { return false }
        status = .sending; notice = nil
        autosave?.cancel()
        await draftChain?.value               // no draft save is racing the send
        do {
            let r = try await service.send(payload())
            if !(r.suppressed.isEmpty && r.refused.isEmpty) {
                notice = "Not delivered to: " + (r.suppressed + r.refused).joined(separator: ", ")
            }
            status = .sent
            await settleDrafts()
            await trashDraft()
            return true
        } catch {
            if case .transport = (error as? APIError) ?? .cancelled {
                // The request may have reached the server: never auto-retry, tell the user to check Sent.
                status = .failed("Could not confirm that the message was sent. Check your Sent folder before sending it again.")
            } else if case let .http(_, _, m) = (error as? APIError) ?? .cancelled, !m.isEmpty {
                status = .failed(m)
            } else {
                status = .failed((error as? LocalizedError)?.errorDescription ?? "Could not send.")
            }
            return false
        }
    }
}
