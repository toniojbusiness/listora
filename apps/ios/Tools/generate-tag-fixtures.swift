// Renders the synthetic tag photos that TagReadingFeatureTests reads with Vision, and their
// manifest of expected text and barcodes. Run it on a Mac with `make ios-tag-fixtures`.
//
// Everything is drawn here: system fonts, bars from the GS1 encoding tables, and Core Image's
// Code 128 and QR generators. No downloaded photo or third-party asset is involved. Brands and
// numbers are made up. The noise is seeded, so a run on the same macOS version reproduces the
// same pixels.
//
// It is a one-file developer tool, not app code: a failed Core Graphics or Core Image call stops
// it with a crash, and drawing helpers take a position and size per element.
// swiftlint:disable file_length
// swiftlint:disable force_unwrapping function_parameter_count

import CoreGraphics
import CoreImage
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

// MARK: - Fixture specs

/// One element drawn on a tag, in points from the bottom-left of the canvas.
enum Element {
    case text(String, x: CGFloat, y: CGFloat, size: CGFloat, bold: Bool = false)
    /// A woven size tab: a bordered box with a short centered label.
    case sizeTab(String, x: CGFloat, y: CGFloat, size: CGFloat)
    case ean13(String, x: CGFloat, y: CGFloat, module: CGFloat)
    case ean8(String, x: CGFloat, y: CGFloat, module: CGFloat)
    case code128(String, x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat)
    case qr(String, x: CGFloat, y: CGFloat, side: CGFloat)
}

struct ExpectedBarcode: Encodable {
    let symbology: String
    let payload: String
}

struct Fixture {
    let name: String
    let width: Int
    let height: Int
    var rotationDegrees: CGFloat = 0
    /// EXIF orientation written to the file. For 6 (`right`) the pixels are stored rotated a
    /// quarter turn counterclockwise, as an iPhone held upright stores them.
    var exifOrientation: Int = 1
    let elements: [Element]
    /// Lines the reader must return, exactly.
    var lines: [String] = []
    var barcodes: [ExpectedBarcode] = []
    /// Short size-tab labels the reader must return.
    var sizeTabs: [String] = []
    /// Why the fixture exists; copied into the manifest.
    let purpose: String
}

let careLabelElements: [Element] = [
    .text("ACME OUTFITTERS", x: 90, y: 1360, size: 84, bold: true),
    .text("RN 12345", x: 90, y: 1200, size: 60),
    .text("CA 54321", x: 90, y: 1080, size: 60),
    .text("60% COTTON 40% POLYESTER", x: 90, y: 940, size: 54),
    .text("MADE IN VIETNAM", x: 90, y: 820, size: 54),
    .text("STYLE NO. AB1234", x: 90, y: 700, size: 54),
    .text("MACHINE WASH COLD", x: 90, y: 580, size: 54),
]
let careLabelLines = [
    "ACME OUTFITTERS", "RN 12345", "CA 54321", "60% COTTON 40% POLYESTER", "MADE IN VIETNAM",
    "STYLE NO. AB1234", "MACHINE WASH COLD",
]

/// A full-resolution neck label (4032 x 3024 as shot, stored upright) whose size tab is too small
/// for one Vision pass over the whole photo.
func neckLabel(name: String, tab: String, tabSize: CGFloat, purpose: String) -> Fixture {
    Fixture(
        name: name, width: 3024, height: 4032, rotationDegrees: -1,
        elements: [
            .text("NORTHWIND", x: 420, y: 3000, size: 260, bold: true),
            .text("100% COTTON", x: 520, y: 2550, size: 130),
            .text("MADE IN PERU", x: 520, y: 2300, size: 130),
            .sizeTab(tab, x: 1380, y: 1500, size: tabSize),
        ],
        lines: ["NORTHWIND", "100% COTTON", "MADE IN PERU"],
        sizeTabs: [tab],
        purpose: purpose,
    )
}

let fixtures: [Fixture] = [
    Fixture(
        name: "care-label", width: 1200, height: 1600, rotationDegrees: 1.5,
        elements: careLabelElements,
        lines: careLabelLines,
        purpose: "Multi-line care label: RN, CA, fiber, origin, style. Vision reads the C and E of ACME "
            + "as Cyrillic letters, so it also covers folding them back to Latin.",
    ),
    Fixture(
        name: "care-label-exif-right", width: 1200, height: 1600, exifOrientation: 6,
        elements: careLabelElements,
        lines: careLabelLines,
        purpose: "The care label stored sideways with EXIF orientation 6, as the camera writes it.",
    ),
    Fixture(
        name: "hang-tag-upc-a", width: 1200, height: 1600, rotationDegrees: -2,
        elements: [
            .text("BLUE HARBOR", x: 120, y: 1350, size: 90, bold: true),
            .text("$24.99", x: 120, y: 1200, size: 80),
            .ean13("0036000291452", x: 150, y: 300, module: 8),
        ],
        lines: ["BLUE HARBOR", "$24.99"],
        // Vision has no UPC-A symbology: it reports a UPC-A as the EAN-13 with a leading 0.
        barcodes: [ExpectedBarcode(symbology: "ean13", payload: "0036000291452")],
        purpose: "UPC-A hang tag; Vision reports it as EAN-13 with a leading zero.",
    ),
    Fixture(
        name: "hang-tag-ean-13", width: 1200, height: 1600,
        elements: [
            .text("MAISON LUNE", x: 120, y: 1350, size: 90, bold: true),
            .ean13("4006381333931", x: 150, y: 300, module: 8),
        ],
        lines: ["MAISON LUNE"],
        barcodes: [ExpectedBarcode(symbology: "ean13", payload: "4006381333931")],
        purpose: "EAN-13 hang tag.",
    ),
    Fixture(
        name: "hang-tag-ean-8", width: 1200, height: 1600, rotationDegrees: 1,
        elements: [
            .text("KIDS CORNER", x: 120, y: 1350, size: 90, bold: true),
            .ean8("96385074", x: 300, y: 300, module: 10),
        ],
        lines: ["KIDS CORNER"],
        barcodes: [ExpectedBarcode(symbology: "ean8", payload: "96385074")],
        purpose: "EAN-8 hang tag (small items).",
    ),
    Fixture(
        name: "hang-tag-code-128", width: 1200, height: 1600,
        elements: [
            .text("STYLE STY-AB1234", x: 120, y: 1350, size: 70),
            .code128("STY-AB1234-BLK", x: 120, y: 650, width: 960, height: 300),
        ],
        lines: ["STYLE STY-AB1234"],
        barcodes: [ExpectedBarcode(symbology: "code128", payload: "STY-AB1234-BLK")],
        purpose: "Code 128 style barcode, as retailers print on internal tags.",
    ),
    Fixture(
        name: "hang-tag-qr", width: 1200, height: 1600, rotationDegrees: -1,
        elements: [
            .text("SCAN FOR CARE", x: 120, y: 1350, size: 80, bold: true),
            .qr("https://example.com/p/AB1234", x: 300, y: 450, side: 600),
        ],
        lines: ["SCAN FOR CARE"],
        barcodes: [ExpectedBarcode(symbology: "qr", payload: "https://example.com/p/AB1234")],
        purpose: "QR code on a hang tag.",
    ),
    neckLabel(name: "neck-label-size-tab-m", tab: "M", tabSize: 38, purpose: "Single-letter size tab (M)."),
    neckLabel(name: "neck-label-size-tab-8", tab: "8", tabSize: 44, purpose: "Single-digit size tab (8)."),
    neckLabel(name: "neck-label-size-tab-xs", tab: "XS", tabSize: 44, purpose: "Two-letter size tab (XS)."),
    Fixture(
        name: "blank-fabric", width: 1200, height: 1600,
        elements: [],
        purpose: "No text and no barcode: the reader returns nothing rather than noise.",
    ),
]

// MARK: - Rendering

let ink = CGColor(red: 0.12, green: 0.11, blue: 0.10, alpha: 1)
let fabric = CGColor(red: 0.95, green: 0.93, blue: 0.89, alpha: 1)

func drawText(_ text: String, in context: CGContext, x: CGFloat, y: CGFloat, size: CGFloat, bold: Bool) {
    let font = CTFontCreateWithName((bold ? "Helvetica-Bold" : "Helvetica") as CFString, size, nil)
    let string = NSAttributedString(string: text, attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): ink,
    ])
    context.textPosition = CGPoint(x: x, y: y)
    CTLineDraw(CTLineCreateWithAttributedString(string), context)
}

func textWidth(_ text: String, size: CGFloat, bold: Bool) -> CGFloat {
    let font = CTFontCreateWithName((bold ? "Helvetica-Bold" : "Helvetica") as CFString, size, nil)
    let string = NSAttributedString(
        string: text,
        attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font],
    )
    return CTLineGetTypographicBounds(CTLineCreateWithAttributedString(string), nil, nil, nil)
}

/// EAN encoding tables (GS1 General Specifications, section 5.2.1).
let eanL = [
    "0001101",
    "0011001",
    "0010011",
    "0111101",
    "0100011",
    "0110001",
    "0101111",
    "0111011",
    "0110111",
    "0001011",
]
let eanG = [
    "0100111",
    "0110011",
    "0011011",
    "0100001",
    "0011101",
    "0111001",
    "0000101",
    "0010001",
    "0001001",
    "0010111",
]
let eanR = [
    "1110010",
    "1100110",
    "1101100",
    "1000010",
    "1011100",
    "1001110",
    "1010000",
    "1000100",
    "1001000",
    "1110100",
]
let ean13Parity = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"]

func digits(_ payload: String) -> [Int] {
    payload.map { Int(String($0))! }
}

func ean13Modules(_ payload: String) -> String {
    let code = digits(payload)
    precondition(code.count == 13, "EAN-13 needs 13 digits")
    let parity = Array(ean13Parity[code[0]])
    var bits = "101"
    for index in 1 ... 6 {
        bits += parity[index - 1] == "L" ? eanL[code[index]] : eanG[code[index]]
    }
    bits += "01010"
    for index in 7 ... 12 {
        bits += eanR[code[index]]
    }
    return bits + "101"
}

func ean8Modules(_ payload: String) -> String {
    let code = digits(payload)
    precondition(code.count == 8, "EAN-8 needs 8 digits")
    var bits = "101"
    for index in 0 ... 3 {
        bits += eanL[code[index]]
    }
    bits += "01010"
    for index in 4 ... 7 {
        bits += eanR[code[index]]
    }
    return bits + "101"
}

func drawBars(_ bits: String, in context: CGContext, x: CGFloat, y: CGFloat, module: CGFloat, height: CGFloat) {
    context.setFillColor(ink)
    for (index, bit) in bits.enumerated() where bit == "1" {
        context.fill(CGRect(x: x + CGFloat(index) * module, y: y, width: module, height: height))
    }
}

/// Draws a Core Image barcode generator's output scaled to the rect without smoothing.
func drawGenerated(_ filterName: String, message: String, in context: CGContext, rect: CGRect) {
    let filter = CIFilter(name: filterName)!
    filter.setValue(Data(message.utf8), forKey: "inputMessage")
    if filterName == "CICode128BarcodeGenerator" {
        filter.setValue(0, forKey: "inputQuietSpace")
    }
    let output = filter.outputImage!
    let image = CIContext().createCGImage(output, from: output.extent)!
    context.interpolationQuality = .none
    context.draw(image, in: rect)
}

func draw(_ element: Element, in context: CGContext) {
    switch element {
    case let .text(text, x, y, size, bold):
        drawText(text, in: context, x: x, y: y, size: size, bold: bold)
    case let .sizeTab(text, x, y, size):
        let width = max(textWidth(text, size: size, bold: true) + size * 1.2, size * 1.8)
        let box = CGRect(x: x, y: y, width: width, height: size * 1.6)
        context.setStrokeColor(ink)
        context.setLineWidth(size * 0.08)
        context.stroke(box)
        let textX = box.midX - textWidth(text, size: size, bold: true) / 2
        drawText(text, in: context, x: textX, y: y + size * 0.42, size: size, bold: true)
    case let .ean13(payload, x, y, module):
        drawBars(ean13Modules(payload), in: context, x: x, y: y + module * 14, module: module, height: module * 70)
        let grouped = "\(payload.prefix(1))  \(payload.dropFirst().prefix(6))  \(payload.suffix(6))"
        drawText(grouped, in: context, x: x - module * 6, y: y, size: module * 10, bold: false)
    case let .ean8(payload, x, y, module):
        drawBars(ean8Modules(payload), in: context, x: x, y: y + module * 14, module: module, height: module * 60)
        let grouped = "\(payload.prefix(4))  \(payload.suffix(4))"
        drawText(grouped, in: context, x: x + module * 6, y: y, size: module * 10, bold: false)
    case let .code128(payload, x, y, width, height):
        drawGenerated(
            "CICode128BarcodeGenerator",
            message: payload,
            in: context,
            rect: CGRect(x: x, y: y, width: width, height: height),
        )
    case let .qr(payload, x, y, side):
        drawGenerated(
            "CIQRCodeGenerator",
            message: payload,
            in: context,
            rect: CGRect(x: x, y: y, width: side, height: side),
        )
    }
}

/// SplitMix64: a tiny seeded generator, so the noise is the same on every run.
struct SeededGenerator: RandomNumberGenerator {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var mixed = state
        mixed = (mixed ^ (mixed >> 30)) &* 0xBF58_476D_1CE4_E5B9
        mixed = (mixed ^ (mixed >> 27)) &* 0x94D0_49BB_1331_11EB
        return mixed ^ (mixed >> 31)
    }
}

func makeContext(width: Int, height: Int) -> CGContext {
    CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue,
    )!
}

/// Adds faint seeded grain, like the weave of a fabric tag, then softens it like a phone lens.
func roughen(_ context: CGContext, seed: UInt64) -> CGImage {
    var generator = SeededGenerator(state: seed)
    let pixels = context.data!.bindMemory(to: UInt8.self, capacity: context.bytesPerRow * context.height)
    for offset in stride(from: 0, to: context.bytesPerRow * context.height, by: 4) {
        let grain = Int(generator.next() % 9) - 4
        for channel in 0 ..< 3 {
            pixels[offset + channel] = UInt8(clamping: Int(pixels[offset + channel]) + grain)
        }
    }
    let sharp = CIImage(cgImage: context.makeImage()!)
    let blurred = sharp.clampedToExtent().applyingGaussianBlur(sigma: 1.2).cropped(to: sharp.extent)
    return CIContext().createCGImage(blurred, from: sharp.extent)!
}

func render(_ fixture: Fixture) -> CGImage {
    let context = makeContext(width: fixture.width, height: fixture.height)
    context.setFillColor(fabric)
    context.fill(CGRect(x: 0, y: 0, width: fixture.width, height: fixture.height))
    context.saveGState()
    context.translateBy(x: CGFloat(fixture.width) / 2, y: CGFloat(fixture.height) / 2)
    context.rotate(by: fixture.rotationDegrees * .pi / 180)
    context.translateBy(x: -CGFloat(fixture.width) / 2, y: -CGFloat(fixture.height) / 2)
    for element in fixture.elements {
        draw(element, in: context)
    }
    context.restoreGState()
    let seed = fixture.name.utf8.reduce(UInt64(1_469_598_103_934_665_603)) { ($0 ^ UInt64($1)) &* 1_099_511_628_211 }
    return roughen(context, seed: seed)
}

/// Stores the upright image the way a camera does for the given EXIF orientation.
func stored(_ upright: CGImage, exifOrientation: Int) -> CGImage {
    guard exifOrientation == 6 else {
        precondition(exifOrientation == 1, "only orientations 1 and 6 are generated")
        return upright
    }
    // Orientation 6 means "rotate 90 degrees clockwise to display", so store it counterclockwise.
    let context = makeContext(width: upright.height, height: upright.width)
    context.translateBy(x: CGFloat(upright.height), y: 0)
    context.rotate(by: .pi / 2)
    context.draw(upright, in: CGRect(x: 0, y: 0, width: upright.width, height: upright.height))
    return context.makeImage()!
}

func writeJPEG(_ image: CGImage, exifOrientation: Int, to url: URL) {
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil)!
    let properties: [CFString: Any] = [
        kCGImageDestinationLossyCompressionQuality: 0.72,
        kCGImagePropertyOrientation: exifOrientation,
    ]
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    precondition(CGImageDestinationFinalize(destination), "could not write \(url.path)")
}

// MARK: - Main

struct ManifestEntry: Encodable {
    let file: String
    let purpose: String
    let lines: [String]
    let barcodes: [ExpectedBarcode]
    let sizeTabs: [String]
}

let scriptURL = URL(fileURLWithPath: #filePath)
let outputURL = scriptURL.deletingLastPathComponent()
    .appending(path: "../Packages/Features/Tests/TagReadingFeatureTests/Fixtures", directoryHint: .isDirectory)
    .standardizedFileURL
try FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)

var manifest: [String: ManifestEntry] = [:]
for fixture in fixtures {
    let file = "\(fixture.name).jpg"
    let image = stored(render(fixture), exifOrientation: fixture.exifOrientation)
    writeJPEG(image, exifOrientation: fixture.exifOrientation, to: outputURL.appending(path: file))
    manifest[fixture.name] = ManifestEntry(
        file: file, purpose: fixture.purpose, lines: fixture.lines, barcodes: fixture.barcodes,
        sizeTabs: fixture.sizeTabs,
    )
    print("wrote \(file)")
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
try (encoder.encode(manifest) + Data("\n".utf8)).write(to: outputURL.appending(path: "manifest.json"))
print("wrote manifest.json")

// swiftlint:enable force_unwrapping function_parameter_count
