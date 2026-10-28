import SwiftUI
import Testing
import UIKit
@testable import DesignSystem

/// The Hang Tag pieces: the tag's outline and eyelet, the string and its beads, the stamp, the
/// tab rail, and the display face, laid out as UIKit would on the smallest and largest iPhones,
/// at the default and the largest text size, in both modes.
@MainActor
struct HangTagTests {
    /// The iPhone 17e and the iPhone 17 Pro Max, in points.
    private static let widths: [CGFloat] = [375, 440]
    private static let sizes: [DynamicTypeSize] = [.large, .accessibility5]
    private static let schemes: [ColorScheme] = [.light, .dark]

    private func size(
        of view: some View,
        width: CGFloat,
        typeSize: DynamicTypeSize,
        scheme: ColorScheme = .light,
    ) -> CGSize {
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

    // MARK: The tag

    @Test(arguments: [TagShape.End.leading, .top])
    func `a tag has its eyelet punched through, so the string shows through the hole`(end: TagShape.End) {
        let rect = CGRect(x: 0, y: 0, width: 300, height: 140)
        let eyelet = TagMetrics.eyeletCenter(in: rect, end: end)
        let punched = TagShape(end: end).path(in: rect)
        let whole = TagShape(end: end, punchesEyelet: false).path(in: rect)
        #expect(!punched.fills(eyelet), "the hole is open")
        #expect(whole.fills(eyelet))
        // Just outside the hole is card stock.
        let beside = CGPoint(
            x: eyelet.x + TagMetrics.eyeletRingRadius + 2,
            y: eyelet.y + TagMetrics.eyeletRingRadius + 2,
        )
        #expect(punched.fills(beside))
        #expect(punched.fills(CGPoint(x: rect.midX, y: rect.midY)))
    }

    @Test
    func `a tag on its side is pointed on the leading end, with square far corners`() {
        let rect = CGRect(x: 0, y: 0, width: 300, height: 140)
        let tag = TagShape(end: .leading).path(in: rect)
        #expect(!tag.fills(CGPoint(x: 3, y: 3)), "the top of the pointed end is cut")
        #expect(!tag.fills(CGPoint(x: 3, y: rect.maxY - 3)), "the bottom of the pointed end is cut")
        #expect(tag.fills(CGPoint(x: 2, y: rect.midY + 20)), "the point's flat end is card")
        #expect(tag.fills(CGPoint(x: rect.maxX - 8, y: rect.minY + 8)))
    }

    @Test
    func `a hanging tag is pointed at the top`() {
        let rect = CGRect(x: 0, y: 0, width: 120, height: 160)
        let tag = TagShape(end: .top).path(in: rect)
        #expect(!tag.fills(CGPoint(x: 3, y: 3)))
        #expect(!tag.fills(CGPoint(x: rect.maxX - 3, y: 3)))
        #expect(tag.fills(CGPoint(x: rect.midX, y: 2)))
        #expect(tag.fills(CGPoint(x: 8, y: rect.maxY - 8)))
    }

    @Test(arguments: [TagShape.End.leading, .top])
    func `the stitched line runs just inside the tag's edge`(end: TagShape.End) {
        let rect = CGRect(x: 0, y: 0, width: 300, height: 140)
        let outline = TagShape(end: end, punchesEyelet: false).path(in: rect)
        let stitch = TagShape(end: end, punchesEyelet: false).inset(by: 5).path(in: rect)
        #expect(rect.insetBy(dx: 4.9, dy: 4.9).contains(stitch.boundingRect))
        // Every point of the stitch is on the card.
        for fraction in stride(from: 0.05, through: 1.0, by: 0.05) {
            let point = stitch.trimmedPath(from: 0, to: fraction).currentPoint ?? .zero
            #expect(outline.fills(point), "\(point) at \(fraction) is off the tag")
        }
    }

    @Test
    func `a tag card fits the screen at every size and keeps its text clear of the pointed end`() {
        everyVariant { width, typeSize, scheme in
            let card = Text("Patagonia Better Sweater sold on eBay, and Listora is ending it everywhere else")
                .tagStyle()
            let measured = size(of: card, width: width, typeSize: typeSize, scheme: scheme)
            #expect(measured.width <= width, "\(typeSize) at \(width): \(measured)")
            #expect(measured.height >= Layout.minimumTapTarget)
        }
    }

    // MARK: The string

    @Test
    func `a row's place on the string decides where the string runs`() {
        #expect(ThreadPosition.at(0, of: 1) == .only)
        #expect(ThreadPosition.at(0, of: 4) == .first)
        #expect(ThreadPosition.at(2, of: 4) == .middle)
        #expect(ThreadPosition.at(3, of: 4) == .last)
        #expect(!ThreadPosition.first.continuesAbove && ThreadPosition.first.continuesBelow)
        #expect(ThreadPosition.middle.continuesAbove && ThreadPosition.middle.continuesBelow)
        #expect(ThreadPosition.last.continuesAbove && !ThreadPosition.last.continuesBelow)
        #expect(!ThreadPosition.only.continuesAbove && !ThreadPosition.only.continuesBelow)
    }

    @Test
    func `a string segment draws only as much as it is drawn`() {
        let rect = CGRect(x: 0, y: 0, width: 2, height: 100)
        #expect(ThreadSegment(drawn: 1).path(in: rect).boundingRect.height == 100)
        #expect(ThreadSegment(drawn: 0.25).path(in: rect).boundingRect.height == 25)
        #expect(ThreadSegment(axis: .horizontal, drawn: 0.5).path(in: CGRect(x: 0, y: 0, width: 80, height: 2))
            .boundingRect.width == 40)
    }

    @Test(arguments: StatusTone.allCases)
    func `a bead grows a little with the text, never so much the string breaks up`(tone: StatusTone) {
        for typeSize in Self.sizes {
            let bead = size(of: ThreadBead(monogram: "P", tone: tone), width: 390, typeSize: typeSize)
            #expect(bead.width >= ThreadBead.side)
            #expect(bead.width <= ThreadBead.side * 1.4 + 0.5, "\(typeSize): \(bead)")
        }
    }

    @Test
    func `a threaded row wraps its status in full at every size`() {
        everyVariant { width, typeSize, scheme in
            let row = ThreadRow(position: .middle) {
                ThreadBead(monogram: "P", tone: .inProgress)
            } content: {
                StatusLabel("Listing on Poshmark, step 5 of 9: choose the size and condition", tone: .inProgress)
            }
            let measured = size(of: row, width: width, typeSize: typeSize, scheme: scheme)
            #expect(measured.width <= width, "\(typeSize) at \(width): \(measured)")
        }
    }

    @Test
    func `a tied string runs solid from the top down, and a cut one opens a gap in the middle`() {
        let rect = CGRect(x: 0, y: 0, width: 16, height: 100)
        #expect(SnippedString(tied: 1, cut: 0).path(in: rect).boundingRect.height == 100)
        #expect(SnippedString(tied: 0.4, cut: 0).path(in: rect).boundingRect.maxY == 40, "tying from the top")
        #expect(SnippedString(tied: 0, cut: 0).path(in: rect).isEmpty, "loose: nothing solid yet")
        let cut = SnippedString(tied: 1, cut: 1).path(in: rect)
        #expect(cut.boundingRect.height == 100, "both ends stay tied on")
        #expect(!cut.cgPath.contains(CGPoint(x: 8, y: 50)))
        let middle = cut.cgPath.copy(strokingWithWidth: Thread.width, lineCap: .butt, lineJoin: .miter, miterLimit: 1)
        #expect(!middle.contains(CGPoint(x: 8, y: 50)), "the middle is snipped")
        #expect(middle.contains(CGPoint(x: 8, y: 20)) && middle.contains(CGPoint(x: 8, y: 80)))
    }

    @Test
    func `the sold stamp fits on the item's tag at every size`() {
        everyVariant { width, typeSize, scheme in
            let stamp = SoldStamp(price: "$1,250.00", marketplace: "Poshmark", lands: false)
            let measured = size(of: stamp, width: width, typeSize: typeSize, scheme: scheme)
            #expect(measured.width <= width - 2 * Spacing.md, "\(typeSize) at \(width): \(measured)")
        }
    }

    // MARK: Stamps and labels

    @Test
    func `a stamp shows its whole word and grows with the text`() {
        let small = size(of: Stamp("Urgent"), width: 390, typeSize: .large)
        let large = size(of: Stamp("Urgent"), width: 390, typeSize: .accessibility5)
        #expect(large.height > small.height)
        let long = size(of: Stamp("Ship by tomorrow morning at the latest"), width: 200, typeSize: .accessibility5)
        #expect(long.width <= 200, "a long stamp wraps instead of overflowing: \(long)")
    }

    @Test(arguments: StatusTone.allCases)
    func `a stamped mark grows a little with the text, as big as a card's photo by default`(tone: StatusTone) {
        let regular = size(of: StampMark(systemImage: "link", tone: tone), width: 390, typeSize: .large)
        let largest = size(of: StampMark(systemImage: "link", tone: tone), width: 390, typeSize: .accessibility5)
        #expect(regular == CGSize(width: StampMark.side, height: StampMark.side))
        #expect(largest.width > regular.width && largest.width <= StampMark.side * 1.4 + 0.5)
    }

    @Test
    func `an icon tile is a soft tile in rows and a stamp on cards`() {
        let row = size(of: IconTile(systemImage: "link"), width: 390, typeSize: .large)
        let card = size(of: IconTile(systemImage: "link", size: .card), width: 390, typeSize: .large)
        let hero = size(of: IconTile(systemImage: "link", size: .hero), width: 390, typeSize: .accessibility5)
        #expect(row == CGSize(width: 36, height: 36))
        #expect(card == CGSize(width: 48, height: 48))
        #expect(hero == CGSize(width: 96, height: 96), "the hero mark keeps its size, so the action stays on screen")
    }

    @Test
    func `an item's hanging tag fits its grid cell, its photo inside the card stock`() {
        everyVariant { width, typeSize, scheme in
            let cell = (width - 3 * Spacing.md) / 2
            let tag = HangingTag(railOverhang: Spacing.md / 2) {
                Color.clear.aspectRatio(1, contentMode: .fit)
            }
            .frame(width: cell)
            let measured = size(of: tag, width: width, typeSize: typeSize, scheme: scheme)
            #expect(abs(measured.width - cell) < 0.5, "\(measured) for \(cell)")
            // The photo, the eyelet's band above it, the margins, and the string's drop.
            #expect(measured.height > cell + HangingTag<EmptyView>.drop, "\(measured) for \(cell)")
        }
    }

    // MARK: The tab rail

    private func rail(selection: Int = 0) -> some View {
        TabRail([
            TabRailItem(id: 0, title: "Today", systemImage: "sun.max"),
            TabRailItem(id: 1, title: "Inventory", systemImage: "hanger", badge: 12),
            TabRailItem(id: 2, title: "Add", systemImage: "camera", isTag: true),
            TabRailItem(id: 3, title: "Tasks", systemImage: "checklist", badge: 1),
            TabRailItem(id: 4, title: "Sales", systemImage: "dollarsign.circle"),
        ], selection: .constant(selection))
    }

    @Test
    func `the tab rail fits the smallest iPhone at every text size, every tab a full tap target`() {
        everyVariant { width, typeSize, scheme in
            let measured = size(of: rail(), width: width, typeSize: typeSize, scheme: scheme)
            #expect(measured.width <= width, "\(typeSize) at \(width): \(measured)")
            #expect(measured.height >= 49, "\(typeSize) at \(width): \(measured)")
        }
    }

    @Test
    func `the tab rail's labels stop growing like the system tab bar's`() {
        let regular = size(of: rail(), width: 390, typeSize: .xLarge)
        let largest = size(of: rail(), width: 390, typeSize: .accessibility5)
        #expect(regular.height == largest.height)
    }

    @Test
    func `a screen hides the rail only while it shows`() {
        let visibility = TabRailVisibility()
        let flow = UUID(), selecting = UUID()
        #expect(!visibility.isHidden)
        visibility.set(flow, hidden: true)
        visibility.set(selecting, hidden: true)
        visibility.set(flow, hidden: false)
        #expect(visibility.isHidden, "one screen still wants it hidden")
        visibility.set(selecting, hidden: false)
        #expect(!visibility.isHidden)
    }

    // MARK: The display face

    @Test
    func `headings, prices, and large navigation titles are set in Fraunces, scaled with the text size`() throws {
        #expect(BrandFont.isRegistered)
        let base = try #require(UIFont(name: BrandFont.postScriptName, size: 34))
        #expect(base.familyName.contains("Fraunces"))
        BrandAppearance.apply()
        let attributes = UINavigationBar.appearance().largeTitleTextAttributes ?? [:]
        let font = try #require(attributes[.font] as? UIFont)
        #expect(font.fontName == BrandFont.postScriptName)
        let large = UIFontMetrics(forTextStyle: .largeTitle)
            .scaledFont(
                for: base,
                compatibleWith: UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge),
            )
        #expect(large.pointSize > base.pointSize)
    }

    @Test
    func `a price in the display face grows with Dynamic Type`() {
        let price = Text("$120.00").font(Typography.price)
        #expect(size(of: price, width: 390, typeSize: .accessibility5).height > size(
            of: price,
            width: 390,
            typeSize: .large,
        ).height)
        let heading = Text("No sales yet").font(Typography.title)
        #expect(size(of: heading, width: 390, typeSize: .accessibility5).height > size(
            of: heading,
            width: 390,
            typeSize: .large,
        ).height)
    }
}

extension Path {
    /// Whether filling the path (nonzero, as SwiftUI and Core Graphics fill shapes) paints `point`.
    /// Core Graphics answers this; `Path.contains` misreads holes cut by `subtracting`.
    fileprivate func fills(_ point: CGPoint) -> Bool {
        cgPath.contains(point, using: .winding)
    }
}
