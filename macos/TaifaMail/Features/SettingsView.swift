import SwiftUI

struct SettingsView: View {
    var app: AppModel
    var body: some View {
        TabView {
            GeneralPane(prefs: app.prefs).tabItem { Label("General", image: "icon-settings") }
            NotificationsPane(prefs: app.prefs).tabItem { Label("Notifications", image: "icon-bell") }
            SignaturePane(app: app).tabItem { Label("Signature", image: "icon-compose") }
            AutoReplyPane(app: app).tabItem { Label("Auto-reply", image: "icon-reply") }
            AccountPane(app: app).tabItem { Label("Account", image: "icon-user") }
        }
        .frame(minWidth: 520, idealWidth: 560, minHeight: 420, idealHeight: 480)
        .preferredColorScheme(app.prefs.theme.colorScheme)
        .tint(Theme.accentDot)
    }
}

private struct PaneForm<C: View>: View {
    let title: String
    @ViewBuilder var content: C
    var body: some View {
        VStack(alignment: .leading, spacing: Space.s4) {
            Text(title).taifa(.title).foregroundStyle(Theme.text)
            content
            Spacer(minLength: 0)
        }
        .padding(Space.s6).frame(maxWidth: .infinity, alignment: .topLeading).background(Theme.bg)
    }
}

struct GeneralPane: View {
    @Bindable var prefs: AppPreferences
    var body: some View {
        PaneForm(title: "General") {
            Picker("Theme", selection: $prefs.theme) { ForEach(ThemePreference.allCases) { Text($0.title).tag($0) } }.pickerStyle(.segmented)
            Picker("List density", selection: $prefs.density) { ForEach(Density.allCases) { Text($0.title).tag($0) } }.pickerStyle(.segmented)
        }
    }
}

struct NotificationsPane: View {
    @Bindable var prefs: AppPreferences
    var body: some View {
        PaneForm(title: "Notifications") {
            Toggle("Notify me about new mail in the Inbox", isOn: $prefs.notificationsEnabled)
            Toggle("Show unread count on the Dock icon", isOn: $prefs.badgeEnabled)
            Text("Notifications arrive while Taifa Mail is running.").taifa(.meta).foregroundStyle(Theme.text3)
        }
    }
}

struct SignaturePane: View {
    var app: AppModel
    @State private var text = ""
    @State private var existing: MailBlock?
    @State private var state: LoadState = .loading
    @State private var saved = false

    var body: some View {
        PaneForm(title: "Signature") {
            switch state {
            case .loading, .idle: VStack(alignment: .leading, spacing: Space.s2) { ForEach(0..<4, id: \.self) { _ in SkeletonBar(height: 10) } }
            case .failed(let m): Banner(kind: .danger, icon: .danger, message: m, actionTitle: "Retry") { Task { await load() } }
            case .loaded:
                TextEditor(text: $text).font(Fonts.sans(13)).onChange(of: text) { _, _ in saved = false }.frame(height: 160).scrollContentBackground(.hidden)
                    .padding(Space.s2).background(Theme.panel2, in: RoundedRectangle(cornerRadius: Radius.ctl))
                HStack {
                    Button("Save") { Task { await save() } }.buttonStyle(PrimaryButtonStyle())
                    if saved { Text("Saved").taifa(.meta).foregroundStyle(Theme.accentFg) }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard let s = app.store?.service else { return }
        state = .loading
        do {
            existing = try await s.signature()
            text = existing?.text ?? (existing?.html.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression) ?? "")
            state = .loaded
        } catch { state = .failed((error as? LocalizedError)?.errorDescription ?? "Could not load the signature.") }
    }

    private func save() async {
        guard let s = app.store?.service else { return }
        let html = text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: "\n", with: "<br>")
        do {
            try await s.saveSignature(html: html, text: text, existing: existing)
            existing = try await s.signature()   // refresh the block id without flipping to the loading state
            saved = true
        }
        catch { state = .failed((error as? LocalizedError)?.errorDescription ?? "Could not save the signature.") }
    }
}

struct AutoReplyPane: View {
    var app: AppModel
    @State private var value = AutoResponder.empty
    @State private var state: LoadState = .loading
    @State private var saved = false

    var body: some View {
        PaneForm(title: "Auto-reply") {
            switch state {
            case .loading, .idle: VStack(alignment: .leading, spacing: Space.s2) { ForEach(0..<4, id: \.self) { _ in SkeletonBar(height: 10) } }
            case .failed(let m): Banner(kind: .danger, icon: .danger, message: m, actionTitle: "Retry") { Task { await load() } }
            case .loaded:
                Toggle("Send automatic replies", isOn: $value.enabled)
                TextField("Subject", text: $value.subject).textFieldStyle(FieldStyle()).disabled(!value.enabled)
                TextEditor(text: $value.text).font(Fonts.sans(13)).onChange(of: value) { _, _ in saved = false }.frame(height: 110).scrollContentBackground(.hidden)
                    .padding(Space.s2).background(Theme.panel2, in: RoundedRectangle(cornerRadius: Radius.ctl)).disabled(!value.enabled)
                Picker("When", selection: $value.mode) {
                    Text("Always").tag("always"); Text("Outside hours").tag("outside_hours"); Text("Date range").tag("date_range")
                }.pickerStyle(.segmented).disabled(!value.enabled)
                HStack {
                    Button("Save") { Task { await save() } }.buttonStyle(PrimaryButtonStyle())
                    if saved { Text("Saved").taifa(.meta).foregroundStyle(Theme.accentFg) }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard let s = app.store?.service else { return }
        state = .loading
        do { value = try await s.autoResponder(); state = .loaded }
        catch { state = .failed((error as? LocalizedError)?.errorDescription ?? "Could not load the auto-reply.") }
    }

    private func save() async {
        guard let s = app.store?.service else { return }
        value.html = value.text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: "\n", with: "<br>")
        do { try await s.saveAutoResponder(value); saved = true }
        catch { state = .failed((error as? LocalizedError)?.errorDescription ?? "Could not save the auto-reply.") }
    }
}

struct AccountPane: View {
    var app: AppModel
    @State private var quota: Quota?
    var body: some View {
        PaneForm(title: "Account") {
            VStack(alignment: .leading, spacing: Space.s2) {
                Text(app.session?.displayName ?? app.session?.address ?? "").taifa(.bodyStrong).foregroundStyle(Theme.text)
                Text(app.session?.address ?? "").font(.taifaMono(12)).foregroundStyle(Theme.text2)
                if let i = app.session?.institution { Text(i).taifa(.meta).foregroundStyle(Theme.text3) }
            }
            if let q = quota, let limit = q.limitBytes, limit > 0 {
                VStack(alignment: .leading, spacing: Space.s1) {
                    ProgressView(value: min(1, Double(q.usedBytes) / Double(limit)))
                    Text("\(ByteCountFormatter.string(fromByteCount: Int64(q.usedBytes), countStyle: .file)) of \(ByteCountFormatter.string(fromByteCount: Int64(limit), countStyle: .file)) used")
                        .taifa(.meta).foregroundStyle(Theme.text3)
                }
            }
            Button("Sign out") { Task { await app.signOut() } }.buttonStyle(DangerQuietButtonStyle()).accessibilityIdentifier("settings-signout")
            Text("Signing out removes this mailbox's cached mail from this Mac.").taifa(.meta).foregroundStyle(Theme.text3)
        }
        .task {
            if let q = app.store?.quota { quota = q } else { quota = try? await app.store?.service.quota() }
        }
    }
}
