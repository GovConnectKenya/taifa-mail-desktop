import SwiftUI

/// A static skeleton bar with a slow pulse.
struct SkeletonBar: View {
    var width: CGFloat? = nil
    var height: CGFloat = 10
    @State private var dim = false
    var body: some View {
        RoundedRectangle(cornerRadius: Radius.xs, style: .continuous)
            .fill(Theme.track)
            .frame(width: width, height: height)
            .opacity(dim ? 0.55 : 1)
            .onAppear { withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) { dim = true } }
    }
}

enum BannerKind { case info, warn, danger }

struct Banner: View {
    var kind: BannerKind
    var icon: Icon.Name
    var message: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    private var tint: Color { kind == .danger ? Theme.dangerFg : kind == .warn ? Theme.warnFg : Theme.text2 }
    private var fill: Color { kind == .danger ? Theme.dangerSoft : kind == .warn ? Theme.warnSoft : Theme.panel2 }

    var body: some View {
        HStack(spacing: Space.s2) {
            Icon(icon, size: 16).foregroundStyle(tint)
            Text(message).taifa(.body).foregroundStyle(Theme.text).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
            if let actionTitle, let action { Button(actionTitle, action: action).buttonStyle(.link).taifa(.body) }
        }
        .padding(.horizontal, Space.s3).padding(.vertical, Space.s2)
        .background(fill, in: RoundedRectangle(cornerRadius: Radius.ctl, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

struct EmptyState: View {
    var icon: Icon.Name
    var title: String
    var hint: String
    var body: some View {
        VStack(spacing: Space.s3) {
            BrandLogo(height: 40).opacity(0.9)
            Text(title).taifa(.display).foregroundStyle(Theme.text)
            Text(hint).taifa(.body).foregroundStyle(Theme.text3).multilineTextAlignment(.center)
        }
        .padding(Space.s8)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    var full = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .taifa(.bodyStrong)
            .foregroundStyle(Theme.onAccent)
            .padding(.horizontal, Space.s4)
            .frame(maxWidth: full ? .infinity : nil, minHeight: 36)
            .background(configuration.isPressed ? Theme.accentHover : Theme.accent, in: RoundedRectangle(cornerRadius: Radius.ctl, style: .continuous))
            .opacity(1)
    }
}

struct QuietButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .taifa(.body)
            .foregroundStyle(Theme.accentFg)
            .padding(.horizontal, Space.s2).padding(.vertical, Space.s1)
            .background(configuration.isPressed ? Theme.panel3 : Color.clear, in: RoundedRectangle(cornerRadius: Radius.ctl, style: .continuous))
    }
}

struct FieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .textFieldStyle(.plain)
            .taifa(.body)
            .padding(.horizontal, Space.s3)
            .frame(height: Metrics.field)
            .background(Theme.panel2, in: RoundedRectangle(cornerRadius: Radius.ctl, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.ctl, style: .continuous).strokeBorder(Theme.border2, lineWidth: 1))
    }
}


/// The real Taifa Mail logo (webmail/static/logos), white variant on dark surfaces via the asset catalog.
struct BrandLogo: View {
    var height: CGFloat = 24
    var body: some View {
        Image("TaifaLogo").resizable().scaledToFit().frame(height: height)
            .accessibilityLabel("Taifa Mail")
            .accessibilityIdentifier("brand-logo")
    }
}
