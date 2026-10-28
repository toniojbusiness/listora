import SwiftUI

/// Content on a tag that hangs by a short string from a rail, like an item on a shop's rail: card
/// stock with the pointed end up, the eyelet punched through, and a stitched edge. A grid of them
/// with `railOverhang` set to half the grid's spacing reads as one rail per row. For the item
/// photos of Inventory; the text about the item stays on the page under the tag.
public struct HangingTag<Content: View>: View {
    private let railOverhang: CGFloat?
    private let content: Content
    @Environment(\.colorScheme) private var colorScheme

    /// How far the string drops from the rail to the tag's eyelet.
    public static var drop: CGFloat {
        14
    }

    private static var chamfer: CGFloat {
        18
    }

    /// `railOverhang` runs the rail that far past each side of the tag (nil draws no rail).
    public init(railOverhang: CGFloat? = 0, @ViewBuilder content: () -> Content) {
        self.railOverhang = railOverhang
        self.content = content()
    }

    public var body: some View {
        let shape = TagShape(end: .top, chamfer: Self.chamfer, cornerRadius: Radius.medium)
        let eyelet = TagMetrics.eyeletInset + 2
        content
            .padding(.top, eyelet + TagMetrics.eyeletRingRadius + Spacing.xxs)
            .padding([.horizontal, .bottom], Spacing.xs)
            .background(Palette.surface, in: shape)
            .overlay {
                if colorScheme == .dark {
                    shape.stroke(Palette.separator.color.opacity(0.7), lineWidth: 1)
                }
            }
            .stitchedEdge(TagShape(end: .top, chamfer: Self.chamfer, cornerRadius: Radius.medium, punchesEyelet: false))
            .overlay(alignment: .top) {
                ZStack(alignment: .top) {
                    ThreadSegment()
                        .stroke(Palette.thread, style: Thread.stroke(.taut))
                        .frame(width: Thread.width, height: Self.drop + eyelet - TagMetrics.eyeletHoleRadius)
                        .offset(y: -Self.drop)
                    EyeletRing()
                        .offset(y: eyelet - TagMetrics.eyeletRingRadius)
                }
                .accessibilityHidden(true)
            }
            .elevation(.low)
            .padding(.top, Self.drop)
            .background(alignment: .top) {
                if let railOverhang {
                    Capsule()
                        .fill(Palette.rail)
                        .frame(height: 2.5)
                        .padding(.horizontal, -railOverhang)
                        .accessibilityHidden(true)
                }
            }
    }
}

#Preview {
    HStack(alignment: .top, spacing: Spacing.md) {
        ForEach(0 ..< 2, id: \.self) { _ in
            HangingTag(railOverhang: Spacing.md / 2) {
                Palette.info.color.aspectRatio(1, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            }
        }
    }
    .padding()
    .background(Palette.background)
}
