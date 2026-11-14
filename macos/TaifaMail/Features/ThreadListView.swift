import SwiftUI
import AppKit

enum TimeFormat {
    static func short(_ date: Date?, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date else { return "" }
        if calendar.isDate(date, inSameDayAs: now) { return date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)) }
        if let y = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: y) { return "Yesterday" }
        if let w = calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: now)), date >= w { return date.formatted(.dateTime.weekday(.wide)) }
        if calendar.isDate(date, equalTo: now, toGranularity: .year) { return date.formatted(.dateTime.day().month(.abbreviated)) }
        return date.formatted(.dateTime.day().month(.abbreviated).year())
    }
}

struct ThreadListView: View {
    var app: AppModel
    var store: MailStore
    @FocusState private var focused: Bool

    var body: some View {
        let density = app.prefs.density
        VStack(spacing: 0) {
            ListHeader(store: store)
            if store.isOffline { Banner(kind: .warn, icon: .wifi, message: "Offline. Showing the last synced mail.").padding(Space.s2) }
            if store.isSearching && store.searchIncomplete {
                Banner(kind: .info, icon: .info, message: "Showing the newest matches only.").padding(.horizontal, Space.s2).padding(.top, Space.s2)
            }
            content(density: density)
        }
        .background(Theme.bg)
    }

    @ViewBuilder private func content(density: Density) -> some View {
        switch store.listState {
        case .loading where store.rows.isEmpty, .idle where store.rows.isEmpty:
            VStack(spacing: 0) { ForEach(0..<8, id: \.self) { _ in SkeletonRow(density: density) }; Spacer() }
                .accessibilityIdentifier("thread-skeleton")
        case .failed(let message) where store.rows.isEmpty:
            VStack(spacing: Space.s3) {
                Text("Couldn't load \(store.currentFolder?.name ?? "this folder")").taifa(.subhead).foregroundStyle(Theme.text)
                Text(message).taifa(.meta).foregroundStyle(Theme.text3).multilineTextAlignment(.center)
                Button("Try again") { Task { await store.refresh() } }.buttonStyle(OutlinePillStyle())
            }.padding(Space.s8).frame(maxWidth: .infinity, maxHeight: .infinity)
        case _ where store.rows.isEmpty:
            if store.isSearching {
                EmptyState(icon: .search, title: "No messages match", hint: "Try a different search.", showLogo: false)
            } else {
                EmptyState(icon: .inbox, title: "Nothing here", hint: "No messages match this view.", showLogo: store.currentFolder?.role == .inbox)
            }
        default:
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(store.rows) { row in
                            ThreadRow(row: row, density: density, selected: store.selection.contains(row.id), focused: focused,
                                      outgoing: store.isOutgoingFolder, store: store)
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    let f = NSEvent.modifierFlags
                                    store.select(row.id, extend: f.contains(.shift), toggle: f.contains(.command))
                                    focused = true
                                }
                                .contextMenu { ThreadContextMenu(store: store, row: row) }
                                .onAppear { store.loadMoreIfNeeded(current: row) }
                                .id(row.id)
                        }
                        if store.isLoadingMore { ProgressView().controlSize(.small).padding(Space.s4) }
                    }
                }
                .accessibilityIdentifier("thread-list")
                .focusable()
                .focused($focused)
                .focusEffectDisabled()
                .overlay { Rectangle().strokeBorder(Theme.accentDot, lineWidth: 2).opacity(focused ? 0.7 : 0).allowsHitTesting(false) }
                .onKeyPress(.downArrow) { store.moveSelection(by: 1, extend: NSEvent.modifierFlags.contains(.shift)); scroll(proxy); return .handled }
                .onKeyPress(.upArrow) { store.moveSelection(by: -1, extend: NSEvent.modifierFlags.contains(.shift)); scroll(proxy); return .handled }
            }
        }
    }

    private func scroll(_ proxy: ScrollViewProxy) { if let id = store.anchorId { proxy.scrollTo(id) } }
}

/// Folder title with total and unread counts, and the bulk bar while several rows are selected.
struct ListHeader: View {
    var store: MailStore
    var body: some View {
        if store.selection.count > 1 {
            HStack(spacing: Space.s1) {
                Text("\(store.selection.count) selected").taifa(.bodyStrong).foregroundStyle(Theme.text)
                Spacer()
                IconButton(icon: .archive, label: "Archive selected") { store.perform(.archive) }
                IconButton(icon: .trash, label: "Delete selected") { store.perform(.trash) }
                IconButton(icon: .openMail, label: "Mark selected as read") { store.perform(.read(true)) }
                IconButton(icon: .star, label: "Star selected") { store.perform(.flag(true)) }
            }
            .foregroundStyle(Theme.text2)
            .padding(.horizontal, Space.s5).frame(height: 44)
            .background(Theme.panel2)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                Text(store.isSearching ? "Search" : (store.currentFolder?.name.capitalized ?? "Inbox")).taifa(.subhead).foregroundStyle(Theme.text)
                let unseen = store.currentFolder?.unseen ?? 0
                Text("\(store.total.formatted())" + (unseen > 0 && !store.isSearching ? "  \u{00B7}  \(unseen.formatted()) unread" : ""))
                    .taifa(.caption).foregroundStyle(Theme.text3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Space.s5).padding(.top, Space.s4).padding(.bottom, Space.s3)
        }
    }
}

struct SkeletonRow: View {
    var density: Density
    var body: some View {
        HStack(alignment: .top, spacing: Space.s3) {
            Circle().fill(Theme.track).frame(width: density.avatar, height: density.avatar)
            VStack(alignment: .leading, spacing: Space.s2) {
                SkeletonBar(width: 140, height: 10)
                SkeletonBar(height: 10)
                SkeletonBar(width: 200, height: 8)
            }
        }
        .padding(.horizontal, Space.s5).padding(.vertical, density.verticalPadding)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.borderSoft).frame(height: 1) }
    }
}

/// One thread row, anatomy from webmail ThreadList.svelte: avatar, then sender and time, then the
/// subject line (unread dot first, count last), then the preview line (paperclip and star at the end).
struct ThreadRow: View {
    let row: ConversationSummary
    let density: Density
    let selected: Bool
    let focused: Bool
    let outgoing: Bool
    var store: MailStore
    @State private var hover = false

    var body: some View {
        let e = row.latest
        let unread = row.unread
        let address = outgoing ? (e.to.first ?? e.fromAddr) : e.fromAddr
        let name = outgoing ? Self.recipientName(e) : (e.fromName.isEmpty ? e.fromAddr : e.fromName)
        let picture = AvatarDecision.picture(entry: store.avatars.entry(address), message: MessageAuthState(e), outgoing: outgoing)
        HStack(alignment: .top, spacing: Space.s3) {
            AvatarView(name: name, address: address, picture: picture, size: density.avatar)
            VStack(alignment: .leading, spacing: Space.s1) {
                HStack(spacing: Space.s2) {
                    Text(name).font(Fonts.sans(13, unread ? .bold : .medium)).foregroundStyle(Theme.text).lineLimit(1)
                    Spacer(minLength: Space.s1)
                    Text(TimeFormat.short(e.sentAt)).font(Fonts.sans(11, unread ? .bold : .regular))
                        .foregroundStyle(unread ? Theme.accentFg : Theme.text3)
                }
                HStack(spacing: Space.s2) {
                    if unread { Circle().fill(Theme.accentDot).frame(width: 8, height: 8) }
                    Text(e.subject.isEmpty ? "(no subject)" : e.subject).font(Fonts.sans(12, unread ? .semibold : .regular))
                        .foregroundStyle(Theme.text).lineLimit(1)
                    Spacer(minLength: 0)
                    if row.count > 1 { Text("\(row.count)").font(Fonts.mono(10)).foregroundStyle(Theme.text3) }
                }
                HStack(spacing: Space.s2) {
                    Text(e.snippet).taifa(.meta).foregroundStyle(Theme.text2).lineLimit(1)
                    Spacer(minLength: 0)
                    if e.hasAttachments { Icon(.attachment, size: 13).foregroundStyle(Theme.text3) }
                    if e.flagged { Icon(.star, size: 12).foregroundStyle(Theme.warn) }
                }
            }
        }
        .padding(.horizontal, Space.s5).padding(.vertical, density.verticalPadding)
        .background(SelectionBackground(selected: selected, focused: focused, hovering: hover))
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.borderSoft).frame(height: 1) }
        .overlay(alignment: .topTrailing) { if hover { hoverActions.padding(.top, Space.s8).padding(.trailing, Space.s4) } }
        .onHover { hover = $0 }
        .onAppear { store.avatars.request(address) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(name), \(e.subject), \(TimeFormat.short(e.sentAt)), \(unread ? "unread" : "read")\(e.flagged ? ", starred" : "")\(e.hasAttachments ? ", has attachments" : "")")
        .accessibilityIdentifier("thread-row-\(e.uid)")
    }

    /// Hover actions of the webmail row: archive, delete, mark read or unread, star.
    private var hoverActions: some View {
        HStack(spacing: 0) {
            rowAction(.archive, "Archive") { store.perform(.archive, on: [row]) }
            rowAction(.trash, "Delete") { store.perform(.trash, on: [row]) }
            rowAction(row.unread ? .openMail : .unread, row.unread ? "Mark as read" : "Mark as unread") { store.perform(.read(row.unread), on: [row]) }
            rowAction(.star, row.latest.flagged ? "Remove star" : "Star") { store.perform(.flag(!row.latest.flagged), on: [row]) }
        }
        .padding(2)
        .background(Theme.panel, in: RoundedRectangle(cornerRadius: Radius.ctl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.ctl, style: .continuous).strokeBorder(Theme.border))
    }

    private func rowAction(_ icon: Icon.Name, _ label: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Icon(icon, size: 16).foregroundStyle(Theme.text2).frame(width: 28, height: 28) }
            .buttonStyle(.plain).hoverFill().help(label).accessibilityLabel(label)
    }

    static func recipientName(_ e: Envelope) -> String {
        guard let first = e.to.first else { return "(no recipient)" }
        if let lt = first.firstIndex(of: "<") {
            let n = first[..<lt].trimmingCharacters(in: CharacterSet(charactersIn: " \""))
            if !n.isEmpty { return n }
        }
        return first
    }
}

struct ThreadContextMenu: View {
    var store: MailStore
    let row: ConversationSummary
    var body: some View {
        let targets = store.selection.contains(row.id) ? store.selectedRows : [row]
        Button("Reply") { ComposeLauncher.shared.open(kind: .reply, store: store, row: row) }
        Button("Reply All") { ComposeLauncher.shared.open(kind: .replyAll, store: store, row: row) }
        Button("Forward") { ComposeLauncher.shared.open(kind: .forward, store: store, row: row) }
        Divider()
        Button("Archive") { store.perform(.archive, on: targets) }
        Button("Move to Trash") { store.perform(.trash, on: targets) }
        Button("Move to Junk") { store.perform(.junk, on: targets) }
        Menu("Move to") {
            ForEach(store.folders.filter { $0.path != row.latest.folder }) { f in Button(f.name) { store.perform(.move(f.path), on: targets) } }
        }
        Divider()
        Button(row.latest.flagged ? "Remove Flag" : "Flag") { store.perform(.flag(!row.latest.flagged), on: targets) }
        Button(row.unread ? "Mark as Read" : "Mark as Unread") { store.perform(.read(row.unread), on: targets) }
    }
}
