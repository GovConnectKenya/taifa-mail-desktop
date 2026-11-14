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
            Toggle("Show sender and subject in alerts", isOn: $prefs.showSenderInAlerts)
            Toggle("Include a preview of the message", isOn: $prefs.showSnippetInAlerts).disabled(!prefs.showSenderInAlerts)
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
                if existing?.hasConfig == true {
                    // Built in the web designer: plain text here would overwrite its layout.
                    Banner(kind: .info, icon: .info, message: "This signature was built in the web editor, so it can only be changed there.")
                    Text(existing?.plainText ?? "").font(Fonts.sans(13)).foregroundStyle(Theme.text2)
                        .padding(Space.s3).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.panel2, in: RoundedRectangle(cornerRadius: Radius.ctl))
                    Button("Edit on the web") { NSWorkspace.shared.open(URL(string: "https://mail.govconnect.ke")!) }
                        .buttonStyle(OutlinePillStyle()).accessibilityIdentifier("signature-edit-web")
                } else {
                    TextEditor(text: $text).font(Fonts.sans(13)).onChange(of: text) { _, _ in saved = false }.frame(height: 160).scrollContentBackground(.hidden)
                        .padding(Space.s2).background(Theme.panel2, in: RoundedRectangle(cornerRadius: Radius.ctl))
                    HStack {
                        Button("Save") { Task { await save() } }.buttonStyle(PrimaryButtonStyle())
                        if saved { Text("Saved").taifa(.meta).foregroundStyle(Theme.accentFg) }
                    }
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
            text = existing?.plainText ?? ""
            state = .loaded
        } catch { state = .failed((error as? LocalizedError)?.errorDescription ?? "Could not load the signature.") }
    }

    private func save() async {
        guard let s = app.store?.service, existing?.hasConfig != true else { return }
        let html = text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: "\n", with: "<br>")
        do {
            try await s.saveSignature(html: html, text: text, existing: existing)
            existing = try await s.signature()
            saved = true
        } catch { state = .failed((error as? LocalizedError)?.errorDescription ?? "Could not save the signature.") }
    }
}

/// East Africa Time helpers for the auto-reply schedule (the server stores offset aware ISO strings).
enum AutoReplyDates {
    static let eat = TimeZone(secondsFromGMT: 3 * 3600)!
    static var calendar: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = eat; return c }
    private static var formatter: ISO8601DateFormatter {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; f.timeZone = eat; return f
    }
    /// Start of the chosen day, 00:00:00 +03:00.
    static func start(_ d: Date) -> String { formatter.string(from: calendar.startOfDay(for: d)) }
    /// The end date is inclusive: 23:59:59 +03:00 of the chosen day.
    static func end(_ d: Date) -> String {
        let day = calendar.startOfDay(for: d)
        return formatter.string(from: calendar.date(byAdding: .second, value: 86_399, to: day)!)
    }
    static func parse(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        let a = ISO8601DateFormatter(); a.formatOptions = [.withInternetDateTime]
        let b = ISO8601DateFormatter(); b.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return a.date(from: s) ?? b.date(from: s)
    }
    static let dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    static func hourLabel(_ h: Int) -> String { String(format: "%02d:00 EAT", h) }
}

/// What to send back for the auto-reply: the edited text, or exactly what the server gave us.
enum AutoReplyPayload {
    static func prepare(_ value: AutoResponder, original: AutoResponder, edited: Bool, startDate: Date?, endDate: Date?) -> AutoResponder {
        var v = value
        if edited {
            v.html = value.text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: "\n", with: "<br>")
        } else {
            v.html = original.html; v.text = original.text   // round trip, never flatten web HTML
        }
        v.days = Array(Set(value.days)).filter { (0...6).contains($0) }.sorted()
        v.startHour = min(23, max(0, value.startHour)); v.endHour = min(23, max(0, value.endHour))
        if value.mode == "date_range" {
            v.startAt = startDate.map(AutoReplyDates.start); v.endAt = endDate.map(AutoReplyDates.end)
        }
        return v
    }
    /// date_range needs both dates (and a sensible order) before it can be enabled.
    static func validate(_ value: AutoResponder, startDate: Date?, endDate: Date?) -> String? {
        guard value.enabled, value.mode == "date_range" else { return nil }
        guard let s = startDate, let e = endDate else { return "Choose both a start date and an end date." }
        if AutoReplyDates.calendar.startOfDay(for: e) < AutoReplyDates.calendar.startOfDay(for: s) { return "The end date must not be before the start date." }
        return nil
    }
}

struct AutoReplyPane: View {
    var app: AppModel
    @State private var value = AutoResponder.empty
    @State private var original = AutoResponder.empty
    @State private var edited = false
    @State private var startDate: Date?
    @State private var endDate: Date?
    @State private var state: LoadState = .loading
    @State private var saved = false

    var body: some View {
        PaneForm(title: "Auto-reply") {
            switch state {
            case .loading, .idle: VStack(alignment: .leading, spacing: Space.s2) { ForEach(0..<4, id: \.self) { _ in SkeletonBar(height: 10) } }
            case .failed(let m): Banner(kind: .danger, icon: .danger, message: m, actionTitle: "Retry") { Task { await load() } }
            case .loaded:
                ScrollView {
                    VStack(alignment: .leading, spacing: Space.s3) {
                        Toggle("Send automatic replies", isOn: $value.enabled)
                        TextField("Subject", text: $value.subject).textFieldStyle(FieldStyle()).disabled(!value.enabled)
                        TextEditor(text: Binding(get: { value.text }, set: { value.text = $0; edited = true }))
                            .font(Fonts.sans(13)).frame(height: 96).scrollContentBackground(.hidden)
                            .padding(Space.s2).background(Theme.panel2, in: RoundedRectangle(cornerRadius: Radius.ctl)).disabled(!value.enabled)
                        Picker("When", selection: $value.mode) {
                            Text("Always").tag("always"); Text("Outside hours").tag("outside_hours"); Text("Date range").tag("date_range")
                        }.pickerStyle(.segmented).disabled(!value.enabled)
                        if value.mode == "outside_hours" {
                            HStack(spacing: Space.s1) {
                                ForEach(0..<7, id: \.self) { d in
                                    Toggle(AutoReplyDates.dayNames[d], isOn: Binding(get: { value.days.contains(d) }, set: { on in
                                        if on { value.days.append(d) } else { value.days.removeAll { $0 == d } }
                                    })).toggleStyle(.button).disabled(!value.enabled)
                                }
                            }
                            HStack {
                                Picker("From", selection: $value.startHour) { ForEach(0..<24, id: \.self) { Text(AutoReplyDates.hourLabel($0)).tag($0) } }
                                Picker("Until", selection: $value.endHour) { ForEach(0..<24, id: \.self) { Text(AutoReplyDates.hourLabel($0)).tag($0) } }
                            }.disabled(!value.enabled)
                            Text("Replies are sent on the selected days outside these hours, East Africa Time.").taifa(.meta).foregroundStyle(Theme.text3)
                        }
                        if value.mode == "date_range" {
                            HStack {
                                DatePicker("From", selection: Binding(get: { startDate ?? Date() }, set: { startDate = $0 }), displayedComponents: .date)
                                DatePicker("Until (inclusive)", selection: Binding(get: { endDate ?? Date() }, set: { endDate = $0 }), displayedComponents: .date)
                            }.disabled(!value.enabled)
                            if startDate == nil || endDate == nil {
                                Button("Set dates") { startDate = startDate ?? Date(); endDate = endDate ?? Date() }.buttonStyle(QuietButtonStyle())
                            }
                        }
                        if let problem = AutoReplyPayload.validate(value, startDate: startDate, endDate: endDate) {
                            Banner(kind: .warn, icon: .warning, message: problem)
                        }
                        HStack {
                            Button("Save") { Task { await save() } }.buttonStyle(PrimaryButtonStyle())
                                .disabled(AutoReplyPayload.validate(value, startDate: startDate, endDate: endDate) != nil)
                            if saved { Text("Saved").taifa(.meta).foregroundStyle(Theme.accentFg) }
                        }
                    }
                }
                .onChange(of: value) { _, _ in saved = false }
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard let s = app.store?.service else { return }
        state = .loading
        do {
            let v = try await s.autoResponder()
            value = v; original = v; edited = false
            startDate = AutoReplyDates.parse(v.startAt); endDate = AutoReplyDates.parse(v.endAt)
            state = .loaded
        } catch { state = .failed((error as? LocalizedError)?.errorDescription ?? "Could not load the auto-reply.") }
    }

    private func save() async {
        guard let s = app.store?.service else { return }
        let payload = AutoReplyPayload.prepare(value, original: original, edited: edited, startDate: startDate, endDate: endDate)
        do { try await s.saveAutoResponder(payload); original = payload; edited = false; saved = true }
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
