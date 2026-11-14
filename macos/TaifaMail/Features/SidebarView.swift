import SwiftUI

/// The webmail rail: brand row, a 48 px Compose button, the folder list, storage meter and account.
struct SidebarView: View {
    var app: AppModel
    var store: MailStore

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.s2) {
                BrandLogo(height: 32)
                Text("Taifa Mail").font(Fonts.sans(16, .semibold)).tracking(-0.2).foregroundStyle(Theme.text)
                Spacer()
            }
            .padding(.horizontal, Space.s4).padding(.top, Space.s4).padding(.bottom, Space.s3)

            Button { ComposeLauncher.shared.openNew() } label: {
                HStack(spacing: Space.s2) { Icon(.compose, size: 18); Text("Compose") }
                    .font(Fonts.sans(13, .semibold)).foregroundStyle(Theme.onAccent)
                    .frame(maxWidth: .infinity).frame(height: 48)
                    .background(Theme.accent, in: RoundedRectangle(cornerRadius: Radius.ctl, style: .continuous))
                    .shadow(color: Theme.shadowRaised, radius: 1, y: 1)
                    .hoverFill(tint: Color.white.opacity(0.08))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, Space.s3).padding(.bottom, Space.s3)
            .accessibilityIdentifier("sidebar-compose")

            ScrollView {
                LazyVStack(spacing: 2) {
                    switch store.foldersState {
                    case .loading, .idle where store.folders.isEmpty:
                        ForEach(0..<7, id: \.self) { _ in
                            HStack(spacing: Space.s3) { SkeletonBar(width: 16, height: 16); SkeletonBar(height: 10) }
                                .frame(height: 36).padding(.horizontal, Space.s3)
                        }
                    case .failed(let m) where store.folders.isEmpty:
                        Banner(kind: .danger, icon: .danger, message: m, actionTitle: "Retry") { Task { await store.loadFolders() } }.padding(Space.s3)
                    default:
                        ForEach(store.folders.filter { $0.role != .other }) { row($0) }
                        let other = store.folders.filter { $0.role == .other }
                        if !other.isEmpty {
                            Text("Folders").font(Fonts.sans(11, .semibold)).foregroundStyle(Theme.text3)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, Space.s3).padding(.top, Space.s4).padding(.bottom, Space.s1)
                            ForEach(other) { row($0) }
                        }
                    }
                }
                .padding(.horizontal, Space.s2)
            }
            .accessibilityIdentifier("sidebar-folders")

            StorageMeter(quota: store.quota).padding(.horizontal, Space.s4).padding(.vertical, Space.s3)
            Divider().overlay(Theme.borderSoft)
            MailboxSwitcher(app: app).padding(Space.s3)
        }
        .background(Theme.sidebar)
    }

    private func row(_ f: Folder) -> some View {
        let selected = store.selectedFolder == f.path && !store.isSearching
        let isDrafts = f.role == .drafts
        let count = isDrafts ? (f.total ?? 0) : (f.unseen ?? 0)
        return Button { store.selectFolder(f.path) } label: {
            HStack(spacing: Space.s3) {
                Icon(Icon.Name(rawValue: f.role.iconName) ?? .folder, size: 18).foregroundStyle(selected ? Theme.accentFg : Theme.text2)
                Text(f.role == .other ? f.name : f.name.capitalized).font(Fonts.sans(13, selected ? .semibold : .medium))
                    .foregroundStyle(selected ? Theme.accentFg : Theme.text).lineLimit(1)
                Spacer(minLength: Space.s1)
                if count > 0 {
                    Text(count > 999 ? "999+" : "\(count)")
                        .font(Fonts.mono(11, !isDrafts && f.role == .inbox ? .semibold : .regular))
                        .foregroundStyle(!isDrafts && (f.unseen ?? 0) > 0 ? Theme.accentFg : Theme.text3)
                }
            }
            .padding(.horizontal, Space.s3)
            .frame(height: 36)
            .background(RoundedRectangle(cornerRadius: Radius.ctl, style: .continuous).fill(selected ? Theme.accentSoft : Color.clear))
            .hoverFill(tint: selected ? Color.clear : Theme.panel2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isDrafts ? "\(f.name), \(f.total ?? 0) drafts" : "\(f.name), \(f.unseen ?? 0) unread")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("folder-\(f.path)")
    }
}

/// Mailbox usage from GET /quota.
struct StorageMeter: View {
    let quota: Quota?
    var body: some View {
        if let q = quota, let limit = q.limitBytes, limit > 0 {
            let frac = min(1, Double(q.usedBytes) / Double(limit))
            VStack(alignment: .leading, spacing: Space.s1) {
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Theme.panel2)
                        Capsule().fill(frac > 0.9 ? Theme.danger : Theme.accentDot).frame(width: max(4, g.size.width * frac))
                    }
                }.frame(height: 4)
                Text("\(ByteCountFormatter.string(fromByteCount: Int64(q.usedBytes), countStyle: .file)) of \(ByteCountFormatter.string(fromByteCount: Int64(limit), countStyle: .file)) used")
                    .font(Fonts.sans(11)).foregroundStyle(Theme.text3)
            }
            .accessibilityElement(children: .combine)
        }
    }
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
                    Text(s?.displayName ?? s?.address ?? "Mailbox").font(Fonts.sans(13, .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                    if s?.displayName != nil { Text(s?.address ?? "").font(Fonts.mono(10)).foregroundStyle(Theme.text3).lineLimit(1).truncationMode(.middle) }
                }
                Spacer(minLength: 0)
                Icon(.chevronUp, size: 12).foregroundStyle(Theme.text3)
            }
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden)
        .accessibilityLabel("Mailbox menu")
        .accessibilityIdentifier("mailbox-switcher")
    }
}
