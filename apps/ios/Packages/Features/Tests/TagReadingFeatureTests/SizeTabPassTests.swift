import Core
import CoreGraphics
import Testing
@testable import TagReadingFeature

struct SizeTabPassTests {
    @Test
    func `overlapping tiles cover the whole photo`() {
        let tiles = SizeTabPass.tiles(width: 3024, height: 4032)
        #expect(tiles.count == 9)
        let bounds = CGRect(x: 0, y: 0, width: 3024, height: 4032)
        #expect(tiles.allSatisfy { bounds.contains($0) })
        #expect(tiles.reduce(CGRect.null) { $0.union($1) } == bounds)
        // Neighbors overlap, so a tab on a tile edge is whole in one of them.
        #expect(tiles[0].intersects(tiles[1]) && tiles[0].intersects(tiles[3]))
        #expect(tiles[0].maxX - tiles[1].minX > 300)
    }

    @Test
    func `reads large tiles at reduced size and small tiles as they are`() throws {
        let large = try #require(SizeTabPass.downscaled(gray(width: 1747, height: 1310)))
        #expect(large.width == SizeTabPass.tileMaxPixelSize)
        #expect(large.height == 675)
        let small = gray(width: 600, height: 400)
        #expect(SizeTabPass.downscaled(small) === small)
    }

    @Test(arguments: [
        ("M", "M"), ("8", "8"), ("XS", "XS"), ("[XS]", "XS"), ("|10", "10"), (" xL ", "xL"), ("8.5", "8.5"),
        ("14W", "14W"), ("XXXL", "XXXL"),
    ])
    func `keeps short size tokens and trims the tab border`(read: String, token: String) {
        #expect(SizeTabPass.token(from: read) == token)
    }

    @Test(arguments: ["", "[]", "|", "COTTON", "XXXXL", "ERS U", "%", "--", "M!"])
    func `drops reads that cannot be a size tab`(read: String) {
        #expect(SizeTabPass.token(from: read) == nil)
    }

    @Test
    func `drops tokens inside a whole-photo line and keeps one read per tab`() {
        let brand = TagTextLine(
            text: "NORTHWIND", confidence: 1, boundingBox: PhotoRect(x: 0.1, y: 0.2, width: 0.6, height: 0.05),
            pass: .fullImage,
        )
        let candidates = [
            // A tile edge cut "NORTHWIND"; its tail lies inside the brand line.
            candidate("ND", 1, x: 0.6, y: 0.2),
            // The same tab seen by two overlapping tiles.
            candidate("xS", 0.5, x: 0.45, y: 0.6),
            candidate("XS", 1, x: 0.451, y: 0.601),
            // Too unsure: usually a tab border read as a glyph.
            candidate("I", 0.3, x: 0.8, y: 0.8),
            candidate("8", 1, x: 0.2, y: 0.7),
        ]
        let lines = SizeTabPass.select(candidates, fullImageLines: [brand])
        #expect(lines.map(\.text) == ["XS", "8"])
        #expect(lines.allSatisfy { $0.pass == .sizeTab })
    }

    @Test
    func `keeps a tile read that corrects a short whole-photo misread`() {
        func fullLine(_ text: String, x: Double) -> TagTextLine {
            TagTextLine(
                text: text, confidence: 1, boundingBox: PhotoRect(x: x, y: 0.5, width: 0.04, height: 0.02),
                pass: .fullImage,
            )
        }
        let lines = SizeTabPass.select(
            [candidate("M", 1, x: 0.2, y: 0.5), candidate("M", 1, x: 0.5, y: 0.5), candidate("XS", 1, x: 0.8, y: 0.5)],
            fullImageLines: [fullLine("w]", x: 0.2), fullLine("[M]", x: 0.5), fullLine("xs", x: 0.8)],
        )
        // "[M]" already reads as M; "w]" and "xs" do not read as the tab does.
        #expect(lines.map(\.text) == ["M", "XS"])
        #expect(lines.map(\.boundingBox.minX) == [0.2, 0.8])
    }

    @Test
    func `maps a box inside a tile back to the whole photo`() {
        let image = gray(width: 300, height: 400)
        let tile = CGRect(x: 100, y: 200, width: 100, height: 200)
        // Vision's box: bottom-left origin, normalized to the tile.
        let box = CGRect(x: 0.5, y: 0.25, width: 0.2, height: 0.25)
        let rect = VisionTagReader.photoRect(box, inTile: tile, of: image)
        #expect(abs(rect.x - 0.5) < 1e-9)
        #expect(abs(rect.y - 0.75) < 1e-9)
        #expect(abs(rect.width - 20.0 / 300) < 1e-9)
        #expect(abs(rect.height - 0.125) < 1e-9)
    }

    private func gray(width: Int, height: Int) -> CGImage {
        let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue,
        )
        // A bitmap this small always allocates.
        return context!.makeImage()! // swiftlint:disable:this force_unwrapping
    }

    private func candidate(_ text: String, _ confidence: Double, x: Double, y: Double) -> SizeTabPass.Candidate {
        SizeTabPass.Candidate(
            text: text, confidence: confidence, boundingBox: PhotoRect(x: x, y: y, width: 0.03, height: 0.015),
        )
    }
}

struct LatinFoldingTests {
    @Test
    func `folds Cyrillic and Greek look-alikes in Latin text`() {
        #expect(LatinFolding.fold("A\u{0421}M\u{0415} OUTFITTERS") == "ACME OUTFITTERS")
        #expect(LatinFolding.fold("\u{0421}\u{0410} 54321") == "CA 54321")
        #expect(LatinFolding.fold("\u{0397}\u{039F}\u{039C}\u{0395}") == "HOME")
    }

    @Test
    func `leaves Latin text with accents unchanged`() {
        #expect(LatinFolding.fold("55% ALGODÓN 45% LIN") == "55% ALGODÓN 45% LIN")
        #expect(LatinFolding.fold("RN 12345") == "RN 12345")
    }

    @Test
    func `leaves real Cyrillic and Greek text unchanged`() {
        #expect(LatinFolding.fold("ХЛОПОК 100%") == "ХЛОПОК 100%")
        #expect(LatinFolding.fold("ΥΦΑΣΜΑ") == "ΥΦΑΣΜΑ")
    }
}
