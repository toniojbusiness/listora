// Renders the synthetic haul photos that batch grouping is tested on: garments photographed one
// after another on the same floor (front, back, and a close-up of the tag), in the sequences
// PhotoSignalsFeatureTests groups, and the 3-item haul the batch UI test shoots with the fake
// camera. Run it on a Mac with `make ios-batch-fixtures`.
//
// Everything is drawn here with Core Graphics and Core Text: garment silhouettes, fabric
// patterns, the floor, and the tags' text. No downloaded photo or third-party asset is involved,
// and brands are made up. The noise is seeded, so a run on the same macOS version reproduces the
// same pixels.
//
// It is a one-file developer tool, not app code: a failed Core Graphics call stops it with a
// crash, and drawing helpers take a position and size per element.
// swiftlint:disable file_length
// swiftlint:disable force_unwrapping function_parameter_count

import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Drawing coordinates; the files are written at ``outputScale`` of this, small enough to keep
/// the repository light and still large enough for Vision to read the tags.
let width = 900
let height = 1200
let outputScale: CGFloat = 2.0 / 3.0

// MARK: - Randomness

/// SplitMix64: a small seeded generator, so every run draws the same noise.
struct SeededGenerator: RandomNumberGenerator {
    var state: UInt64

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var value = state
        value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
        value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
        return value ^ (value >> 31)
    }
}

// MARK: - Garments

enum Shape {
    case tee
    case longSleeve
    case pants
    case dress
}

enum Pattern {
    case solid
    case stripes(CGColor)
    case dots(CGColor)
    case plaid(CGColor)
}

struct Garment {
    let shape: Shape
    let color: CGColor
    let pattern: Pattern
    /// Drawn on the front only: a short print, or nothing.
    let graphic: String?
    let tagBrand: String
    let tagLines: [String]
}

func rgb(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> CGColor {
    CGColor(srgbRed: red / 255, green: green / 255, blue: blue / 255, alpha: 1)
}

let garments: [String: Garment] = [
    "tee": Garment(
        shape: .tee, color: rgb(196, 40, 48), pattern: .solid, graphic: "SUN",
        tagBrand: "NORTHWIND", tagLines: ["SIZE M", "RN 54012", "100% COTTON", "MADE IN PERU"],
    ),
    "jeans": Garment(
        shape: .pants, color: rgb(52, 86, 140), pattern: .solid, graphic: nil,
        tagBrand: "RIVET & CO", tagLines: ["32 X 30", "RN 77231", "98% COTTON 2% ELASTANE", "MADE IN MEXICO"],
    ),
    "dress": Garment(
        shape: .dress, color: rgb(46, 132, 92), pattern: .dots(rgb(240, 226, 170)), graphic: nil,
        tagBrand: "MAPLE LANE", tagLines: ["SIZE 8", "RN 31890", "100% RAYON", "MADE IN INDIA"],
    ),
    "flannel": Garment(
        shape: .longSleeve, color: rgb(170, 60, 40), pattern: .plaid(rgb(40, 30, 30)), graphic: nil,
        tagBrand: "TIMBERLINE", tagLines: ["SIZE L", "RN 66104", "100% COTTON", "MADE IN VIETNAM"],
    ),
    "stripes": Garment(
        shape: .longSleeve, color: rgb(238, 232, 214), pattern: .stripes(rgb(30, 50, 90)), graphic: nil,
        tagBrand: "HARBOR", tagLines: ["SIZE S", "RN 12077", "60% COTTON 40% POLYESTER", "MADE IN CHINA"],
    ),
    // Two look-alikes: the same navy tee, one with a small print. Only the print tells them apart.
    "navy-a": Garment(
        shape: .tee, color: rgb(30, 40, 78), pattern: .solid, graphic: nil,
        tagBrand: "BASICS", tagLines: ["SIZE L"],
    ),
    "navy-b": Garment(
        shape: .tee, color: rgb(34, 44, 84), pattern: .solid, graphic: "92",
        tagBrand: "BASICS", tagLines: ["SIZE M"],
    ),
]

enum Shot {
    case front
    case back
    case tag
}

// MARK: - Drawing

func makeContext() -> CGContext {
    let context = CGContext(
        data: nil,
        width: Int(CGFloat(width) * outputScale),
        height: Int(CGFloat(height) * outputScale),
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue,
    )!
    context.scaleBy(x: outputScale, y: outputScale)
    return context
}

/// The floor every item lies on: warm planks with grain, as one seller's spot would be.
func drawFloor(_ context: CGContext, lighting: CGFloat, generator: inout SeededGenerator) {
    let plankHeight: CGFloat = 150
    for index in 0 ..< Int(CGFloat(height) / plankHeight) + 1 {
        let shade = CGFloat(Int.random(in: -10 ... 10, using: &generator))
        context.setFillColor(rgb(
            min(255, (196 + shade) * lighting),
            min(255, (164 + shade) * lighting),
            min(255, (120 + shade) * lighting),
        ))
        context.fill(CGRect(x: 0, y: CGFloat(index) * plankHeight, width: CGFloat(width), height: plankHeight))
        context.setStrokeColor(rgb(120 * lighting, 92 * lighting, 60 * lighting))
        context.setLineWidth(3)
        context.stroke(CGRect(x: -4, y: CGFloat(index) * plankHeight, width: CGFloat(width) + 8, height: plankHeight))
    }
    context.setStrokeColor(rgb(150 * lighting, 118 * lighting, 82 * lighting).copy(alpha: 0.35)!)
    context.setLineWidth(1.5)
    for _ in 0 ..< 140 {
        let y = CGFloat.random(in: 0 ... CGFloat(height), using: &generator)
        let x = CGFloat.random(in: -100 ... CGFloat(width), using: &generator)
        context.move(to: CGPoint(x: x, y: y))
        context.addLine(to: CGPoint(x: x + CGFloat.random(in: 120 ... 400, using: &generator), y: y + 2))
        context.strokePath()
    }
}

func silhouette(_ shape: Shape) -> CGPath {
    let path = CGMutablePath()
    switch shape {
    case .tee:
        path.addLines(between: [
            CGPoint(x: 250, y: 200), CGPoint(x: 650, y: 200), CGPoint(x: 650, y: 720),
            CGPoint(x: 800, y: 640), CGPoint(x: 860, y: 780), CGPoint(x: 660, y: 930),
            CGPoint(x: 540, y: 960), CGPoint(x: 450, y: 900), CGPoint(x: 360, y: 960),
            CGPoint(x: 240, y: 930), CGPoint(x: 40, y: 780), CGPoint(x: 100, y: 640),
            CGPoint(x: 250, y: 720),
        ])
    case .longSleeve:
        path.addLines(between: [
            CGPoint(x: 260, y: 180), CGPoint(x: 640, y: 180), CGPoint(x: 640, y: 720),
            CGPoint(x: 760, y: 260), CGPoint(x: 850, y: 280), CGPoint(x: 700, y: 930),
            CGPoint(x: 550, y: 970), CGPoint(x: 450, y: 910), CGPoint(x: 350, y: 970),
            CGPoint(x: 200, y: 930), CGPoint(x: 50, y: 280), CGPoint(x: 140, y: 260),
            CGPoint(x: 260, y: 720),
        ])
    case .pants:
        path.addLines(between: [
            CGPoint(x: 280, y: 980), CGPoint(x: 620, y: 980), CGPoint(x: 660, y: 120),
            CGPoint(x: 490, y: 120), CGPoint(x: 450, y: 700), CGPoint(x: 410, y: 120),
            CGPoint(x: 240, y: 120),
        ])
    case .dress:
        path.addLines(between: [
            CGPoint(x: 330, y: 1000), CGPoint(x: 570, y: 1000), CGPoint(x: 600, y: 680),
            CGPoint(x: 800, y: 150), CGPoint(x: 100, y: 150), CGPoint(x: 300, y: 680),
        ])
    }
    path.closeSubpath()
    return path
}

func drawPattern(_ pattern: Pattern, in context: CGContext, generator: inout SeededGenerator) {
    switch pattern {
    case .solid:
        break
    case let .stripes(color):
        context.setFillColor(color)
        for row in stride(from: 0, to: height, by: 70) {
            context.fill(CGRect(x: 0, y: CGFloat(row), width: CGFloat(width), height: 26))
        }
    case let .dots(color):
        context.setFillColor(color)
        for row in stride(from: 0, to: height, by: 80) {
            for column in stride(from: (row / 80).isMultiple(of: 2) ? 0 : 40, to: width, by: 80) {
                let jitter = CGFloat.random(in: -4 ... 4, using: &generator)
                context.fillEllipse(in: CGRect(x: CGFloat(column) + jitter, y: CGFloat(row), width: 22, height: 22))
            }
        }
    case let .plaid(color):
        context.setFillColor(color.copy(alpha: 0.55)!)
        for line in stride(from: 0, to: max(width, height), by: 120) {
            context.fill(CGRect(x: CGFloat(line), y: 0, width: 34, height: CGFloat(height)))
            context.fill(CGRect(x: 0, y: CGFloat(line), width: CGFloat(width), height: 34))
        }
    }
}

func drawText(_ text: String, in context: CGContext, at point: CGPoint, size: CGFloat, color: CGColor, bold: Bool) {
    let font = CTFontCreateWithName((bold ? "Helvetica-Bold" : "Helvetica") as CFString, size, nil)
    let attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
    context.textPosition = point
    CTLineDraw(line, context)
}

/// The garment lying on the floor. The back is the same garment turned over: no print, the seams
/// of the back, and a slightly different position and light, as a second shot would be.
func drawGarment(_ garment: Garment, shot: Shot, in context: CGContext, generator: inout SeededGenerator) {
    let isBack = shot == .back
    context.saveGState()
    context.translateBy(x: CGFloat(width) / 2, y: CGFloat(height) / 2)
    context.rotate(by: (isBack ? -2.5 : 1.5) * .pi / 180)
    let scale: CGFloat = isBack ? 0.97 : 1.0
    context.scaleBy(x: scale, y: scale)
    context.translateBy(x: -CGFloat(width) / 2 + (isBack ? 14 : -10), y: -CGFloat(height) / 2 + (isBack ? -12 : 8))
    let path = silhouette(garment.shape)
    // A soft shadow under the fabric.
    context.saveGState()
    context.setShadow(offset: CGSize(width: 6, height: -10), blur: 22, color: rgb(40, 30, 20).copy(alpha: 0.45))
    context.addPath(path)
    context.setFillColor(garment.color)
    context.fillPath()
    context.restoreGState()
    context.addPath(path)
    context.clip()
    drawPattern(garment.pattern, in: context, generator: &generator)
    // Folds: light and dark bands across the fabric.
    for index in 0 ..< 5 {
        let y = CGFloat(220 + index * 160) + CGFloat.random(in: -30 ... 30, using: &generator)
        context
            .setFillColor(index.isMultiple(of: 2) ? rgb(255, 255, 255).copy(alpha: 0.07)! : rgb(0, 0, 0)
                .copy(alpha: 0.08)!)
        context.fill(CGRect(x: 0, y: y, width: CGFloat(width), height: 60))
    }
    context.setStrokeColor(rgb(0, 0, 0).copy(alpha: 0.25)!)
    context.setLineWidth(3)
    if isBack {
        // A back yoke seam, and back pockets on pants.
        context.move(to: CGPoint(x: 200, y: 820))
        context.addLine(to: CGPoint(x: 700, y: 820))
        context.strokePath()
        if garment.shape == .pants {
            context.stroke(CGRect(x: 300, y: 780, width: 110, height: 120))
            context.stroke(CGRect(x: 490, y: 780, width: 110, height: 120))
        }
    } else {
        // The neckline, a front fly or placket, and the print.
        context.strokeEllipse(in: CGRect(x: 380, y: 880, width: 140, height: 90))
        if garment.shape == .pants {
            context.move(to: CGPoint(x: 450, y: 960))
            context.addLine(to: CGPoint(x: 450, y: 760))
            context.strokePath()
        }
        if let graphic = garment.graphic {
            context.setFillColor(rgb(250, 246, 236))
            context.fillEllipse(in: CGRect(x: 340, y: 540, width: 220, height: 220))
            drawText(graphic, in: context, at: CGPoint(x: 385, y: 620), size: 64, color: garment.color, bold: true)
        }
    }
    context.restoreGState()
}

/// A close-up of the garment's tag: the label fills most of the frame, with the fabric around it.
func drawTag(_ garment: Garment, in context: CGContext, generator: inout SeededGenerator) {
    context.setFillColor(garment.color)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    drawPattern(garment.pattern, in: context, generator: &generator)
    context.saveGState()
    context.translateBy(x: CGFloat(width) / 2, y: CGFloat(height) / 2)
    context.rotate(by: -2 * .pi / 180)
    context.translateBy(x: -CGFloat(width) / 2, y: -CGFloat(height) / 2)
    let label = CGRect(x: 110, y: 170, width: 680, height: 860)
    context.setShadow(offset: CGSize(width: 4, height: -6), blur: 12, color: rgb(0, 0, 0).copy(alpha: 0.4))
    context.setFillColor(rgb(248, 245, 236))
    context.fill(label)
    context.setShadow(offset: .zero, blur: 0, color: nil)
    let ink = rgb(28, 28, 30)
    drawText(garment.tagBrand, in: context, at: CGPoint(x: 160, y: 890), size: 70, color: ink, bold: true)
    for (index, line) in garment.tagLines.enumerated() {
        drawText(
            line,
            in: context,
            at: CGPoint(x: 160, y: CGFloat(760 - index * 110)),
            size: 48,
            color: ink,
            bold: false,
        )
    }
    drawText("MACHINE WASH COLD", in: context, at: CGPoint(x: 160, y: 270), size: 40, color: ink, bold: false)
    context.restoreGState()
}

/// Sensor-like noise over the whole photo, so no two shots are pixel-identical.
func addNoise(to context: CGContext, generator: inout SeededGenerator) {
    for _ in 0 ..< 9000 {
        let x = CGFloat.random(in: 0 ..< CGFloat(width), using: &generator)
        let y = CGFloat.random(in: 0 ..< CGFloat(height), using: &generator)
        let value = CGFloat.random(in: 0 ... 1, using: &generator)
        context.setFillColor(rgb(value * 255, value * 255, value * 255).copy(alpha: 0.12)!)
        context.fill(CGRect(x: x, y: y, width: 2, height: 2))
    }
}

func render(_ garmentName: String, _ shot: Shot, seed: UInt64) -> CGImage {
    let garment = garments[garmentName]!
    var generator = SeededGenerator(state: seed)
    let context = makeContext()
    switch shot {
    case .front, .back:
        drawFloor(context, lighting: shot == .back ? 0.94 : 1.0, generator: &generator)
        drawGarment(garment, shot: shot, in: context, generator: &generator)
    case .tag:
        drawTag(garment, in: context, generator: &generator)
    }
    addNoise(to: context, generator: &generator)
    return context.makeImage()!
}

func writeJPEG(_ image: CGImage, to url: URL) {
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(
        destination,
        image,
        [kCGImageDestinationLossyCompressionQuality: 0.6] as CFDictionary,
    )
    precondition(CGImageDestinationFinalize(destination), "could not write \(url.path)")
}

// MARK: - Sequences

/// A haul as shot, in order: each entry is one photo.
struct Sequence {
    let name: String
    let shots: [(garment: String, shot: Shot)]
    /// Why the sequence exists; copied into the manifest.
    let purpose: String
}

func items(_ names: [String], shots: [Shot]) -> [(garment: String, shot: Shot)] {
    names.flatMap { name in shots.map { (name, $0) } }
}

let sequences = [
    Sequence(
        name: "haul",
        shots: items(["tee", "jeans", "dress"], shots: [.front, .back, .tag]),
        purpose: "Three items shot as the batch guide asks: front, back, then the tag of each.",
    ),
    Sequence(
        name: "no-tags",
        shots: items(["flannel", "jeans", "stripes"], shots: [.front, .back]),
        purpose: "Three items without tag shots: only the photos themselves tell the items apart.",
    ),
    Sequence(
        name: "look-alikes",
        shots: items(["navy-a", "navy-b"], shots: [.front, .back]),
        purpose: "Two nearly identical navy tees back to back, without tags: the seller must check the boundary.",
    ),
]

struct ManifestEntry: Encodable {
    let sequence: String
    let purpose: String
    let files: [String]
    /// The item each file belongs to, 0 first: the grouping a seller would confirm.
    let items: [Int]
}

let scriptURL = URL(fileURLWithPath: #filePath)
let iosDirectory = scriptURL.deletingLastPathComponent().appending(path: "..", directoryHint: .isDirectory)
let testFixtures = iosDirectory
    .appending(path: "Packages/Features/Tests/PhotoSignalsFeatureTests/Fixtures", directoryHint: .isDirectory)
let uiTestHaul = iosDirectory.appending(path: "ListoraUITests/BatchFixtures", directoryHint: .isDirectory)

var manifest: [ManifestEntry] = []
var seed: UInt64 = 2026
for sequence in sequences {
    let directory = testFixtures.appending(path: sequence.name, directoryHint: .isDirectory)
    try? FileManager.default.removeItem(at: directory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var files: [String] = []
    var itemIndexes: [Int] = []
    var garmentOrder: [String] = []
    for (index, entry) in sequence.shots.enumerated() {
        seed += 1
        let shotName = switch entry.shot {
        case .front: "front"
        case .back: "back"
        case .tag: "tag"
        }
        let file = String(format: "%02d-%@-%@.jpg", index + 1, entry.garment, shotName)
        writeJPEG(render(entry.garment, entry.shot, seed: seed), to: directory.appending(path: file))
        if !garmentOrder.contains(entry.garment) {
            garmentOrder.append(entry.garment)
        }
        files.append(file)
        itemIndexes.append(garmentOrder.firstIndex(of: entry.garment)!)
    }
    manifest.append(ManifestEntry(sequence: sequence.name, purpose: sequence.purpose, files: files, items: itemIndexes))
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
try encoder.encode(manifest).write(to: testFixtures.appending(path: "manifest.json"))

// The UI test shoots the first sequence with the fake camera, which takes a folder's photos in
// name order.
try? FileManager.default.removeItem(at: uiTestHaul)
try FileManager.default.copyItem(at: testFixtures.appending(path: "haul"), to: uiTestHaul)
print("Wrote \(manifest.count) sequences to \(testFixtures.path) and the haul to \(uiTestHaul.path)")
// swiftlint:enable force_unwrapping function_parameter_count
