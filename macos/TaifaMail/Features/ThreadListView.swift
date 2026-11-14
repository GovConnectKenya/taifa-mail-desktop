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
            if store.isOffline { Banner(kind: .warn, icon: .wifi, message: "Offline. Showing the last synced mail.").padding(Space.s2) }
            if store.isSearching && store.searchIncomplete {
                Banner(kind: .info, icon: .info, message: "Showing the newest matches only.").padding(.horizontal, Space.s2).padding(.top, Space.s2)
            }
            if store.selection.count > 1 {
                HStack {
                    Text("\(store.selection.count) selected").taifa(.bodyStrong).foregroundStyle(Theme.text)
                    Spacer()
                }.padding(.horizontal, Space.s4).frame(height: 32).background(Theme.panel2)
            }
            content(density: density)
        }
        .background(Theme.panel)
    }

    @ViewBuilder private func content(density: Density) -> some View {
        switch store.listState {
        case .loading where store.rows.isEmpty, .idle where store.rows.isEmpty:
            VStack(spacing: 0) { ForEach(0..<8, id: \.self) { _ in SkeletonRow(density: density) }; Spacer() }
                .accessibilityIdentifier("thread-skeleton")
        case .failed(let message) where store.rows.isEmpty:
            VStack { Banner(kind: .danger, icon: .danger, message: message, actionTitle: "Retry") { Task { await store.refresh() } }.padding(Space.s4); Spacer() }
        case _ where store.rows.isEmpty:
            EmptyState(icon: store.isSearching ? .search : .inbox, title: store.isSearching ? "No messages match" : "Nothing here",
                       hint: store.isSearching ? "No messages match your search." : "This folder has no messages.")
        default:
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(store.rows) { row in
                            ThreadRow(row: row, density: density, selected: store.selection.contains(row.id), focused: focused,
                                      outgoing: store.isOutgoingFolder, store: store)
                                .frame(height: density.rowHeight)
                                .padding(.horizontal, Space.s2)
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
                    .padding(.vertical, Space.s1)
                }
                .accessibilityIdentifier("thread-list")
                .focusable()
                .focused($focused)
                .focusEffectDisabled()
                .onKeyPress(.downArrow) { store.moveSelection(by: 1, extend: NSEvent.modifierFlags.contains(.shift)); scroll(proxy); return .handled }
                .onKeyPress(.upArrow) { store.moveSelection(by: -1, extend: NSEvent.modifierFlags.contains(.shift)); scroll(proxy); return .handled }
                .onKeyPress(.return) { return .handled }
            }
        }
    }

    private func scroll(_ proxy: ScrollViewProxy) {
        if let id = store.anchorId { proxy.scrollTo(id) }
    }
}

struct SkeletonRow: View {
    var density: Density
    var body: some View {
        HStack(spacing: Space.s3) {
            Circle().fill(Theme.track).frame(width: density.avatar, height: density.avatar)
            VStack(alignment: .leading, spacing: Space.s2) {
                SkeletonBar(width: 140, height: 10)
                SkeletonBar(height: 10)
                if density == .comfortable { SkeletonBar(width: 200, height: 8) }
            }
        }
        .padding(.horizontal, Space.s4)
        .frame(height: density.rowHeight)
    }
}

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
        HStack(spacing: Space.s3) {
            Circle().fill(unread ? Theme.accentDot : Color.clear).frame(width: 8, height: 8)
            AvatarView(name: name, address: address, picture: picture, size: density.avatar)
            VStack(alignment: .leading, spacing: density == .comfortable ? 2 : 1) {
                HStack(spacing: Space.s1) {
                    Text(name).taifa(unread ? .bodyStrong : .body).foregroundStyle(Theme.text).lineLimit(1)
                    if row.count > 1 { Text("\(row.count)").taifa(.caption).foregroundStyle(Theme.text3) }
                    Spacer(minLength: Space.s1)
                    if e.hasAttachments { Icon(.attachment, size: 14).foregroundStyle(Theme.text3) }
                    if e.flagged { Icon(.flag, size: 14).foregroundStyle(Theme.flag) }
                    Text(TimeFormat.short(e.sentAt)).taifa(.caption).foregroundStyle(unread ? Theme.accentFg : Theme.text3)
                }
                if density == .comfortable {
                    Text(e.subject.isEmpty ? "(no subject)" : e.subject).taifa(unread ? .bodyStrong : .body).foregroundStyle(Theme.text).lineLimit(1)
                    Text(e.snippet).taifa(.meta).foregroundStyle(Theme.text3).lineLimit(1)
                } else {
                    Text(compactLine(e)).taifa(.meta).foregroundStyle(Theme.text3).lineLimit(1)
                }
            }
        }
        .padding(.horizontal, Space.s2)
        .background(SelectionBackground(selected: selected, focused: focused, hovering: hover))
        .onHover { hover = $0 }
        .onAppear { store.avatars.request(address) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(name), \(e.subject), \(TimeFormat.short(e.sentAt)), \(unread ? "unread" : "read")\(e.flagged ? ", flagged" : "")\(e.hasAttachments ? ", has attachments" : "")")
        .accessibilityIdentifier("thread-row-\(e.uid)")
    }

    private func compactLine(_ e: Envelope) -> String {
        let s = e.subject.isEmpty ? "(no subject)" : e.subject
        return e.snippet.isEmpty ? s : "\(s)  \(e.snippet)"
    }

    static func recipientName(_ e: Envelope) -> String {
        guard let first = e.to.first else { return "(no recipient)" }
        // "Name <addr>" or a bare address.
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
