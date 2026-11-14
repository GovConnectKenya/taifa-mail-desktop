import SwiftUI
import AppKit

struct RootView: View {
    var app: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            switch app.phase {
            case .launching:
                ZStack { Theme.bg.ignoresSafeArea(); ProgressView() }
            case .signedOut:
                SignInView(model: app.signIn, app: app, offline: false, banner: app.sessionBanner)
            case .signedIn:
                if let store = app.store { MainView(app: app, store: store) }
            }
        }
        .frame(minWidth: 900, minHeight: 600)
        .preferredColorScheme(app.prefs.theme.colorScheme)
        .task {
            ComposeLauncher.shared.opener = { openWindow(id: "compose", value: $0) }
            await app.launch()
        }
        .onChange(of: app.session?.address) { _, a in ComposeLauncher.shared.ownAddress = a ?? "" }
    }
}

struct MainView: View {
    var app: AppModel
    var store: MailStore
    @State private var visibility: NavigationSplitViewVisibility = .all
    @State private var searchPresented = false

    var body: some View {
        @Bindable var store = store
        NavigationSplitView(columnVisibility: $visibility) {
            SidebarView(app: app, store: store)
                .navigationSplitViewColumnWidth(min: 200, ideal: 220, max: 280)
        } content: {
            ThreadListView(app: app, store: store)
                .navigationSplitViewColumnWidth(min: 300, ideal: 360, max: 480)
                .overlay(alignment: .bottom) { NoticeToast(store: store).padding(Space.s3) }
                .navigationTitle(store.isSearching ? "Search" : (store.currentFolder?.name.capitalized ?? "Inbox"))
                .navigationSubtitle(subtitle)
        } detail: {
            ReaderView(app: app, store: store)
        }
        .searchable(text: $store.searchText, isPresented: $searchPresented, placement: .toolbar, prompt: "Search")
        .searchScopes($store.searchAllFolders) {
            Text("This folder").tag(false)
            Text("All folders").tag(true)
        }
        .task(id: store.searchText + (store.searchAllFolders ? "1" : "0")) {
            if store.searchText.trimmingCharacters(in: .whitespaces).isEmpty { await store.endSearch(); return }
            try? await Task.sleep(nanoseconds: 300_000_000)
            if Task.isCancelled { return }
            await store.runSearch()
        }
        .toolbar { MailToolbar(store: store) }
        .onReceive(NotificationCenter.default.publisher(for: .focusSearch)) { _ in searchPresented = true }
        .accessibilityIdentifier("main-window")
    }

    private var subtitle: String {
        if store.isSearching { return "\(store.total) results" }
        let unseen = store.currentFolder?.unseen ?? 0
        return unseen > 0 ? "\(unseen) unread" : "\(store.total) messages"
    }
}

extension Notification.Name { static let focusSearch = Notification.Name("ke.govconnect.TaifaMail.focusSearch") }

struct MailToolbar: ToolbarContent {
    var store: MailStore
    var body: some ToolbarContent {
        ToolbarItemGroup(placement: .navigation) {
            IconButton(icon: .compose, label: "New Message") { ComposeLauncher.shared.openNew() }
            IconButton(icon: .refresh, label: "Refresh") { Task { await store.refresh() } }
        }
        ToolbarItemGroup(placement: .primaryAction) {
            let has = !store.selection.isEmpty
            let single = store.selection.count == 1 ? store.selectedRows.first : nil
            IconButton(icon: .archive, label: "Archive") { store.perform(.archive) }.disabled(!has)
            IconButton(icon: .trash, label: "Delete") { store.perform(.trash) }.disabled(!has)
            IconButton(icon: .junk, label: "Junk") { store.perform(.junk) }.disabled(!has)
            Menu {
                ForEach(store.folders.filter { $0.path != store.selectedFolder }) { f in Button(f.name) { store.perform(.move(f.path)) } }
            } label: { Icon(.folder, size: 18) }.disabled(!has).help("Move to folder").accessibilityLabel("Move to folder")
            IconButton(icon: .flag, label: "Flag") { store.perform(.flag(!(single?.latest.flagged ?? false))) }.disabled(!has)
            IconButton(icon: .unread, label: "Mark Unread") { store.perform(.read(single?.unread ?? false)) }.disabled(!has)
            IconButton(icon: .reply, label: "Reply") { if let r = single { ComposeLauncher.shared.open(kind: .reply, store: store, row: r) } }.disabled(single == nil)
            IconButton(icon: .replyAll, label: "Reply All") { if let r = single { ComposeLauncher.shared.open(kind: .replyAll, store: store, row: r) } }.disabled(single == nil)
            IconButton(icon: .forward, label: "Forward") { if let r = single { ComposeLauncher.shared.open(kind: .forward, store: store, row: r) } }.disabled(single == nil)
        }
    }
}

struct NoticeToast: View {
    var store: MailStore
    var body: some View {
        if let n = store.notice {
            HStack(spacing: Space.s3) {
                Icon(n.isError ? .danger : .check, size: 16).foregroundStyle(n.isError ? Theme.dangerFg : Theme.accentFg)
                Text(n.text).taifa(.body).foregroundStyle(Theme.text)
                if n.canUndo { Button("Undo") { store.performUndo() }.buttonStyle(QuietButtonStyle()).accessibilityIdentifier("toast-undo") }
            }
            .padding(.horizontal, Space.s4).frame(height: 40)
            .background(Theme.panel, in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.border2))
            .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("toast")
        }
    }
}
