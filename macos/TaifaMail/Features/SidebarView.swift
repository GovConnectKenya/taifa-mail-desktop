import SwiftUI

struct SidebarView: View {
    var app: AppModel
    var store: MailStore

    var body: some View {
        VStack(spacing: 0) {
            MailboxSwitcher(app: app)
                .padding(.horizontal, Space.s3).padding(.top, Space.s3).padding(.bottom, Space.s2)
            ScrollView {
                LazyVStack(spacing: Space.s1) {
                    switch store.foldersState {
                    case .loading, .idle where store.folders.isEmpty:
                        ForEach(0..<6, id: \.self) { _ in
                            HStack(spacing: Space.s2) { SkeletonBar(width: 16, height: 16); SkeletonBar(height: 10) }
                                .frame(height: Metrics.sidebarRow).padding(.horizontal, Space.s3)
                        }
                    case .failed(let m) where store.folders.isEmpty:
                        Banner(kind: .danger, icon: .danger, message: m, actionTitle: "Retry") { Task { await store.loadFolders() } }
                            .padding(Space.s3)
                    default:
                        let main = store.folders.filter { $0.role != .other }
                        let other = store.folders.filter { $0.role == .other }
                        ForEach(main) { row($0) }
                        if !other.isEmpty {
                            Text("Folders").taifa(.caption).foregroundStyle(Theme.text3)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .frame(height: 24).padding(.horizontal, Space.s3).padding(.top, Space.s2)
                            ForEach(other) { row($0) }
                        }
                    }
                }
                .padding(.horizontal, Space.s2)
            }
            .accessibilityIdentifier("sidebar-folders")
        }
        .background(.regularMaterial)
    }

    private func row(_ f: Folder) -> some View {
        let selected = store.selectedFolder == f.path && !store.isSearching
        let count = f.role == .drafts ? (f.total ?? 0) : (f.unseen ?? 0)
        return Button { store.selectFolder(f.path) } label: {
            HStack(spacing: Space.s2) {
                Icon(f.role.iconName.iconName, size: 16).foregroundStyle(selected ? Theme.accentFg : Theme.text2)
                Text(f.role == .other ? f.name : f.name.capitalized).taifa(selected ? .bodyStrong : .body)
                    .foregroundStyle(Theme.text).lineLimit(1)
                Spacer(minLength: Space.s1)
                if count > 0 {
                    Text(count > 99 ? "99+" : "\(count)").taifa(.caption).foregroundStyle(f.role == .inbox ? Theme.accentFg : Theme.text3)
                }
            }
            .padding(.horizontal, Space.s3)
            .frame(height: Metrics.sidebarRow)
            .background(SelectionBackground(selected: selected))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(f.name), \(f.unseen ?? 0) unread")
        .accessibilityIdentifier("folder-\(f.path)")
    }
}

private extension String {
    var iconName: Icon.Name { Icon.Name(rawValue: self) ?? .folder }
}

struct MailboxSwitcher: View {
    var app: AppModel
    var body: some View {
        let s = app.session
        Menu {
            if !app.switchable.isEmpty {
                ForEach(app.switchable) { m in
                    Button(m.displayName ?? m.address) { Task { await app.switchMailbox(to: m.mailboxId) } }
                }
                Divider()
            }
            SettingsLink { Text("Settings") }
            Button("Sign out") { Task { await app.signOut() } }
        } label: {
            HStack(spacing: Space.s2) {
                AvatarView(name: s?.displayName ?? s?.address ?? "", address: s?.address ?? "", picture: .none, size: 28)
                VStack(alignment: .leading, spacing: 0) {
                    Text(s?.displayName ?? s?.address ?? "Mailbox").taifa(.bodyStrong).foregroundStyle(Theme.text).lineLimit(1)
                    if s?.displayName != nil { Text(s?.address ?? "").font(.taifaMono(11)).foregroundStyle(Theme.text3).lineLimit(1) }
                }
                Spacer(minLength: 0)
                Icon(.chevronDown, size: 12).foregroundStyle(Theme.text3)
            }
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden)
        .accessibilityLabel("Mailbox menu")
        .accessibilityIdentifier("mailbox-switcher")
    }
}
