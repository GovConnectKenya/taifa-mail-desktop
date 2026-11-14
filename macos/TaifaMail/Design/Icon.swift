import SwiftUI

/// Interface icons: the vendored Iconsax rounded/linear set in Assets.xcassets/Icons (see NOTICE).
/// Chevrons only for directional affordances (left is arrow-left3, the chevron in rounded/linear).
struct Icon: View {
    enum Name: String {
        case chevronDown = "chevron-down", chevronUp = "chevron-up", chevronRight = "chevron-right", chevronLeft = "chevron-left"
        case inbox, drafts, sent, archive, junk, trash, folder, flag, attachment, reply, replyAll = "reply-all"
        case forward, compose, refresh, search, settings, user, unread, close, check, download, undo, sidebar
        case warning, info, wifi, send, more, imageOff = "image-off", mail, bell, danger, lock, star, openMail = "open-mail", link, list
    }

    let name: Name
    var size: CGFloat = 16

    init(_ name: Name, size: CGFloat = 16) { self.name = name; self.size = size }

    var body: some View {
        Image("icon-\(name.rawValue)")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// An icon only button for toolbars and rows.
struct IconButton: View {
    let icon: Icon.Name
    let label: String
    var size: CGFloat = 18
    var action: () -> Void
    var body: some View {
        Button(action: action) { Icon(icon, size: size).frame(minWidth: 24, minHeight: 24) }
            .help(label)
            .accessibilityLabel(label)
    }
}
