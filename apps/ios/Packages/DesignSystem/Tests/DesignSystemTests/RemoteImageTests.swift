import Foundation
import Testing
import UIKit
@testable import DesignSystem

struct RemoteImageTests {
    @Test
    func `decodes at the smallest long edge that still fills the frame`() {
        let fill = RemoteImageLoader.fillLongEdge
        // A 4:3 thumbnail in a 216 px square fills it at 288 x 216.
        #expect(fill(400, 300, 216, 216) == 288)
        // A portrait listing photo across a wide frame fills it by its width.
        #expect(fill(1200, 1600, 1170, 600) == 1560)
        // Never larger than the photo itself.
        #expect(fill(400, 300, 1170, 1170) == 400)
    }

    @Test
    func `loads a photo once at its display size and serves it from memory after`() async throws {
        let url = try Self.writeJPEG(width: 400, height: 300)
        defer { try? FileManager.default.removeItem(at: url) }
        let loader = RemoteImageLoader(configuration: .ephemeral)
        let request = RemoteImageRequest(url: url, pixelWidth: 216, pixelHeight: 216)
        #expect(loader.cachedImage(for: request) == nil)

        let image = try #require(await loader.image(for: request))
        #expect(image.cgImage?.width == 288)
        #expect(image.cgImage?.height == 216)

        // The file is gone, so only the memory cache can answer.
        try FileManager.default.removeItem(at: url)
        #expect(loader.cachedImage(for: request) === image)
        #expect(await loader.image(for: request) === image)
    }

    @Test
    func `a photo that cannot be read leaves the placeholder`() async throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).jpg")
        try Data("not an image".utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let loader = RemoteImageLoader(configuration: .ephemeral)
        #expect(await loader.image(for: RemoteImageRequest(url: url, pixelWidth: 100, pixelHeight: 100)) == nil)
    }

    private static func writeJPEG(width: Int, height: Int) throws -> URL {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            return format
        }())
        let image = renderer.image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
        let url = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).jpg")
        try #require(image.jpegData(compressionQuality: 0.8)).write(to: url)
        return url
    }
}
