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

/// Colour tokens mapped one to one from frontend/src/lib/styles/tokens.css (webmail contract).
/// Token names in comments are the CSS custom properties.
enum Theme {
    static let bg = dynamic(light: NSColor(hex: 0xF5F8F6), dark: NSColor(hex: 0x101010))                // --color-bg
    static let panel = dynamic(light: NSColor(hex: 0xFFFFFF), dark: NSColor(hex: 0x161616))             // --color-surface
    static let sidebar = dynamic(light: NSColor(hex: 0xFFFFFF), dark: NSColor(hex: 0x141414))           // --color-sidebar
    static let panel2 = dynamic(light: NSColor(hex: 0xEDF3EF), dark: NSColor(hex: 0x242424))            // --color-surface-2
    static let surfaceSelected = dynamic(light: NSColor(hex: 0xE3F0E8), dark: NSColor(hex: 0x1D2E24))   // --color-surface-selected
    static let border = dynamic(light: NSColor(hex: 0xDCE5DF), dark: NSColor(hex: 0x2E2E2E))            // --color-border-1
    static let border2 = dynamic(light: NSColor(hex: 0xC3D0C8), dark: NSColor(hex: 0x3D3D3D))           // --color-border-2
    static let borderSoft = dynamic(light: NSColor(hex: 0xE8EEEA), dark: NSColor(hex: 0x222222))        // --color-border-soft
    static let panel3 = border                                                                          // pressed, chips
    static let text = dynamic(light: NSColor(hex: 0x000000), dark: NSColor(hex: 0xECECEC))              // --color-text
    static let text2 = dynamic(light: NSColor(hex: 0x52665E), dark: NSColor(hex: 0xA8A8A8))             // --color-muted
    static let text3 = dynamic(light: NSColor(hex: 0x5C6F67), dark: NSColor(hex: 0x949494))             // --color-muted-soft
    static let text4 = dynamic(light: NSColor(hex: 0x8DA096), dark: NSColor(hex: 0x8A8A8A))             // --color-neutral-dot
    static let accent = dynamic(light: NSColor(hex: 0x00864E), dark: NSColor(hex: 0x16803C))            // --color-accent-fill
    static let accentHover = dynamic(light: NSColor(hex: 0x007343), dark: NSColor(hex: 0x1A8F44))       // --color-accent-fill-hover
    static let onAccent = Color.white                                                                   // --color-on-accent
    static let accentDot = dynamic(light: NSColor(hex: 0x008C51), dark: NSColor(hex: 0x1EA94E))         // --color-accent
    static let accentFg = dynamic(light: NSColor(hex: 0x00643A), dark: NSColor(hex: 0x8ADBAA))          // --color-accent-ink (text)
    static let accentSoft = dynamic(light: NSColor(hex: 0xE6F4EE), dark: NSColor(hex: 0x1EA94E, alpha: 0.14)) // --color-accent-soft
    static let accentSoft2 = accentSoft
    static let danger = dynamic(light: NSColor(hex: 0x922529), dark: NSColor(hex: 0xFF7A5E))            // --color-danger
    static let dangerFg = dynamic(light: NSColor(hex: 0x741D20), dark: NSColor(hex: 0xFFA892))          // --color-danger-ink
    static let dangerSoft = dynamic(light: NSColor(hex: 0xF8E4E2), dark: NSColor(hex: 0xD63F28, alpha: 0.18)) // --color-danger-soft
    static let warn = dynamic(light: NSColor(hex: 0x8A6400), dark: NSColor(hex: 0xE0B22E))              // --color-warn
    static let warnFg = dynamic(light: NSColor(hex: 0x6B4E00), dark: NSColor(hex: 0xF0D27A))            // --color-warn-ink
    static let warnSoft = dynamic(light: NSColor(hex: 0xFAF3D9), dark: NSColor(hex: 0xD9A514, alpha: 0.14)) // --color-warn-soft
    static let info = dynamic(light: NSColor(hex: 0x254DA8), dark: NSColor(hex: 0x8FB0F5))              // --color-info
    static let infoSoft = dynamic(light: NSColor(hex: 0xE5ECFB), dark: NSColor(hex: 0x7AA3F3, alpha: 0.14)) // --color-info-soft
    static let flag = warn
    static let track = dynamic(light: NSColor(hex: 0xE6ECE8), dark: NSColor(hex: 0x1A1A1A))             // --skeleton-base

    /// Deterministic placeholder colours behind the person silhouette (same in light and dark).
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
        RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
            .fill(selected ? (focused ? Theme.surfaceSelected : Theme.accentSoft) : (hovering ? Theme.panel2 : Color.clear))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .strokeBorder(Theme.border.opacity(selected ? 0.9 : 0), lineWidth: 1)
            )
    }
}
