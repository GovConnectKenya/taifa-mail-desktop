import SwiftUI
import AppKit

@main
struct TaifaMailApp: App {
    @State private var app: AppModel

    init() {
        Fonts.registerBundled()
        #if DEBUG
        let preview = ProcessInfo.processInfo.arguments.contains("-TaifaPreviewData")
        if preview {
            let model = AppModel(secrets: MemorySecretStore(),
                                 cacheDirectory: FileManager.default.temporaryDirectory.appendingPathComponent("TaifaMailPreviewCache-\(UUID().uuidString)"),
                                 defaults: UserDefaults(suiteName: "ke.govconnect.TaifaMail.preview") ?? .standard,
                                 preview: true)
            _app = State(initialValue: model)
            return
        }
        #endif
        _app = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup("Taifa Mail", id: "main") {
            RootView(app: app)
        }
        .defaultSize(width: 1280, height: 800)
        .windowToolbarStyle(.unified)
        .commands { MailCommands(app: app) }

        WindowGroup("New Message", id: "compose", for: ComposeSeed.self) { $seed in
            if let seed { ComposeWindow(app: app, seed: seed) }
        }
        .defaultSize(width: 640, height: 560)

        Settings { SettingsView(app: app) }
    }
}

struct ComposeWindow: View {
    var app: AppModel
    let seed: ComposeSeed
    @State private var model: ComposeModel?
    @State private var signature: String?

    var body: some View {
        Group {
            if let model { ComposeView(model: model, signature: signature).preferredColorScheme(app.prefs.theme.colorScheme).tint(Theme.accentDot) }
            else { ProgressView() }
        }
        .navigationTitle(model?.subject.isEmpty == false ? model!.subject : "New Message")
        .task {
            guard model == nil, let store = app.store else { return }
            signature = (try? await store.service.signature())?.text
            model = ComposeModel(seed: seed, service: store.service, from: app.session?.address ?? "",
                                 recents: store.rows.prefix(80).map(\.latest.fromAddr))
        }
    }
}

struct MailCommands: Commands {
    var app: AppModel
    @Environment(\.openWindow) private var openWindow
    private var hasSelection: Bool { !(store?.selection.isEmpty ?? true) }
    private var hasSingle: Bool { store?.selection.count == 1 }
    private var store: MailStore? { app.store }

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Message") { ComposeLauncher.shared.openNew() }.keyboardShortcut("n")
        }
        CommandGroup(after: .textEditing) {
            Button("Find") { NotificationCenter.default.post(name: .focusSearch, object: nil) }.keyboardShortcut("f")
            Button("Search All Folders") {
                store?.searchAllFolders = true
                NotificationCenter.default.post(name: .focusSearch, object: nil)
            }.keyboardShortcut("f", modifiers: [.command, .option])
        }
        CommandGroup(before: .sidebar) {
            Menu("Density") {
                ForEach(Density.allCases) { d in Toggle(d.title, isOn: Binding(get: { app.prefs.density == d }, set: { _ in app.prefs.density = d })) }
            }
            Menu("Theme") {
                ForEach(ThemePreference.allCases) { t in Toggle(t.title, isOn: Binding(get: { app.prefs.theme == t }, set: { _ in app.prefs.theme = t })) }
            }
            Divider()
        }
        CommandGroup(after: .windowList) {
            Button("Taifa Mail") { openWindow(id: "main") }.keyboardShortcut("0")
        }
        CommandMenu("Message") {
            Button("Reply") { withSingle { ComposeLauncher.shared.open(kind: .reply, store: $0, row: $1) } }.keyboardShortcut("r").disabled(!hasSingle)
            Button("Reply All") { withSingle { ComposeLauncher.shared.open(kind: .replyAll, store: $0, row: $1) } }.keyboardShortcut("r", modifiers: [.command, .shift]).disabled(!hasSingle)
            Button("Forward") { withSingle { ComposeLauncher.shared.open(kind: .forward, store: $0, row: $1) } }.keyboardShortcut("f", modifiers: [.command, .shift]).disabled(!hasSingle)
            Divider()
            Button("Archive") { store?.perform(.archive) }.keyboardShortcut("a", modifiers: [.command, .control]).disabled(!hasSelection)
            Button("Move to Trash") { store?.perform(.trash) }.keyboardShortcut(.delete, modifiers: .command).disabled(!hasSelection)
            Button("Move to Junk") { store?.perform(.junk) }.keyboardShortcut("j", modifiers: [.command, .shift]).disabled(!hasSelection)
            Menu("Move to") {
                ForEach(store?.folders ?? []) { f in Button(f.name) { store?.perform(.move(f.path)) } }
            }
            Divider()
            Button("Flag") { if let s = store { s.perform(.flag(!(s.selectedRows.first?.latest.flagged ?? false))) } }.keyboardShortcut("l", modifiers: [.command, .shift]).disabled(!hasSelection)
            Button("Mark as Unread") { if let s = store { s.perform(.read(s.selectedRows.first?.unread ?? false)) } }.keyboardShortcut("u", modifiers: [.command, .shift]).disabled(!hasSelection)
            Divider()
            Button("Undo Last Action") { store?.performUndo() }.keyboardShortcut("z", modifiers: [.command, .option]).disabled(!(store?.canUndo ?? false))
        }
        CommandMenu("Mailbox") {
            Button("Refresh") { Task { await store?.refresh() } }.keyboardShortcut("k", modifiers: [.command, .shift])
            Divider()
            ForEach(Array((store?.folders ?? []).prefix(6).enumerated()), id: \.element.id) { i, f in
                Button("Go to \(f.name)") { store?.selectFolder(f.path) }.keyboardShortcut(KeyEquivalent(Character("\(i + 1)")), modifiers: .command)
            }
        }
        CommandGroup(replacing: .help) {
            Button("Taifa Mail Help") { NSWorkspace.shared.open(URL(string: "https://mail.govconnect.ke")!) }
        }
    }

    private func withSingle(_ f: (MailStore, ConversationSummary) -> Void) {
        guard let s = store, let r = s.selectedRows.first else { return }
        f(s, r)
    }
}
