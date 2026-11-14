import SwiftUI
import AppKit
import QuickLookUI

struct ReaderView: View {
    var app: AppModel
    var store: MailStore
    @State private var pendingLink: LinkAssessment?

    var body: some View {
        VStack(spacing: 0) {
            if store.selection.count > 1 {
                EmptyState(icon: .mail, title: "\(store.selection.count) messages selected", hint: "Use the list toolbar to archive, delete or move them.")
            } else if let r = store.reader {
                ReaderToolbar(store: store)
                content(r)
                if r.status != .unavailableOffline { ReaderFooter(store: store, reader: r) }
            } else {
                EmptyState(icon: .mail, title: "Select a conversation", hint: "Choose a message from the list to read it here.")
                    .accessibilityIdentifier("reader-empty")
            }
        }
        .background(Theme.bg)
        .confirmationDialog(pendingLink?.title ?? "", isPresented: Binding(get: { pendingLink != nil }, set: { if !$0 { pendingLink = nil } }), titleVisibility: .visible) {
            Button("Open in Browser") { if let a = pendingLink, LinkSafety.isAllowed(a.url) { NSWorkspace.shared.open(a.url) }; pendingLink = nil }
            Button("Cancel", role: .cancel) { pendingLink = nil }
        } message: { Text(pendingLink?.message ?? "") }
        .task { await BodyRules.shared.prepare() }
    }

    @ViewBuilder private func content(_ r: ReaderState) -> some View {
        switch r.status {
        case .loading where r.messages.isEmpty:
            ScrollView { VStack(alignment: .leading, spacing: Space.s4) {
                SkeletonBar(width: 280, height: 20)
                HStack(spacing: Space.s3) { Circle().fill(Theme.track).frame(width: 40, height: 40); VStack(alignment: .leading, spacing: Space.s2) { SkeletonBar(width: 160); SkeletonBar(width: 220, height: 8) } }
                ForEach(0..<5, id: \.self) { _ in SkeletonBar(height: 10) }
            }.padding(Space.s7) }.accessibilityIdentifier("reader-skeleton")
        case .failed(let m) where r.messages.isEmpty:
            VStack(spacing: Space.s3) {
                Text("Couldn't load this message").taifa(.subhead).foregroundStyle(Theme.text)
                Text(m).taifa(.meta).foregroundStyle(Theme.text3)
                Button("Try again") { store.retryReader() }.buttonStyle(OutlinePillStyle())
            }.padding(Space.s8).frame(maxWidth: .infinity, maxHeight: .infinity)
        case .unavailableOffline:
            EmptyState(icon: .wifi, title: "Not available offline", hint: "This message is not available offline.")
        default:
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(r.subject.isEmpty ? "(no subject)" : r.subject).font(Fonts.sans(20, .semibold)).tracking(-0.2)
                            .foregroundStyle(Theme.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                            .padding(.bottom, Space.s1)
                        if store.isOffline { Banner(kind: .warn, icon: .wifi, message: "Offline. Showing the last synced mail.").padding(.vertical, Space.s2) }
                        if r.hasMoreOlder {
                            Button { Task { await store.loadOlder() } } label: {
                                HStack(spacing: Space.s2) {
                                    if r.loadingOlder { ProgressView().controlSize(.small) }
                                    Text(r.loadingOlder ? "Loading" : "Show earlier messages")
                                }
                                .taifa(.body).foregroundStyle(Theme.text2).frame(maxWidth: .infinity).padding(.vertical, Space.s2)
                                .overlay(RoundedRectangle(cornerRadius: Radius.ctl).strokeBorder(Theme.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                            }.buttonStyle(.plain).hoverFill().padding(.top, Space.s1).padding(.bottom, Space.s3).accessibilityIdentifier("show-earlier")
                        }
                        ForEach(Array(r.messages.enumerated()), id: \.element.id) { i, m in
                            MessageRow(message: m, reader: r, app: app, store: store, first: i == 0) { pendingLink = $0 }.id(m.id)
                        }
                    }
                    .padding(.horizontal, Space.s7).padding(.top, Space.s2).padding(.bottom, Space.s7)
                    .frame(maxWidth: 900, alignment: .leading).frame(maxWidth: .infinity)
                }
                .accessibilityIdentifier("reader")
                .onAppear { if let id = r.messages.last?.id { proxy.scrollTo(id, anchor: .top) } }
            }
        }
    }
}

/// 32 px tools: Archive, Spam, Delete | Mark unread, Star, Move | spacer | "N of M" with newer and older.
struct ReaderToolbar: View {
    var store: MailStore
    var body: some View {
        let row = store.rows.first { $0.id == store.reader?.rowId }
        let isJunk = store.currentFolder?.role == .junk
        HStack(spacing: Space.s1) {
            tool(.archive, "Archive") { store.perform(.archive, on: row.map { [$0] }) }
            tool(.junk, isJunk ? "Not spam" : "Report spam") { store.perform(isJunk ? .notJunk : .junk, on: row.map { [$0] }) }
            tool(.trash, "Delete", danger: true) { store.perform(.trash, on: row.map { [$0] }) }
            Rectangle().fill(Theme.border).frame(width: 1, height: 20).padding(.horizontal, Space.s2)
            tool(row?.unread == true ? .openMail : .unread, row?.unread == true ? "Mark as read" : "Mark as unread") { store.perform(.read(row?.unread ?? false), on: row.map { [$0] }) }
            tool(.star, row?.latest.flagged == true ? "Remove star" : "Star", tint: row?.latest.flagged == true ? Theme.warn : nil) {
                store.perform(.flag(!(row?.latest.flagged ?? false)), on: row.map { [$0] })
            }
            Menu {
                ForEach(store.folders.filter { $0.path != row?.latest.folder }) { f in Button(f.name) { store.perform(.move(f.path), on: row.map { [$0] }) } }
            } label: { Icon(.folder, size: 18).foregroundStyle(Theme.text2).frame(width: 32, height: 32) }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).frame(width: 32, height: 32).hoverFill().help("Move to folder").accessibilityLabel("Move to folder")
            Spacer()
            if let p = store.readerPosition {
                Text("\(p.index.formatted()) of \(p.count.formatted())").font(Fonts.sans(11)).monospacedDigit().foregroundStyle(Theme.text3)
                tool(.chevronUp, "Newer conversation", small: true) { store.openNewer() }.disabled(p.index <= 1)
                tool(.chevronDown, "Older conversation", small: true) { store.openOlder() }.disabled(p.index >= p.count)
            }
        }
        .padding(.horizontal, Space.s4).padding(.vertical, Space.s3)
        .disabled(store.reader == nil)
    }

    private func tool(_ icon: Icon.Name, _ label: String, danger: Bool = false, tint: Color? = nil, small: Bool = false, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Icon(icon, size: small ? 14 : 18).foregroundStyle(tint ?? Theme.text2).frame(width: 32, height: 32)
        }
        .buttonStyle(.plain).hoverFill(tint: danger ? Theme.dangerSoft : nil).help(label).accessibilityLabel(label)
    }
}

/// Sticky footer: 40 px outlined pill buttons Reply, Reply all, Forward.
struct ReaderFooter: View {
    var store: MailStore
    let reader: ReaderState
    var body: some View {
        HStack(spacing: Space.s2) {
            Spacer()
            pill(.undo, "Reply", .reply)
            pill(.replyAll, "Reply all", .replyAll)
            pill(.forward, "Forward", .forward)
        }
        .padding(.horizontal, Space.s6).padding(.top, Space.s4).padding(.bottom, Space.s5)
        .background(Theme.panel)
        .overlay(alignment: .top) { Rectangle().fill(Theme.borderSoft).frame(height: 1) }
    }
    private func pill(_ icon: Icon.Name, _ title: String, _ kind: ComposeSeed.Kind) -> some View {
        Button {
            let target = kind == .forward ? reader.messages.last : ComposeLauncher.replyTarget(reader.messages, ownAddress: ComposeLauncher.shared.ownAddress)
            if let m = target { ComposeLauncher.shared.open(kind: kind, store: store, message: m) }
        } label: { HStack(spacing: Space.s2) { Icon(icon, size: 16); Text(title) } }
            .buttonStyle(OutlinePillStyle()).disabled(reader.messages.isEmpty).accessibilityIdentifier("footer-\(title.lowercased().replacingOccurrences(of: " ", with: "-"))")
    }
}

/// One message of the thread, flat on the page ground: hairline above, 40 px avatar, body indented 52.
struct MessageRow: View {
    let message: ThreadMessage
    let reader: ReaderState
    var app: AppModel
    var store: MailStore
    let first: Bool
    var onLink: (LinkAssessment) -> Void
    @State private var bodyHeight: CGFloat = 40
    @State private var proxiedHTML: String?
    @State private var imagesBlocked = 0
    @State private var imagesRateLimited = false
    @State private var retryToken = 0

    private var linksLocked: Bool { message.authWarning?.linksDisabled == true }
    private var anyWarning: Bool { message.authWarning != nil || message.authLevel != nil || message.authWarned }

    /// Every link goes through the scheme allowlist, then a visible host check. links_disabled makes links inert.
    private func openLink(_ url: URL) {
        guard LinkSafety.shouldPrompt(url, linksLocked: linksLocked) else { return }
        onLink(LinkSafety.assess(url, visibleText: message.html.flatMap { LinkSafety.visibleText(for: url, in: $0) }))
    }

    private var expanded: Bool { reader.expanded.contains(message.id) }
    private var outgoing: Bool { store.isOutgoingFolder }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if expanded {
                VStack(alignment: .leading, spacing: Space.s3) {
                    if let w = message.authWarning { AuthBanner(warning: w) }
                    bodyView
                    if !message.attachments.isEmpty { AttachmentStrip(message: message, store: store) }
                }
                .padding(.leading, Space.s13).padding(.top, Space.s2).padding(.bottom, Space.s2)
            }
        }
        .padding(.top, expanded ? Space.s5 : 0)
        .overlay(alignment: .top) { if !first || expanded { Rectangle().fill(Theme.borderSoft).frame(height: 1) } }
        .padding(.top, expanded && !first ? Space.s4 : 0)
        .accessibilityIdentifier("message-\(message.uid)")
    }

    private var header: some View {
        let address = outgoing ? (message.to.first ?? message.fromAddr) : message.fromAddr
        let name = message.fromName.isEmpty ? message.fromAddr : message.fromName
        let picture = AvatarDecision.picture(entry: store.avatars.entry(address), message: message.authState, outgoing: outgoing)
        return Button { store.toggleExpanded(message.id) } label: {
            HStack(alignment: .top, spacing: Space.s3) {
                AvatarView(name: name, address: address, picture: picture, size: expanded ? Metrics.avatarReader : 32)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: Space.s2) {
                        Text(name).font(Fonts.sans(13, .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                        if expanded { Text(message.fromAddr).font(Fonts.mono(11)).foregroundStyle(Theme.text3).lineLimit(1).textSelection(.enabled) }
                        Spacer()
                        if message.hasAttachments { Icon(.attachment, size: 13).foregroundStyle(Theme.text3) }
                        Text(message.sentAt.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "").font(Fonts.sans(11)).foregroundStyle(Theme.text3)
                    }
                    if expanded { Text("to \(recipientsLine)").taifa(.meta).foregroundStyle(Theme.text3).lineLimit(2) }
                    else { Text(message.snippet).taifa(.meta).foregroundStyle(Theme.text2).lineLimit(1) }
                }
            }
            .padding(.vertical, expanded ? 0 : Space.s3)
            .overlay(alignment: .bottom) { if !expanded { Rectangle().fill(Theme.borderSoft).frame(height: 1) } }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).hoverFill(radius: 0)
        .accessibilityLabel("\(name), \(message.subject)")
    }

    private var recipientsLine: String {
        let all = message.to + message.cc
        if all.count <= 2 { return all.joined(separator: ", ") }
        return all.prefix(1).joined() + ", +\(all.count - 1)"
    }

    @ViewBuilder private var bodyView: some View {
        // Trusted senders load images automatically only on clean mail; a warned message needs an explicit click.
        let allowImages = reader.imagesAllowed.contains(message.id) || (!anyWarning && store.trustedImageSenders.contains(message.fromAddr.lowercased()))
        if !message.bodyLoaded {
            VStack(alignment: .leading, spacing: Space.s2) { ForEach(0..<4, id: \.self) { _ in SkeletonBar(height: 10) } }
        } else if let html = message.html, !html.isEmpty, BodyRules.shared.state == .ready {
            if BodyLockdown.hasRemoteContent(html) && !allowImages {
                Banner(kind: .info, icon: .imageOff, message: "Remote images are blocked.", actionTitle: "Show images") { store.allowImages(for: message.id) }
            }
            if allowImages && imagesBlocked > 0 {
                Banner(kind: .warn, icon: .imageOff, message: imagesRateLimited ? "The server is limiting image requests. \(imagesBlocked) image(s) stay blocked." : "\(imagesBlocked) image(s) could not be loaded and stay blocked.", actionTitle: "Retry") { retryToken += 1 }
            }
            // The web view never loads a remote image: allowed ones are fetched through the server proxy and inlined.
            MessageBodyView(html: proxiedHTML ?? html, allowRemoteImages: false, linksLocked: linksLocked, height: $bodyHeight, onLink: openLink)
                .frame(height: max(bodyHeight, 24))
                .task(id: "\(allowImages)-\(retryToken)") {
                    guard allowImages, BodyLockdown.hasRemoteContent(html) else { proxiedHTML = nil; imagesBlocked = 0; return }
                    let svc = store.service
                    let r = await ImageProxy.rewrite(html: html) { await svc.proxiedImage($0) }
                    proxiedHTML = r.html; imagesBlocked = r.blocked; imagesRateLimited = r.rateLimited
                }
                .accessibilityIdentifier("message-body-web")
        } else {
            PlainBody(text: message.text ?? Self.stripTags(message.html ?? ""), linksLocked: linksLocked, onLink: openLink)
        }
    }

    static func stripTags(_ html: String) -> String {
        html.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
    }
}

struct PlainBody: View {
    let text: String
    var linksLocked = false
    var onLink: (URL) -> Void
    var body: some View {
        Text(linksLocked ? AttributedString(text) : Self.linked(text))
            .font(Fonts.sans(14)).foregroundStyle(Theme.text)
            .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.openURL, OpenURLAction { url in
                if LinkSafety.shouldPrompt(url, linksLocked: linksLocked) { onLink(url) }
                return .handled
            })
            .accessibilityIdentifier("message-body-text")
    }

    static func linked(_ text: String) -> AttributedString {
        var a = AttributedString(text)
        guard let det = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return a }
        let ns = text as NSString
        for m in det.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            guard let url = m.url, LinkSafety.isAllowed(url), let r = Range(m.range, in: text), let ar = Range(r, in: a) else { continue }
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
                        Text(AttachmentSafety.sanitizedName(a.filename)).taifa(.body).foregroundStyle(Theme.text).lineLimit(1)
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
        // Programs and scripts are never opened or previewed from here; Save is offered with a warning.
        if AttachmentSafety.isExecutable(a.filename) {
            store.post("\"\(AttachmentSafety.sanitizedName(a.filename))\" is a program or script. It cannot be previewed; use Save if you are sure.", isError: true)
            return
        }
        if let url = await fetch(a) { AttachmentPreviewer.shared.show(url) }
    }

    private func save(_ a: Attachment) async {
        if AttachmentSafety.isExecutable(a.filename) {
            let alert = NSAlert(); alert.alertStyle = .warning
            alert.messageText = "Save a program or script?"
            alert.informativeText = "\"\(AttachmentSafety.sanitizedName(a.filename))\" can run code on your Mac. Only save it if you trust the sender."
            alert.addButton(withTitle: "Save"); alert.addButton(withTitle: "Cancel")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        guard let tmp = await fetch(a) else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = AttachmentSafety.sanitizedName(a.filename)
        if panel.runModal() == .OK, let dest = panel.url {
            try? FileManager.default.removeItem(at: dest)
            do { try FileManager.default.copyItem(at: tmp, to: dest); AttachmentSafety.quarantine(dest) } catch { store.post("Could not save \(a.filename)", isError: true) }
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
        let url = dir.appendingPathComponent(AttachmentSafety.sanitizedName(name))
        try data.write(to: url, options: .atomic)
        AttachmentSafety.quarantine(url)
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
