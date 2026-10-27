import CoreText
import Foundation
import SwiftUI
import Testing
@testable import DesignSystem

struct BrandTests {
    static let brandDirectory = URL(filePath: #filePath)
        .deletingLastPathComponent() // DesignSystemTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // DesignSystem
        .deletingLastPathComponent() // Packages
        .deletingLastPathComponent() // ios
        .appending(path: "Brand")

    static let sources = ["looptag-mark.svg", "app-icon-light.svg", "app-icon-dark.svg", "app-icon-tinted.svg"]

    @Test(arguments: sources)
    func `the SVG sources draw the same mark as the app`(_ file: String) throws {
        let svg = try String(contentsOf: Self.brandDirectory.appending(path: file), encoding: .utf8)
        #expect(svg.contains("d=\"\(Looptag.stringData)\""))
        #expect(svg.contains("stroke-width=\"9.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\""))
        #expect(svg.contains("d=\"\(Looptag.tagData)\""))
        #expect(svg.contains("transform=\"translate(55 68) rotate(50)\""))
        #expect(svg.contains("stroke-width=\"5\" stroke-linejoin=\"round\""))
        #expect(svg.contains("<circle cx=\"9.5\" cy=\"0\" r=\"4.3\""))
        #expect(Looptag.tagOrigin == CGPoint(x: 55, y: 68))
        #expect(Looptag.tagAngle == 50 && Looptag.stringWidth == 9.5 && Looptag.tagOutlineWidth == 5)
        #expect(Looptag.holeCenter == CGPoint(x: 9.5, y: 0) && Looptag.holeRadius == 4.3)
    }

    @Test
    func `the SVG path reader follows every command the mark uses`() {
        let string = SVGPath.parse(Looptag.stringData)
        // From (10, 66) through four curves to (57, 73); the loop reaches up to about y = 4.
        #expect(string.currentPoint == CGPoint(x: 57, y: 73))
        #expect(abs(string.boundingRect.minY - 4) < 1)
        let tag = SVGPath.parse(Looptag.tagData)
        #expect(tag.boundingRect.integral == CGRect(x: 0, y: -13, width: 42, height: 26))
        #expect(SVGPath.tokenize("M0 -1.5 L2-3Z") == [
            .command("M"), .number(0), .number(-1.5), .command("L"), .number(2), .number(-3), .command("Z"),
        ])
    }

    @Test
    func `the tag has the string's hole punched through it`() {
        let tag = Looptag.markTag
        // The hole's center, turned into the box, is not filled; a point in the tag's body is.
        let turn = CGAffineTransform(translationX: 55, y: 68).rotated(by: 50 * .pi / 180)
        #expect(!tag.contains(Looptag.holeCenter.applying(turn)))
        #expect(tag.contains(CGPoint(x: 28, y: 0).applying(turn)))
        // The mark sits about its box, as in the concept's renders (the icon leaves room): the
        // loop's round top a little above the top edge, the tag's far corner below the bottom.
        let string = Looptag.stroke().boundingRect
        #expect(string.minX >= 0 && string.minY > -2 && string.maxX <= 100 && string.maxY <= 100)
        #expect(tag.boundingRect.maxX <= 100 && tag.boundingRect.maxY <= 111)
    }

    @Test
    func `the wordmark font is bundled with its license and registered`() throws {
        #expect(BrandFont.isRegistered)
        let font = BrandFont.font(size: 20)
        #expect(CTFontCopyPostScriptName(font) as String == BrandFont.postScriptName)
        #expect((CTFontCopyFamilyName(font) as String).hasPrefix("Fraunces"))
        let license = try #require(BrandFont.licenseURL)
        let text = try String(contentsOf: license, encoding: .utf8)
        #expect(text.contains("SIL Open Font License"))
        #expect(text.contains("Fraunces Project Authors"))
    }

    @Test(arguments: [24.0, 48.0, 96.0])
    func `the wordmark's l is the mark, with the tag below the baseline and the letters after it`(size: Double) {
        let layout = WordmarkLayout(size: size)
        // The tag hangs below the baseline (y = 0) like a descender; the loop rises above it.
        #expect(layout.tag.boundingRect.maxY > 0.1 * size)
        #expect(layout.letters.boundingRect.minY < -0.7 * size)
        // The l's exit stroke runs up to the i, ending within 0.05 em of where the i starts (the
        // concept's join), and the word is about 2.9 em wide.
        #expect(abs(layout.secondLetterX - layout.stringBounds.maxX) < 0.05 * size)
        #expect(layout.bounds.width > 2.5 * size && layout.bounds.width < 3.3 * size)
        // Scaling the size scales the drawing.
        let double = WordmarkLayout(size: size * 2)
        #expect(abs(double.bounds.width - 2 * layout.bounds.width) < 0.5)
    }

    @Test
    func `the spinner draws the l, lands the tag, then lifts the string off`() {
        let cycle = BrandSpinner.cycle
        #expect(BrandSpinner.frame(at: 0) == .init(start: 0, end: 0, tagOpacity: 0, tagDrop: 0))
        let halfway = BrandSpinner.frame(at: cycle * BrandSpinner.drawn / 2)
        #expect(abs(halfway.end - 0.5) < 0.0001 && halfway.tagOpacity == 0)
        // Drawn: the tag starts to land from above, then sits in place.
        let landing = BrandSpinner.frame(at: cycle * (BrandSpinner.drawn + 0.0001))
        #expect(landing.end == 1 && landing.tagOpacity < 0.1 && landing.tagDrop < -7)
        let landed = BrandSpinner.frame(at: cycle * (BrandSpinner.drawn + BrandSpinner.landing + 0.01))
        #expect(landed == .still)
        // Lifting off: the string goes from its start, the tag fades.
        let lifting = BrandSpinner.frame(at: cycle * (BrandSpinner.liftOff + 1) / 2)
        #expect(abs(lifting.start - 0.5) < 0.0001 && lifting.end == 1 && abs(lifting.tagOpacity - 0.5) < 0.0001)
        // It repeats, and every frame stays in range.
        let later = BrandSpinner.frame(at: cycle * 7.3), first = BrandSpinner.frame(at: cycle * 0.3)
        #expect(abs(later.end - first.end) < 0.0001 && later.tagOpacity == first.tagOpacity)
        for step in 0 ..< 200 {
            let frame = BrandSpinner.frame(at: Double(step) * 0.013)
            #expect(frame.start >= 0 && frame.start <= frame.end && frame.end <= 1)
            #expect(frame.tagOpacity >= 0 && frame.tagOpacity <= 1)
        }
    }

    @Test
    func `the spinner follows the control size`() {
        #expect(BrandSpinner.side(for: .mini) < BrandSpinner.side(for: .small))
        #expect(BrandSpinner.side(for: .small) < BrandSpinner.side(for: .regular))
        #expect(BrandSpinner.side(for: .regular) < BrandSpinner.side(for: .large))
    }

    @MainActor
    @Test
    func `the spinner's layer animations repeat the cycle from the same frames`() {
        let animation = SpinnerView.animation("strokeEnd", duration: BrandSpinner.cycle) {
            Double(BrandSpinner.frame(at: $0 * BrandSpinner.cycle).end)
        }
        #expect(animation.repeatCount == .infinity && animation.duration == BrandSpinner.cycle)
        let values = (animation.values as? [NSNumber])?.map(\.doubleValue) ?? []
        #expect(values.count == SpinnerView.keyframes + 1 && animation.keyTimes?.count == values.count)
        #expect(values.first == 0 && values.max() == 1)
        // Drawn by just past halfway through the cycle, and still whole at the end (it lifts off
        // from the start instead).
        #expect(values[SpinnerView.keyframes * 6 / 10] == 1 && values.last == 1)
    }
}
