import SwiftUI
import AppKit
import QuickLookUI

struct ReaderView: View {
    var app: AppModel
    var store: MailStore
    @State private var pendingLink: URL?

    var body: some View {
        Group {
            if store.selection.count > 1 {
                EmptyState(icon: .mail, title: "\(store.selection.count) messages selected", hint: "Use the toolbar to archive, delete or move them.")
            } else if let r = store.reader {
                content(r)
            } else {
                EmptyState(icon: .mail, title: "Select a message", hint: "Choose a conversation from the list to read it.")
                    .accessibilityIdentifier("reader-empty")
            }
        }
        .background(Theme.bg)
        .confirmationDialog(linkTitle, isPresented: Binding(get: { pendingLink != nil }, set: { if !$0 { pendingLink = nil } }), titleVisibility: .visible) {
            Button("Open in Browser") { if let u = pendingLink { NSWorkspace.shared.open(u) }; pendingLink = nil }
            Button("Cancel", role: .cancel) { pendingLink = nil }
        } message: { Text(pendingLink?.absoluteString ?? "") }
        .task { await BodyRules.shared.prepare() }
    }

    private var linkTitle: String {
        guard let u = pendingLink else { return "" }
        let c = BodyLockdown.linkCheck(u)
        return c.scheme == "mailto" ? "Write to \(c.host)?" : "Open link to \(c.host)?"
    }

    @ViewBuilder private func content(_ r: ReaderState) -> some View {
        switch r.status {
        case .loading where r.messages.isEmpty:
            ScrollView { VStack(alignment: .leading, spacing: Space.s4) {
                SkeletonBar(width: 280, height: 16)
                HStack(spacing: Space.s3) { Circle().fill(Theme.track).frame(width: 40, height: 40); VStack(alignment: .leading, spacing: Space.s2) { SkeletonBar(width: 160); SkeletonBar(width: 220, height: 8) } }
                ForEach(0..<5, id: \.self) { _ in SkeletonBar(height: 10) }
            }.padding(Space.s6) }.accessibilityIdentifier("reader-skeleton")
        case .failed(let m) where r.messages.isEmpty:
            VStack { Banner(kind: .danger, icon: .danger, message: "Could not load this message. \(m)", actionTitle: "Retry") { store.retryReader() }.padding(Space.s6); Spacer() }
        case .unavailableOffline:
            EmptyState(icon: .wifi, title: "Not available offline", hint: "This message is not available offline.")
        default:
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: Space.s3) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(r.subject.isEmpty ? "(no subject)" : r.subject).taifa(.title).foregroundStyle(Theme.text)
                                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                            Spacer()
                            if r.messages.count > 1 { Text("\(r.messages.count) messages").taifa(.meta).foregroundStyle(Theme.text3) }
                        }
                        if store.isOffline { Banner(kind: .warn, icon: .wifi, message: "Offline. Showing the last synced mail.") }
                        ForEach(r.messages) { m in
                            MessageCard(message: m, reader: r, app: app, store: store, isLast: m.id == r.messages.last?.id) { pendingLink = $0 }
                                .id(m.id)
                        }
                    }
                    .padding(.horizontal, Space.s6).padding(.vertical, Space.s4)
                    .frame(maxWidth: 860, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .accessibilityIdentifier("reader")
                .onAppear { if let id = r.messages.last?.id { proxy.scrollTo(id, anchor: .top) } }
            }
        }
    }
}

struct MessageCard: View {
    let message: ThreadMessage
    let reader: ReaderState
    var app: AppModel
    var store: MailStore
    let isLast: Bool
    var onLink: (URL) -> Void
    @State private var bodyHeight: CGFloat = 40

    private var expanded: Bool { reader.expanded.contains(message.id) }
    private var outgoing: Bool { store.isOutgoingFolder }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if expanded {
                Divider().overlay(Theme.border)
                VStack(alignment: .leading, spacing: Space.s3) {
                    if let w = message.authWarning { AuthBanner(warning: w) }
                    bodyView
                    if !message.attachments.isEmpty { AttachmentStrip(message: message, store: store) }
                }.padding(Space.s4)
            }
        }
        .background(Theme.panel, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Theme.border, lineWidth: 1))
        .accessibilityIdentifier("message-\(message.uid)")
    }

    private var header: some View {
        let address = outgoing ? (message.to.first ?? message.fromAddr) : message.fromAddr
        let name = message.fromName.isEmpty ? message.fromAddr : message.fromName
        let picture = AvatarDecision.picture(entry: store.avatars.entry(address), message: message.authState, outgoing: outgoing)
        return Button { store.toggleExpanded(message.id) } label: {
            HStack(alignment: expanded ? .top : .center, spacing: Space.s3) {
                AvatarView(name: name, address: address, picture: picture, size: expanded ? Metrics.avatarReader : Metrics.avatarCompact)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: Space.s2) {
                        Text(name).taifa(message.seen ? .bodyStrong : .bodyStrong).foregroundStyle(Theme.text).lineLimit(1)
                        if expanded { Text(message.fromAddr).font(.taifaMono(11)).foregroundStyle(Theme.text3).lineLimit(1).textSelection(.enabled) }
                        Spacer()
                        if message.hasAttachments { Icon(.attachment, size: 14).foregroundStyle(Theme.text3) }
                        Text(message.sentAt.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "").taifa(.meta).foregroundStyle(Theme.text3)
                    }
                    if expanded {
                        Text("to \(recipientsLine)").taifa(.meta).foregroundStyle(Theme.text3).lineLimit(2)
                    } else {
                        Text(message.snippet).taifa(.meta).foregroundStyle(Theme.text3).lineLimit(1)
                    }
                }
                if expanded {
                    HStack(spacing: Space.s1) {
                        IconButton(icon: .reply, label: "Reply") { ComposeLauncher.shared.open(kind: .reply, store: store, message: message) }
                        IconButton(icon: .replyAll, label: "Reply All") { ComposeLauncher.shared.open(kind: .replyAll, store: store, message: message) }
                        IconButton(icon: .forward, label: "Forward") { ComposeLauncher.shared.open(kind: .forward, store: store, message: message) }
                    }.foregroundStyle(Theme.text2)
                }
                Icon(expanded ? .chevronUp : .chevronDown, size: 12).foregroundStyle(Theme.text4)
            }
            .padding(.horizontal, Space.s4)
            .frame(minHeight: expanded ? 72 : Metrics.readerHeaderCollapsed)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(name), \(message.subject)")
    }

    private var recipientsLine: String {
        let all = message.to + message.cc
        if all.count <= 2 { return all.joined(separator: ", ") }
        return all.prefix(1).joined() + ", +\(all.count - 1)"
    }

    @ViewBuilder private var bodyView: some View {
        let allowImages = reader.imagesAllowed.contains(message.id) || store.trustedImageSenders.contains(message.fromAddr.lowercased())
        if !message.bodyLoaded {
            VStack(alignment: .leading, spacing: Space.s2) { ForEach(0..<4, id: \.self) { _ in SkeletonBar(height: 10) } }
        } else if let html = message.html, !html.isEmpty, BodyRules.shared.state == .ready {
            if BodyLockdown.hasRemoteContent(html) && !allowImages {
                Banner(kind: .info, icon: .imageOff, message: "Remote images are blocked.", actionTitle: "Show images") { store.allowImages(for: message.id) }
            }
            MessageBodyView(html: html, allowRemoteImages: allowImages, height: $bodyHeight, onLink: onLink)
                .frame(height: max(bodyHeight, 24))
                .accessibilityIdentifier("message-body-web")
        } else {
            PlainBody(text: message.text ?? Self.stripTags(message.html ?? ""), onLink: onLink)
        }
    }

    static func stripTags(_ html: String) -> String {
        html.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
    }
}

struct PlainBody: View {
    let text: String
    var onLink: (URL) -> Void
    var body: some View {
        Text(Self.linked(text))
            .taifa(.reader).foregroundStyle(Theme.text)
            .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.openURL, OpenURLAction { onLink($0); return .handled })
            .accessibilityIdentifier("message-body-text")
    }

    static func linked(_ text: String) -> AttributedString {
        var a = AttributedString(text)
        guard let det = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return a }
        let ns = text as NSString
        for m in det.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            guard let url = m.url, let r = Range(m.range, in: text), let ar = Range(r, in: a) else { continue }
            a[ar].link = url
        }
        return a
    }
}

struct AuthBanner: View {
    let warning: AuthWarning
    var body: some View {
        let kind: BannerKind = warning.level == .danger ? .danger : warning.level == .warning ? .warn : .info
        VStack(alignment: .leading, spacing: Space.s1) {
            Banner(kind: kind, icon: warning.level == .info ? .info : .warning, message: "\(warning.title). \(warning.message)")
            if warning.linksDisabled == true { Text("Links in this message are disabled.").taifa(.meta).foregroundStyle(Theme.text3) }
        }
    }
}

struct AttachmentStrip: View {
    let message: ThreadMessage
    var store: MailStore
    @State private var busy: String?

    var body: some View {
        FlowLayout(spacing: Space.s2) {
            ForEach(message.attachments) { a in
                HStack(spacing: Space.s2) {
                    Icon(.attachment, size: 16).foregroundStyle(Theme.text2)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(a.filename).taifa(.body).foregroundStyle(Theme.text).lineLimit(1)
                        Text(ByteCountFormatter.string(fromByteCount: Int64(a.size), countStyle: .file)).taifa(.caption).foregroundStyle(Theme.text3)
                    }
                    if busy == a.id { ProgressView().controlSize(.small) }
                    else {
                        IconButton(icon: .download, label: "Save \(a.filename)") { Task { await save(a) } }.foregroundStyle(Theme.text2)
                    }
                }
                .padding(.horizontal, Space.s3).frame(height: 40)
                .background(Theme.panel2, in: RoundedRectangle(cornerRadius: Radius.ctl, style: .continuous))
                .contentShape(Rectangle())
                .onTapGesture { Task { await preview(a) } }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Attachment \(a.filename)")
                .accessibilityAddTraits(.isButton)
            }
        }
        .accessibilityIdentifier("attachments")
    }

    private func fetch(_ a: Attachment) async -> URL? {
        busy = a.id; defer { busy = nil }
        do {
            let data = try await store.service.attachment(uid: message.uid, folder: message.folder, partId: a.partId)
            return try AttachmentFiles.write(data, name: a.filename)
        } catch { store.post("Could not download \(a.filename)", isError: true); return nil }
    }

    private func preview(_ a: Attachment) async {
        if let url = await fetch(a) { AttachmentPreviewer.shared.show(url) }
    }

    private func save(_ a: Attachment) async {
        guard let tmp = await fetch(a) else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = a.filename
        if panel.runModal() == .OK, let dest = panel.url {
            try? FileManager.default.removeItem(at: dest)
            do { try FileManager.default.copyItem(at: tmp, to: dest) } catch { store.post("Could not save \(a.filename)", isError: true) }
        }
    }
}

enum AttachmentFiles {
    static var directory: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("TaifaMailAttachments", isDirectory: true)
    }
    static func write(_ data: Data, name: String) throws -> URL {
        let dir = directory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let safe = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        let url = dir.appendingPathComponent(safe.isEmpty ? "attachment" : safe)
        try data.write(to: url, options: .atomic)
        return url
    }
    /// Downloaded attachments are temporary: removed at launch and on sign out.
    static func purge() { try? FileManager.default.removeItem(at: directory) }
}

/// Quick Look for downloaded attachments.
final class AttachmentPreviewer: NSObject, QLPreviewPanelDataSource {
    static let shared = AttachmentPreviewer()
    private var url: URL?
    func show(_ url: URL) {
        self.url = url
        guard let panel = QLPreviewPanel.shared() else { return }
        panel.dataSource = self
        panel.reloadData()
        panel.makeKeyAndOrderFront(nil)
    }
    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int { url == nil ? 0 : 1 }
    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> QLPreviewItem! { url as NSURL? }
}

/// A simple wrapping layout for chips.
struct FlowLayout: Layout {
    var spacing: CGFloat = Space.s2
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 600
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x + size.width > width, x > 0 { x = 0; y += rowH + spacing; rowH = 0 }
            x += size.width + spacing; rowH = max(rowH, size.height)
        }
        return CGSize(width: width, height: y + rowH)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing; rowH = max(rowH, size.height)
        }
    }
}
