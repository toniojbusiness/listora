import Core
import CoreGraphics
import Foundation

/// The dedicated pass for small isolated size tabs.
///
/// Vision text recognition over a whole photo skips text that is small relative to the photo, and
/// a lone "M", "8", or "XS" on a size tab is the first thing it drops (a 12 MP neck-label photo
/// loses a tab whose letters are under 1% of the photo's height, while longer lines of the same
/// size survive), or misreads it ("w]" for an M, "xs" for XS). Detecting text rectangles first
/// does not help: the rectangle detector skips single characters too. So this pass re-runs
/// recognition on overlapping tiles, where the same letters are three times larger relative to
/// the image, and keeps the short tokens the whole-photo pass did not already read the same way.
/// The whole-photo lines stay as they are, so the server sees both reads.
enum SizeTabPass {
    /// Tiles per side. Three finds tabs down to about 1% of the photo height; four costs almost
    /// twice as long for little gain.
    static let gridSize = 3
    /// Each tile reaches this share of a tile's size into its neighbors, so a tab on a tile edge
    /// is whole in at least one tile.
    static let overlap = 0.15
    /// Size tabs hold at most four characters ("XXL", "14W", "8.5"); longer reads from a tile are
    /// fragments of lines cut by the tile edge.
    static let maxTokenLength = 4
    /// Vision reports 1.0, 0.5, or 0.3 for short reads; 0.3 is mostly a tab border read as a glyph.
    static let minConfidence = 0.5
    /// A token whose box lies this much inside a whole-photo line is part of that line.
    static let coveredShare = 0.2

    /// Tiles are read at most this many pixels on the long side. Reading a 12 MP photo's tiles at
    /// half size (about 870 px) finds as many tabs as at full size, in four fifths of the time.
    static let tileMaxPixelSize = 900

    /// The tile scaled down to ``tileMaxPixelSize`` in grayscale, or the tile itself when it is
    /// already that small. Nil only when a bitmap cannot be allocated.
    static func downscaled(_ tile: CGImage) -> CGImage? {
        let scale = Double(tileMaxPixelSize) / Double(max(tile.width, tile.height))
        guard scale < 1 else { return tile }
        let width = max(1, Int((Double(tile.width) * scale).rounded()))
        let height = max(1, Int((Double(tile.height) * scale).rounded()))
        guard let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue,
        ) else { return nil }
        context.interpolationQuality = .high
        context.draw(tile, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }

    /// Tile rectangles in pixels of the upright image, top-left origin, row by row.
    static func tiles(width: Int, height: Int) -> [CGRect] {
        let bounds = CGRect(x: 0, y: 0, width: width, height: height)
        let tileWidth = Double(width) / Double(gridSize)
        let tileHeight = Double(height) / Double(gridSize)
        var tiles: [CGRect] = []
        for row in 0 ..< gridSize {
            for column in 0 ..< gridSize {
                let tile = CGRect(
                    x: Double(column) * tileWidth - tileWidth * overlap,
                    y: Double(row) * tileHeight - tileHeight * overlap,
                    width: tileWidth * (1 + 2 * overlap),
                    height: tileHeight * (1 + 2 * overlap),
                )
                tiles.append(tile.intersection(bounds).integral)
            }
        }
        return tiles
    }

    /// One read from a tile, already mapped to the whole photo.
    struct Candidate: Equatable {
        let text: String
        let confidence: Double
        let boundingBox: PhotoRect
    }

    /// Cleans a tile read into a size-tab token, or nil when it cannot be one. The tab's border is
    /// often read as a bracket or bar ("[XS]"), so those are trimmed from the ends.
    static func token(from text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: borderGlyphs)
        guard (1 ... maxTokenLength).contains(trimmed.count),
              trimmed.unicodeScalars.allSatisfy(tokenCharacters.contains),
              trimmed.unicodeScalars.contains(where: CharacterSet.alphanumerics.contains) else { return nil }
        return trimmed
    }

    /// Keeps the candidates the whole-photo pass did not read, one per tab: overlapping tiles see
    /// the same tab twice, and the more confident read wins. A candidate inside a whole-photo line
    /// is dropped when that line is longer text (the candidate is a piece of it) or the same token;
    /// a different short read there ("w]" where the tile reads "M") is a misread the tile corrects.
    /// Results run top to bottom, then left to right.
    static func select(_ candidates: [Candidate], fullImageLines: [TagTextLine]) -> [TagTextLine] {
        let fresh = candidates.filter { candidate in
            candidate.confidence >= minConfidence && !fullImageLines.contains { line in
                guard covered(candidate.boundingBox, by: line.boundingBox) else { return false }
                guard let lineToken = token(from: line.text) else { return true }
                return lineToken == candidate.text
            }
        }
        var kept: [Candidate] = []
        for candidate in fresh.sorted(by: { $0.confidence > $1.confidence }) {
            let duplicate = kept.contains { other in
                covered(candidate.boundingBox, by: other.boundingBox)
                    || covered(other.boundingBox, by: candidate.boundingBox)
            }
            if !duplicate {
                kept.append(candidate)
            }
        }
        return kept
            .sorted { ($0.boundingBox.minY, $0.boundingBox.minX) < ($1.boundingBox.minY, $1.boundingBox.minX) }
            .map { TagTextLine(text: $0.text, confidence: $0.confidence, boundingBox: $0.boundingBox, pass: .sizeTab) }
    }

    private static func covered(_ box: PhotoRect, by other: PhotoRect) -> Bool {
        guard box.area > 0, let overlap = box.intersection(other) else { return false }
        return overlap.area / box.area > coveredShare
    }

    private static let borderGlyphs = CharacterSet(charactersIn: "[](){}|").union(.whitespacesAndNewlines)
    private static let tokenCharacters = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "./-"))
}
