import SwiftUI
import AppKit

struct RootView: View {
    var app: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            switch app.phase {
            case .launching:
                LaunchSkeleton()
            case .signedOut:
                SignInView(model: app.signIn, app: app, offline: false, banner: app.sessionBanner)
            case .signedIn:
                if let store = app.store { MainView(app: app, store: store) }
            }
        }
        .frame(minWidth: 900, minHeight: 600)
        .preferredColorScheme(app.prefs.theme.colorScheme)
        .tint(Theme.accentDot)
        .task {
            ComposeLauncher.shared.opener = { openWindow(id: "compose", value: $0) }
            app.openMainWindow = { openWindow(id: "main") }
            await app.launch()
        }
        .onChange(of: app.session?.address) { _, a in ComposeLauncher.shared.ownAddress = a ?? "" }
    }
}

/// Pane skeleton shown while the session is checked at launch.
struct LaunchSkeleton: View {
    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: Space.s3) {
                HStack(spacing: Space.s2) { BrandLogo(height: 32); Text("Taifa Mail").font(Fonts.sans(16, .semibold)).foregroundStyle(Theme.text) }
                SkeletonBar(height: 48)
                ForEach(0..<6, id: \.self) { _ in SkeletonBar(height: 14) }
                Spacer()
            }.padding(Space.s4).frame(width: 256).background(Theme.sidebar)
            VStack(spacing: 0) { ForEach(0..<8, id: \.self) { _ in SkeletonRow(density: .comfortable) }; Spacer() }
                .frame(width: 392).background(Theme.bg)
            Theme.bg
        }
        .accessibilityIdentifier("launch-skeleton")
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
                .navigationSplitViewColumnWidth(min: 200, ideal: 256, max: 300)
        } content: {
            ThreadListView(app: app, store: store)
                .navigationSplitViewColumnWidth(min: 320, ideal: 392, max: 520)
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
        .overlay(alignment: .bottom) { NoticeToast(store: store).padding(.bottom, Space.s6).padding(.horizontal, Space.s4) }
        .onReceive(NotificationCenter.default.publisher(for: .focusSearch)) { _ in searchPresented = true }
        .accessibilityIdentifier("main-window")
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
    }
}

/// ToastPill: radius 8, 1 px border, surface, min height 44, padding 12/20, Undo in accent ink, close button.
struct NoticeToast: View {
    var store: MailStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        ZStack {
            if let n = store.notice {
                HStack(spacing: Space.s3) {
                    Icon(n.isError ? .danger : .check, size: 16).foregroundStyle(n.isError ? Theme.dangerFg : Theme.accentFg)
                    Text(n.text).font(Fonts.sans(13, .medium)).foregroundStyle(Theme.text).lineLimit(2)
                    Spacer(minLength: Space.s2)
                    if n.canUndo { Button("Undo") { store.performUndo() }.buttonStyle(.plain).font(Fonts.sans(13, .semibold)).foregroundStyle(Theme.accentFg).accessibilityIdentifier("toast-undo") }
                    Button { store.dismissNotice() } label: { Icon(.close, size: 14).foregroundStyle(Theme.text3) }.buttonStyle(.plain).accessibilityLabel("Dismiss")
                }
                .padding(.horizontal, Space.s5).padding(.vertical, Space.s3)
                .frame(minHeight: 44).frame(maxWidth: 420)
                .background(Theme.panel, in: RoundedRectangle(cornerRadius: Radius.ctl, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Radius.ctl, style: .continuous).strokeBorder(Theme.border))
                .shadow(color: Theme.shadowOverlay, radius: 20, y: 8)
                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("toast")
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: store.notice)
    }
}
