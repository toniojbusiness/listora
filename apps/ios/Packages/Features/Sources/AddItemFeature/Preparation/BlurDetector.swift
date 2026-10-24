import CoreGraphics

/// Estimates how sharp a photo is, so capture can warn about a blurry shot before the seller
/// moves on.
///
/// The score is the variance of the Laplacian of a grayscale copy at most ``sampleLongEdge``
/// pixels long: sharp edges give large second derivatives, blur flattens them. It is a warning,
/// never a block, because a plain, evenly lit surface can score low while sharp.
enum BlurDetector {
    /// Large enough that a blur a buyer would notice survives the downscale; smaller samples hide
    /// it (a 3 px blur at 1600 px is under 1 px at 512 px).
    static let sampleLongEdge = 1024
    /// Scores below this look blurry. Calibrated on the tag fixtures at this sample size: sharp
    /// photos score 114 to 268, the same photos blurred with a Gaussian of sigma 3 score 7 to 24
    /// (see `BlurDetectorTests`).
    static let blurryBelow = 50.0

    static func sharpness(of image: CGImage) -> Double {
        let scale = min(1, Double(sampleLongEdge) / Double(max(image.width, image.height)))
        let width = max(3, Int((Double(image.width) * scale).rounded()))
        let height = max(3, Int((Double(image.height) * scale).rounded()))
        var pixels = [UInt8](repeating: 0, count: width * height)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width,
                space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue,
            ) else { return false }
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return 0 }
        return laplacianVariance(pixels, width: width, height: height)
    }

    /// Variance of the 4-neighbor Laplacian over the interior pixels.
    static func laplacianVariance(_ pixels: [UInt8], width: Int, height: Int) -> Double {
        var sum = 0.0
        var sumOfSquares = 0.0
        var count = 0.0
        for row in 1 ..< height - 1 {
            for column in 1 ..< width - 1 {
                let index = row * width + column
                let laplacian = 4 * Double(pixels[index])
                    - Double(pixels[index - 1]) - Double(pixels[index + 1])
                    - Double(pixels[index - width]) - Double(pixels[index + width])
                sum += laplacian
                sumOfSquares += laplacian * laplacian
                count += 1
            }
        }
        guard count > 0 else { return 0 }
        let mean = sum / count
        return sumOfSquares / count - mean * mean
    }
}
