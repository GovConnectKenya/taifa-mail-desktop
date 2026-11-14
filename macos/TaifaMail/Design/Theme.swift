import SwiftUI
import AppKit

/// Design tokens from docs/native/DESIGN_SPEC.md. Nothing outside this file uses a raw colour or spacing value.
enum Space {
    static let s1: CGFloat = 4
    static let s2: CGFloat = 8
    static let s3: CGFloat = 12
    static let s4: CGFloat = 16
    static let s5: CGFloat = 20
    static let s6: CGFloat = 24
    static let s8: CGFloat = 32
}

enum Radius {
    static let xs: CGFloat = 4
    static let ctl: CGFloat = 8
    static let card: CGFloat = 12
    static let panel: CGFloat = 16
}

enum Metrics {
    static let sidebarRow: CGFloat = 32
    static let rowComfortable: CGFloat = 76
    static let rowCompact: CGFloat = 52
    static let avatarList: CGFloat = 36
    static let avatarCompact: CGFloat = 28
    static let avatarReader: CGFloat = 40
    static let readerHeaderCollapsed: CGFloat = 56
    static let field: CGFloat = 32
    static let chip: CGFloat = 24
}

extension NSColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }
}

private func dynamic(light: NSColor, dark: NSColor) -> Color {
    Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
    })
}

enum Theme {
    static let bg = dynamic(light: NSColor(hex: 0xF8F3F0), dark: NSColor(hex: 0x0E0C0B))
    static let panel = dynamic(light: NSColor(hex: 0xFFFFFF), dark: NSColor(hex: 0x161312))
    static let panel2 = dynamic(light: NSColor(hex: 0xF1EBE5), dark: NSColor(hex: 0x1D1A18))
    static let panel3 = dynamic(light: NSColor(hex: 0xE7DED5), dark: NSColor(hex: 0x262321))
    static let border = dynamic(light: NSColor(hex: 0xE7DED4), dark: NSColor(hex: 0x2B2725))
    static let border2 = dynamic(light: NSColor(hex: 0xD6CBBF), dark: NSColor(hex: 0x3A3532))
    static let text = dynamic(light: NSColor(hex: 0x050100), dark: NSColor(hex: 0xF8F3F0))
    static let text2 = dynamic(light: NSColor(hex: 0x5B5650), dark: NSColor(hex: 0xB6B1AB))
    static let text3 = dynamic(light: NSColor(hex: 0x6A655E), dark: NSColor(hex: 0x9D978F))
    static let text4 = dynamic(light: NSColor(hex: 0x8F8A83), dark: NSColor(hex: 0x7A756E))
    static let accent = Color(nsColor: NSColor(hex: 0x006900))
    static let accentHover = dynamic(light: NSColor(hex: 0x005A00), dark: NSColor(hex: 0x007A00))
    static let onAccent = Color.white
    static let accentFg = dynamic(light: NSColor(hex: 0x006900), dark: NSColor(hex: 0x1EA94E))
    static let accentSoft = dynamic(light: NSColor(hex: 0x006900, alpha: 0.08), dark: NSColor(hex: 0x1EA94E, alpha: 0.14))
    static let accentSoft2 = dynamic(light: NSColor(hex: 0x006900, alpha: 0.14), dark: NSColor(hex: 0x1EA94E, alpha: 0.22))
    static let danger = dynamic(light: NSColor(hex: 0x860000), dark: NSColor(hex: 0xA31212))
    static let dangerFg = dynamic(light: NSColor(hex: 0x860000), dark: NSColor(hex: 0xE8836F))
    static let dangerSoft = dynamic(light: NSColor(hex: 0x860000, alpha: 0.10), dark: NSColor(hex: 0xE8836F, alpha: 0.16))
    static let warn = dynamic(light: NSColor(hex: 0xB8862A), dark: NSColor(hex: 0xD9A441))
    static let warnFg = dynamic(light: NSColor(hex: 0x86600F), dark: NSColor(hex: 0xE6B85C))
    static let warnSoft = dynamic(light: NSColor(hex: 0xB8862A, alpha: 0.13), dark: NSColor(hex: 0xD9A441, alpha: 0.16))
    static let flag = dynamic(light: NSColor(hex: 0xB8862A), dark: NSColor(hex: 0xE6B85C))
    static let track = dynamic(light: NSColor(hex: 0x786E64, alpha: 0.16), dark: NSColor(hex: 0x8C8C8C, alpha: 0.16))

    static let avatarPalette: [Color] = [0x006900, 0x7A4B00, 0x00555E, 0x4A3B8F, 0x8A2B55, 0x2F5D8A, 0x5A6B00, 0x7B3F2A]
        .map { Color(nsColor: NSColor(hex: $0)) }
}

enum TextStyle {
    case caption, meta, body, bodyStrong, reader, title, display, hero

    var font: Font {
        switch self {
        case .caption: .system(size: 11, weight: .medium)
        case .meta: .system(size: 12)
        case .body: .system(size: 13)
        case .bodyStrong: .system(size: 13, weight: .semibold)
        case .reader: .system(size: 14)
        case .title: .system(size: 16, weight: .semibold)
        case .display: .system(size: 20, weight: .semibold)
        case .hero: .system(size: 24, weight: .semibold)
        }
    }
}

extension View {
    func taifa(_ style: TextStyle) -> some View { font(style.font).tracking(-0.1) }
}

extension Font {
    /// Addresses, ids and key hints.
    static func taifaMono(_ size: CGFloat = 12) -> Font { .system(size: size, design: .monospaced) }
}

enum ThemePreference: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var title: String { switch self { case .system: "System"; case .light: "Light"; case .dark: "Dark" } }
    var colorScheme: ColorScheme? { switch self { case .system: nil; case .light: .light; case .dark: .dark } }
}

enum Density: String, CaseIterable, Identifiable {
    case comfortable, compact
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var rowHeight: CGFloat { self == .comfortable ? Metrics.rowComfortable : Metrics.rowCompact }
    var avatar: CGFloat { self == .comfortable ? Metrics.avatarList : Metrics.avatarCompact }
}

/// The selection style: active background plus a very subtle border, never a heavy outline.
struct SelectionBackground: View {
    var selected: Bool
    var focused: Bool = true
    var hovering: Bool = false
    var body: some View {
        RoundedRectangle(cornerRadius: Radius.ctl, style: .continuous)
            .fill(selected ? (focused ? Theme.accentSoft2 : Theme.accentSoft) : (hovering ? Theme.panel2 : Color.clear))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.ctl, style: .continuous)
                    .strokeBorder(Theme.border2.opacity(selected ? 0.6 : 0), lineWidth: 1)
            )
    }
}
