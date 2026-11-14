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

    static func seed(kind: ComposeSeed.Kind, message m: ThreadMessage, ownAddress: String, outgoing: Bool = false) -> ComposeSeed {
        var s = ComposeSeed(kind: kind)
        let own = ownAddress.lowercased()
        func bare(_ a: String) -> String {
            if let lt = a.firstIndex(of: "<"), let gt = a.firstIndex(of: ">"), lt < gt { return String(a[a.index(after: lt)..<gt]) }
            return a.trimmingCharacters(in: .whitespaces)
        }
        let sender = m.replyTo.isEmpty ? m.fromAddr : bare(m.replyTo)
        switch kind {
        case .new: break
        case .reply:
            s.to = outgoing ? m.to.map(bare) : [sender]
        case .replyAll:
            var to = outgoing ? m.to.map(bare) : [sender]
            var cc = (outgoing ? m.cc : m.to + m.cc).map(bare)
            to = dedupe(to.filter { $0.lowercased() != own })
            cc = dedupe(cc.filter { $0.lowercased() != own && !to.map { $0.lowercased() }.contains($0.lowercased()) })
            s.to = to; s.cc = cc
        case .forward: break
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
    enum State: Equatable { case uploading, ready, failed(String) }
    let id = UUID()
    var name: String
    var size: Int
    var state: State
    var fileId: String?
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
    let seed: ComposeSeed
    let from: String
    @ObservationIgnored var attributed = NSAttributedString()
    @ObservationIgnored private let service: MailService
    @ObservationIgnored private var draftUid: Int?
    @ObservationIgnored private var draftFolder = "Drafts"
    @ObservationIgnored private var autosave: Task<Void, Never>?
    @ObservationIgnored private var suggestTask: Task<Void, Never>?
    @ObservationIgnored private var recents: [String]

    init(seed: ComposeSeed, service: MailService, from: String, recents: [String] = []) {
        self.seed = seed; self.service = service; self.from = from; self.recents = recents
        to = seed.to; cc = seed.cc; subject = seed.subject; showCc = !seed.cc.isEmpty
    }

    var hasUploading: Bool { attachments.contains { $0.state == .uploading } }
    var canSend: Bool {
        !to.isEmpty && to.allSatisfy(Address.isValid) && cc.allSatisfy(Address.isValid) && bcc.allSatisfy(Address.isValid)
            && !hasUploading && status != .sending
    }

    /// Initial body: a blank line, the quote, then the signature.
    func prepare(signature: String?) async {
        var text = "\n"
        if !seed.quote.isEmpty { text += "\n" + seed.quote + "\n" }
        if let signature, !signature.isEmpty { text += "\n-- \n" + signature }
        attributed = NSAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: 14)])
        if let uid = seed.stageUid, let folder = seed.stageFolder, seed.kind == .forward {
            if let staged = try? await service.stageAttachments(uid: uid, folder: folder) {
                for f in staged { attachments.append(ComposeAttachment(name: f.filename, size: f.size, state: .ready, fileId: f.fileId)) }
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
                    update(id) { $0.fileId = stored.id; $0.state = .ready }
                } catch { update(id) { $0.state = .failed((error as? LocalizedError)?.errorDescription ?? "Upload failed") } }
            }
        }
        scheduleAutosave()
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
            for c in found { if let e = c.email, !merged.contains(e) { merged.append(e) } }
            suggestions = Array(merged.prefix(8))
        }
    }

    // MARK: Payload

    func payload() -> Endpoints.SendPayload {
        let html = Self.html(from: attributed)
        return Endpoints.SendPayload(
            to: to, cc: cc.isEmpty ? nil : cc, bcc: bcc, subject: subject, text: attributed.string, html: html,
            inReplyTo: seed.inReplyTo, references: seed.references, replyUid: seed.replyUid, replyFolder: seed.replyFolder,
            fileIds: attachments.compactMap(\.fileId).isEmpty ? nil : attachments.compactMap(\.fileId))
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

    func scheduleAutosave() {
        autosave?.cancel()
        autosave = Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard !Task.isCancelled else { return }
            await saveDraft()
        }
    }

    func saveDraft() async {
        guard status == .editing || { if case .failed = status { return true }; return false }() else { return }
        guard !to.isEmpty || !subject.isEmpty || !attributed.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        saveState = "Saving"
        var p = payload()
        p.replaceUid = draftUid
        p.opId = "d" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        do { let r = try await service.saveDraft(p); draftUid = r.uid; draftFolder = r.folder; saveState = "Saved" }
        catch { saveState = "Not saved" }
    }

    func send() async -> Bool {
        guard canSend else { return false }
        autosave?.cancel()
        status = .sending; notice = nil
        do {
            let r = try await service.send(payload())
            if !(r.suppressed.isEmpty && r.refused.isEmpty) {
                notice = "Not delivered to: " + (r.suppressed + r.refused).joined(separator: ", ")
            }
            status = .sent
            if let uid = draftUid { _ = try? await service.batch(action: .trash, uids: [uid], folder: draftFolder) }
            return true
        } catch {
            status = .failed((error as? LocalizedError)?.errorDescription ?? "Could not send.")
            if case let .http(_, _, m) = (error as? APIError) ?? .cancelled, !m.isEmpty { status = .failed(m) }
            return false
        }
    }
}
