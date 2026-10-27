import CoreText
import SwiftUI

/// The Listora wordmark: "listora" in the brand font (Fraunces, `BrandFont`), where the l is the
/// Looptag mark itself, its string drawn at the font's stem weight with the clay tag hanging below
/// the baseline like a descender. For the welcome and sign-in screens and the first-run welcome.
/// VoiceOver reads it as "Listora".
public struct Wordmark: View {
    private let layout: WordmarkLayout

    /// `size` is the font size in points; the drawing is about 0.85 x `size` tall and 2.9 x wide.
    public init(size: CGFloat = 48) {
        layout = WordmarkLayout(size: size)
    }

    public var body: some View {
        Canvas { context, _ in
            context.translateBy(x: -layout.bounds.minX, y: -layout.bounds.minY)
            // The tag first: the string ties on over it, through the hole.
            context.fill(layout.tag, with: .style(Palette.brand))
            context.fill(layout.letters, with: .style(Palette.textPrimary))
        }
        .frame(width: layout.bounds.width, height: layout.bounds.height)
        .accessibilityElement()
        .accessibilityLabel("Listora")
        .accessibilityAddTraits(.isImage)
    }
}

/// Where the wordmark's parts go, with the baseline at y = 0 and the l's pen position at x = 0.
/// The l is the mark scaled so its loop is 1.04 times the font's own l, its string as thick as the
/// font's stem (0.168 em) times 0.72, and its tag turned to 72 degrees at 0.9 scale; the other
/// letters keep their kerned positions, moved by the difference between the two l's advances.
/// These are the numbers of the concept's generator (data/lstlogo2 `gen.py`, `wm_looptag`).
struct WordmarkLayout {
    static let word = "listora"
    /// Tracking, in em, as the concept set it.
    static let tracking: CGFloat = -0.01
    /// Fraunces' measured stem, in em.
    static let stem: CGFloat = 0.168

    let size: CGFloat
    /// The letters after the l, and the l's string.
    let letters: Path
    /// The l's tag.
    let tag: Path
    /// Everything, ink bounds.
    let bounds: CGRect
    /// The l's string, ink bounds.
    let stringBounds: CGRect
    /// Where the "i" starts, from the l's pen position.
    let secondLetterX: CGFloat

    init(size: CGFloat) {
        self.size = size
        let font = BrandFont.font(size: size)
        let line = CTLineCreateWithAttributedString(NSAttributedString(
            string: Self.word,
            attributes: [
                kCTFontAttributeName as NSAttributedString.Key: font,
                kCTTrackingAttributeName as NSAttributedString.Key: Self.tracking * size,
            ],
        ))
        var glyphs: [(glyph: CGGlyph, x: CGFloat)] = []
        for run in CTLineGetGlyphRuns(line) as? [CTRun] ?? [] {
            let count = CTRunGetGlyphCount(run)
            var runGlyphs = [CGGlyph](repeating: 0, count: count)
            var positions = [CGPoint](repeating: .zero, count: count)
            CTRunGetGlyphs(run, CFRange(location: 0, length: count), &runGlyphs)
            CTRunGetPositions(run, CFRange(location: 0, length: count), &positions)
            glyphs += zip(runGlyphs, positions).map { (glyph: $0, x: $1.x) }
        }
        precondition(glyphs.count == Self.word.count, "The brand font shaped \(Self.word) into \(glyphs.count) glyphs")

        // The font's own l: its height and advance.
        var lGlyph = glyphs[0].glyph
        let lBounds = CTFontGetBoundingRectsForGlyphs(font, .horizontal, &lGlyph, nil, 1)
        var lAdvance = CGSize.zero
        CTFontGetAdvancesForGlyphs(font, .horizontal, &lGlyph, &lAdvance, 1)

        // The loop spans y = 5 to 83 of the mark's box, and x = 10 to 57.
        let height = lBounds.maxY * 1.04
        let scale = height / 78
        let width = Self.stem * size * 0.72 / scale
        let markTransform = CGAffineTransform(
            translationX: -10 * scale + width * scale / 2,
            y: -height - scale,
        ).scaledBy(x: scale, y: scale)
        let advance = 47 * scale + 0.10 * size
        let shift = advance - lAdvance.width

        let string = Looptag.stroke(width: width).applying(markTransform)
        stringBounds = string.boundingRect
        var letters = string
        for (glyph, x) in glyphs.dropFirst() {
            var placement = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: x + shift, ty: 0)
            if let outline = CTFontCreatePathForGlyph(font, glyph, &placement) {
                letters.addPath(Path(outline))
            }
        }
        self.letters = letters
        tag = Looptag.tag(angle: 72, scale: 0.9).applying(markTransform)
        bounds = letters.boundingRect.union(tag.boundingRect)
        secondLetterX = glyphs[1].x + shift
    }
}
