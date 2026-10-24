import CoreImage
import CryptoKit
import Foundation
import ImageIO
import Testing
@testable import AddItemFeature

struct PhotoPreparationTests {
    @Test
    func `strips GPS and every other metadata block from the upload`() throws {
        let original = TestImages.jpeg(width: 800, height: 600, gps: true)
        // The input really carries a location, so the test would catch a pipeline that copies it.
        #expect(TestImages.properties(of: original)[kCGImagePropertyGPSDictionary] != nil)

        let prepared = try PhotoPreparation.prepare(original)

        let properties = TestImages.properties(of: prepared.data)
        #expect(properties[kCGImagePropertyGPSDictionary] == nil)
        let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any]
        #expect(exif?[kCGImagePropertyExifLensModel] == nil)
        #expect(properties[kCGImagePropertyTIFFDictionary] == nil)
        // No trace of the source's metadata is left in the bytes.
        #expect(original.range(of: Data("Test lens".utf8)) != nil)
        #expect(prepared.data.range(of: Data("Test lens".utf8)) == nil)
    }

    @Test
    func `resizes a large camera photo to at most 2048 px on the long edge`() throws {
        let original = try Fixture.data("neck-label-size-tab-m.jpg")

        let prepared = try PhotoPreparation.prepare(original)

        #expect(max(prepared.width, prepared.height) == PhotoPreparation.maxLongEdge)
        #expect(prepared.width == 1536)
        #expect(prepared.height == 2048)
        let properties = TestImages.properties(of: prepared.data)
        #expect(properties[kCGImagePropertyPixelWidth] as? Int == 1536)
        #expect(properties[kCGImagePropertyPixelHeight] as? Int == 2048)
    }

    @Test
    func `keeps small photos at their size`() throws {
        let prepared = try PhotoPreparation.prepare(TestImages.jpeg(width: 640, height: 480))

        #expect(prepared.width == 640)
        #expect(prepared.height == 480)
    }

    @Test
    func `applies the EXIF orientation, so the upload is upright with no orientation tag`() throws {
        // Orientation 6: the camera held in portrait, sensor data stored landscape.
        let original = TestImages.jpeg(width: 400, height: 300, orientation: 6)

        let prepared = try PhotoPreparation.prepare(original)

        #expect(prepared.width == 300)
        #expect(prepared.height == 400)
        let orientation = TestImages.properties(of: prepared.data)[kCGImagePropertyOrientation] as? Int
        #expect(orientation == nil || orientation == 1)
    }

    @Test
    func `encodes JPEG and declares the exact size and SHA-256 of the bytes`() throws {
        let prepared = try PhotoPreparation.prepare(TestImages.jpeg(width: 320, height: 240))

        #expect(prepared.data.starts(with: [0xFF, 0xD8, 0xFF]))
        let digest = SHA256.hash(data: prepared.data).map { String(format: "%02x", $0) }.joined()
        #expect(prepared.sha256 == digest)
        #expect(prepared.sha256.count == 64)
    }

    @Test
    func `converts a PNG to JPEG`() throws {
        let image = TestImages.pattern(width: 120, height: 80)
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        CGImageDestinationFinalize(destination)

        let prepared = try PhotoPreparation.prepare(data as Data)

        #expect(prepared.data.starts(with: [0xFF, 0xD8, 0xFF]))
        #expect(prepared.width == 120)
    }

    @Test
    func `rejects data that is not an image`() {
        #expect(throws: PhotoPreparationError.unreadableImage) {
            try PhotoPreparation.prepare(Data("not an image".utf8))
        }
    }

    @Test
    func `crops to a normalized rectangle of the upright photo`() throws {
        let prepared = try PhotoPreparation.prepare(TestImages.jpeg(width: 400, height: 200))

        let cropped = try PhotoPreparation.crop(prepared.data, to: CGRect(x: 0.25, y: 0, width: 0.5, height: 1))

        #expect(cropped.width == 200)
        #expect(cropped.height == 200)
        #expect(cropped.sha256 != prepared.sha256)
        #expect(TestImages.properties(of: cropped.data)[kCGImagePropertyGPSDictionary] == nil)
    }
}

struct BlurDetectorTests {
    @Test(arguments: ["care-label.jpg", "hang-tag-ean-13.jpg", "neck-label-size-tab-m.jpg"])
    func `sharp photos pass and the same photos blurred are flagged`(_ name: String) throws {
        let sharp = try PhotoPreparation.prepare(Fixture.data(name))
        let blurred = try PhotoPreparation.prepare(Fixture.blurred(name, radius: 3))

        #expect(!sharp.looksBlurry, "\(name) scored \(sharp.sharpness)")
        #expect(blurred.looksBlurry, "\(name) blurred scored \(blurred.sharpness)")
        #expect(sharp.sharpness > 2 * blurred.sharpness)
    }

    @Test
    func `a flat image has no sharpness`() {
        let flat = [UInt8](repeating: 128, count: 100 * 100)
        #expect(BlurDetector.laplacianVariance(flat, width: 100, height: 100) == 0)
    }
}

enum Fixture {
    static func url(_ name: String) throws -> URL {
        try #require(Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Fixtures"))
    }

    static func data(_ name: String) throws -> Data {
        try Data(contentsOf: url(name))
    }

    /// The fixture with a Gaussian blur, as a camera out of focus or shaken would give it.
    static func blurred(_ name: String, radius: Double) throws -> Data {
        let image = try #require(CIImage(contentsOf: url(name)))
        let blurred = image.clampedToExtent().applyingGaussianBlur(sigma: radius).cropped(to: image.extent)
        let context = CIContext()
        let cgImage = try #require(context.createCGImage(blurred, from: image.extent))
        return TestImages.encode(cgImage)
    }
}
