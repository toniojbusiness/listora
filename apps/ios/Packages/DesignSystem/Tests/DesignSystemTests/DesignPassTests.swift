import SwiftUI
import Testing
import UIKit
@testable import DesignSystem

/// The empty-state art, the skeletons, the celebration, and the type scale of the design pass,
/// laid out as UIKit would on the smallest and largest iPhones, at the default and the largest
/// text size, in both modes.
@MainActor
struct DesignPassTests {
    /// The iPhone 17e and the iPhone 17 Pro Max, in points.
    private static let widths: [CGFloat] = [375, 440]
    private static let sizes: [DynamicTypeSize] = [.large, .accessibility5]
    private static let schemes: [ColorScheme] = [.light, .dark]

    private func size(of view: some View, width: CGFloat, typeSize: DynamicTypeSize, scheme: ColorScheme) -> CGSize {
        let host = UIHostingController(rootView: view
            .environment(\.dynamicTypeSize, typeSize)
            .environment(\.colorScheme, scheme))
        return host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
    }

    private func everyVariant(_ check: (CGFloat, DynamicTypeSize, ColorScheme) -> Void) {
        for width in Self.widths {
            for typeSize in Self.sizes {
                for scheme in Self.schemes {
                    check(width, typeSize, scheme)
                }
            }
        }
    }

    @Test
    func `the empty-state art keeps its size whatever the text size, so the action stays on screen`() {
        everyVariant { width, typeSize, scheme in
            let art = SpotIllustration(systemImage: "shippingbox")
            let measured = size(of: art, width: width, typeSize: typeSize, scheme: scheme)
            #expect(measured == CGSize(width: SpotIllustration.side, height: SpotIllustration.side), "\(measured)")
        }
    }

    @Test
    func `an empty state fits the screen's width at every size, with its one action`() {
        everyVariant { width, typeSize, scheme in
            let empty = EmptyStateView(
                systemImage: "shippingbox",
                title: "No items yet",
                message: "Create an item once, and see where it's listed and what sold on every marketplace.",
                steps: [
                    "Take photos of the item",
                    "Check the details Listora suggests",
                    "List it on your marketplaces",
                ],
                action: .init("Add item", systemImage: "camera.fill") {},
            )
            .frame(height: 2000)
            let measured = size(of: empty, width: width, typeSize: typeSize, scheme: scheme)
            #expect(measured.width <= width, "\(typeSize) at \(width): \(measured)")
        }
    }

    @Test
    func `a signed-out empty state offers sign-in only where the app does`() {
        var opened = 0
        let action = SignInAction { opened += 1 }
        #expect(EmptyStateView.Action.signIn(nil) == nil)
        let signIn = EmptyStateView.Action.signIn(action)
        #expect(signIn?.title == "Sign in")
        signIn?.handler()
        #expect(opened == 1)
    }

    @Test
    func `a photo grid's loading tile is square on top, like the cell it stands in for`() {
        everyVariant { width, typeSize, scheme in
            let cell = (width - 3 * Spacing.md) / 2
            let tile = SkeletonPhotoTile().frame(width: cell)
            let measured = size(of: tile, width: width, typeSize: typeSize, scheme: scheme)
            #expect(abs(measured.width - cell) < 0.5, "\(measured) for \(cell)")
            #expect(measured.height > cell, "the photo square plus two lines: \(measured)")
        }
    }

    @Test
    func `confetti pieces are the same every time and fly up and out`() {
        let first = ConfettiBurst.Piece.make(count: 36)
        let second = ConfettiBurst.Piece.make(count: 36)
        #expect(first.map(\.velocity) == second.map(\.velocity))
        #expect(first.allSatisfy { $0.velocity.dy < 0 }, "every piece is thrown upward first")
        #expect(first.contains { $0.velocity.dx < 0 } && first.contains { $0.velocity.dx > 0 })
    }

    @Test
    func `cards in light mode have no border, only in dark mode a faint one`() {
        for kind in [CardKind.elevated, .flat] {
            #expect(CardModifier.hasBorder(kind, in: .light) == false)
            #expect(CardModifier.hasBorder(kind, in: .dark))
        }
        #expect(CardModifier.hasBorder(.tinted(.failed), in: .light))
    }
}
