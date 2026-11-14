import SwiftUI

/// Person photo as a circle, institution logo as a contained rounded tile of the same size,
/// otherwise a placeholder with a deterministic colour (DESIGN_SPEC section 7).
struct AvatarView: View {
    let name: String
    let address: String
    let picture: SenderPicture
    var size: CGFloat = Metrics.avatarList

    @State private var image: NSImage?

    var body: some View {
        ZStack {
            switch (picture.kind, image) {
            case (.photo, let img?):
                Image(nsImage: img).resizable().scaledToFill().frame(width: size, height: size).clipShape(Circle())
            case (.logo, let img?):
                RoundedRectangle(cornerRadius: max(6, size * 0.25), style: .continuous)
                    .fill(Theme.panel2)
                    .overlay(Image(nsImage: img).resizable().scaledToFit().padding(size * 0.12))
                    .clipShape(RoundedRectangle(cornerRadius: max(6, size * 0.25), style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: max(6, size * 0.25), style: .continuous).strokeBorder(Theme.border, lineWidth: 1))
            default:
                Circle().fill(Theme.avatarPalette[AvatarDecision.colorIndex(for: address)])
                    .overlay(Text(AvatarDecision.initial(name: name, address: address))
                        .font(.system(size: size * 0.42, weight: .semibold)).foregroundStyle(.white))
            }
        }
        .frame(width: size, height: size)
        .task(id: picture.url) {
            guard picture.kind != .none, let url = picture.url else { image = nil; return }
            let px = Int(size * 2)
            if let c = ImageLoader.shared.cached(url, maxPixel: px) { image = c; return }
            image = await ImageLoader.shared.load(url, maxPixel: px)
        }
        .accessibilityLabel(picture.label ?? name)
    }
}
