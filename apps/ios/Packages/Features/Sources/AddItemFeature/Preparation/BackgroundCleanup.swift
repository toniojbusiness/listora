import CoreGraphics
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import ImageIO
import Vision

enum BackgroundCleanupError: Error, Equatable {
    /// No item was found to lift off the background.
    case noSubject
    /// The photo could not be read, or the masking could not run.
    case failed
}

/// Finds the item in a photo: a mask of the photo's size, white over the item, black over the
/// background.
protocol SubjectMasker: Sendable {
    func subjectMask(of image: CGImage) throws(BackgroundCleanupError) -> CIImage
}

/// One-tap background cleanup, on the phone with no AI service: the item is lifted off the photo
/// (``SubjectMasker``) and laid on a plain, light backdrop that is the same for every photo, so a
/// seller's listings look consistent. The item keeps its place and size in the frame; only the
/// background changes. The result is a prepared photo like any other (upright JPEG, no metadata).
enum BackgroundCleanup {
    /// The backdrop, a soft neutral white (#F7F7F5) that marketplaces show cleanly.
    static let backdrop = CIColor(red: 247 / 255, green: 247 / 255, blue: 245 / 255)

    /// Vision's subject lifting on a device. The simulator cannot run Vision's segmentation models
    /// (it has no inference context for them), so there the stand-in ``EdgeColorSubjectMasker``
    /// lifts the item instead; devices always use Vision, which the simulator tests therefore do
    /// not exercise.
    static var platformMasker: any SubjectMasker {
        #if targetEnvironment(simulator)
            EdgeColorSubjectMasker()
        #else
            VisionSubjectMasker()
        #endif
    }

    static func clean(
        _ imageData: Data,
        masker: any SubjectMasker = platformMasker,
    ) throws(BackgroundCleanupError) -> PreparedPhoto {
        guard let source = CGImageSourceCreateWithData(imageData as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { throw .failed }
        let mask = try masker.subjectMask(of: image)
        let photo = CIImage(cgImage: image)
        let blend = CIFilter.blendWithMask()
        blend.inputImage = photo
        blend.backgroundImage = CIImage(color: backdrop).cropped(to: photo.extent)
        blend.maskImage = mask
        let context = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB) as Any])
        guard let output = blend.outputImage,
              let cleaned = context.createCGImage(output, from: photo.extent)
        else { throw .failed }
        do {
            return try PhotoPreparation.encode(cleaned)
        } catch {
            throw .failed
        }
    }
}

/// Vision's foreground instance mask, the subject lifting of the Photos app: every foreground
/// subject in the photo, with soft edges.
struct VisionSubjectMasker: SubjectMasker {
    func subjectMask(of image: CGImage) throws(BackgroundCleanupError) -> CIImage {
        let request = VNGenerateForegroundInstanceMaskRequest()
        let handler = VNImageRequestHandler(cgImage: image)
        do {
            try handler.perform([request])
        } catch {
            throw .failed
        }
        guard let observation = request.results?.first, !observation.allInstances.isEmpty else {
            throw .noSubject
        }
        do {
            let mask = try observation.generateScaledMaskForImage(forInstances: observation.allInstances, from: handler)
            return CIImage(cvPixelBuffer: mask)
        } catch {
            throw .failed
        }
    }
}

/// The simulator's stand-in for Vision's subject lifting, with no model. The colors along the
/// photo's edge are the background's (a floor, a table, a wall); every pixel of those colors that
/// joins the edge through more of them is background, and the rest is the item. It works on
/// photos of an item laid on a plain surface, like the test fixtures.
struct EdgeColorSubjectMasker: SubjectMasker {
    /// The mask is worked out on a copy this many pixels on its long edge, then scaled up.
    static let workingEdge = 256
    /// Colors are compared in steps of this many levels per channel (of 256).
    static let colorStep = 16

    func subjectMask(of image: CGImage) throws(BackgroundCleanupError) -> CIImage {
        let scale = Double(Self.workingEdge) / Double(max(image.width, image.height))
        let width = max(1, Int((Double(image.width) * scale).rounded()))
        let height = max(1, Int((Double(image.height) * scale).rounded()))
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let space = CGColorSpace(name: CGColorSpace.sRGB) else { throw .failed }
        let drawn = pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue,
            ) else { return false }
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { throw .failed }

        let background = Self.background(pixels, width: width, height: height)
        let subject = background.count { !$0 }
        let share = Double(subject) / Double(width * height)
        guard share > 0.01, share < 0.97 else { throw .noSubject }

        let mask = background.map { $0 ? UInt8(0) : UInt8(255) }
        let small = CIImage(
            bitmapData: Data(mask),
            bytesPerRow: width,
            size: CGSize(width: width, height: height),
            format: .L8,
            colorSpace: nil,
        )
        let extent = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        return small
            .transformed(by: CGAffineTransform(
                scaleX: CGFloat(image.width) / CGFloat(width),
                y: CGFloat(image.height) / CGFloat(height),
            ))
            .clampedToExtent()
            .applyingGaussianBlur(sigma: 1.5 / scale)
            .cropped(to: extent)
    }

    /// Which pixels are background: those of a color common along the edge (``EdgePalette``),
    /// flooded in from the edge.
    static func background(_ pixels: [UInt8], width: Int, height: Int) -> [Bool] {
        let palette = EdgePalette(pixels, width: width, height: height)
        var isBackground = [Bool](repeating: false, count: width * height)
        var stack = palette.edge.filter { palette.isBackground(pixel: $0) }
        for index in stack {
            isBackground[index] = true
        }
        while let index = stack.popLast() {
            let column = index % width
            let row = index / width
            let neighbors = [
                column > 0 ? index - 1 : nil,
                column < width - 1 ? index + 1 : nil,
                row > 0 ? index - width : nil,
                row < height - 1 ? index + width : nil,
            ]
            for case let neighbor? in neighbors where !isBackground[neighbor] && palette.isBackground(pixel: neighbor) {
                isBackground[neighbor] = true
                stack.append(neighbor)
            }
        }
        return isBackground
    }
}

/// The colors common along a photo's edge (in at least 1 in 500 edge pixels, so a stray speck
/// does not count), in steps of ``EdgeColorSubjectMasker/colorStep``.
private struct EdgePalette {
    /// One color step per channel.
    struct Bin: Hashable {
        let red: Int
        let green: Int
        let blue: Int
    }

    let edge: [Int]
    private let pixels: [UInt8]
    private let common: Set<Bin>
    private static let levels = 256 / EdgeColorSubjectMasker.colorStep

    init(_ pixels: [UInt8], width: Int, height: Int) {
        self.pixels = pixels
        var edge: [Int] = []
        for column in 0 ..< width {
            edge.append(column)
            edge.append((height - 1) * width + column)
        }
        for row in 1 ..< max(height - 1, 1) {
            edge.append(row * width)
            edge.append(row * width + width - 1)
        }
        self.edge = edge
        var counts: [Bin: Int] = [:]
        for index in edge {
            counts[Self.bin(of: index, in: pixels), default: 0] += 1
        }
        let threshold = max(2, edge.count / 500)
        common = Set(counts.filter { $0.value >= threshold }.keys)
    }

    private static func bin(of index: Int, in pixels: [UInt8]) -> Bin {
        let step = EdgeColorSubjectMasker.colorStep
        return Bin(
            red: Int(pixels[index * 4]) / step,
            green: Int(pixels[index * 4 + 1]) / step,
            blue: Int(pixels[index * 4 + 2]) / step,
        )
    }

    /// Whether the pixel's color, or one a step away in any channel, is common along the edge.
    func isBackground(pixel index: Int) -> Bool {
        let color = Self.bin(of: index, in: pixels)
        let steps = -1 ... 1
        let range = 0 ..< Self.levels
        for red in steps.map({ color.red + $0 }) where range.contains(red) {
            for green in steps.map({ color.green + $0 }) where range.contains(green) {
                for blue in steps.map({ color.blue + $0 }) where range.contains(blue) {
                    if common.contains(Bin(red: red, green: green, blue: blue)) {
                        return true
                    }
                }
            }
        }
        return false
    }
}
