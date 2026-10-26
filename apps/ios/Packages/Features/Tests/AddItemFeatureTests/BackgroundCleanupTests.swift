import CoreGraphics
import Foundation
import ImageIO
import Testing
@testable import AddItemFeature

/// One-tap background cleanup: the item is lifted onto the plain backdrop on the phone (in the
/// simulator by the stand-in masker, since Vision's models cannot run there), the original stays
/// on the iPhone, and undo puts it back byte for byte.
struct BackgroundCleanupTests {
    struct Pixel {
        let red: Int
        let green: Int
        let blue: Int
    }

    /// The sRGB color of the pixel at `x`, `y` (fractions of the width and height, from the top
    /// left).
    private func pixel(_ data: Data, x: Double, y: Double) throws -> Pixel {
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        var bytes = [UInt8](repeating: 0, count: 4)
        let space = try #require(CGColorSpace(name: CGColorSpace.sRGB))
        let left = Double(image.width) * x
        let bottom = Double(image.height) * (1 - y)
        let drawn = bytes.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue,
            ) else { return false }
            context.draw(
                image,
                in: CGRect(x: -left, y: -bottom, width: Double(image.width), height: Double(image.height)),
            )
            return true
        }
        #expect(drawn)
        return Pixel(red: Int(bytes[0]), green: Int(bytes[1]), blue: Int(bytes[2]))
    }

    private func isBackdrop(_ color: Pixel) -> Bool {
        abs(color.red - 247) <= 6 && abs(color.green - 247) <= 6 && abs(color.blue - 245) <= 6
    }

    @Test
    func `lifts the item onto the plain backdrop and keeps it where it was`() throws {
        let photo = try PhotoPreparation.prepare(Fixture.data("jeans-on-wood.jpg"))
        let before = try pixel(photo.data, x: 0.05, y: 0.05)
        #expect(!isBackdrop(before), "the corner starts as wood: \(before)")

        let cleaned = try BackgroundCleanup.clean(photo.data)

        #expect(cleaned.width == photo.width)
        #expect(cleaned.height == photo.height)
        #expect(cleaned.sha256 != photo.sha256)
        for corner in [(0.04, 0.04), (0.96, 0.04), (0.04, 0.96), (0.96, 0.96)] {
            let color = try pixel(cleaned.data, x: corner.0, y: corner.1)
            #expect(isBackdrop(color), "corner \(corner) is \(color)")
        }
        // The jeans' blue stays in the middle of the frame.
        let jeans = try pixel(cleaned.data, x: 0.48, y: 0.45)
        #expect(jeans.blue > jeans.red + 40, "the jeans are still blue: \(jeans)")
        #expect(TestImages.properties(of: cleaned.data)[kCGImagePropertyGPSDictionary] == nil)
    }

    @Test
    func `says so when there is no item to lift, and changes nothing`() throws {
        let flat = TestImages.solid(width: 400, height: 400)
        #expect(throws: BackgroundCleanupError.noSubject) {
            try BackgroundCleanup.clean(flat)
        }
        #expect(PhotoEditFailure(BackgroundCleanupError.noSubject).message
            == "Listora couldn't find the item in this photo. Try a photo with the item clearly in front.")
    }

    #if !targetEnvironment(simulator)
        @Test
        func `on a device, Vision lifts the jeans`() throws {
            let photo = try PhotoPreparation.prepare(Fixture.data("jeans-on-wood.jpg"))
            let cleaned = try BackgroundCleanup.clean(photo.data, masker: VisionSubjectMasker())
            #expect(try isBackdrop(pixel(cleaned.data, x: 0.04, y: 0.04)))
        }
    #endif

    @Test
    func `an unreadable photo fails without crashing`() {
        #expect(throws: BackgroundCleanupError.failed) {
            try BackgroundCleanup.clean(Data("not a photo".utf8))
        }
    }
}

struct BackgroundCleanupStoreTests {
    private let directory: TemporaryDirectory
    private let store: DraftStore

    init() throws {
        directory = try TemporaryDirectory()
        store = try DraftStore(database: DraftDatabase(directory: directory.url))
    }

    private func exists(_ url: URL?) -> Bool {
        url.map { FileManager.default.fileExists(atPath: $0.path(percentEncoded: false)) } ?? false
    }

    @Test
    func `a cleanup replaces the photo, keeps the original on the iPhone, and undo restores it exactly`() throws {
        let original = try TestImages.prepared(seed: 1)
        let draft = try store.createDraft(photos: [(original, .front), (TestImages.prepared(seed: 2), .back)])
        let photo = try #require(try store.draft(id: draft.id)?.photos.first)

        let cleaned = try store.cleanBackground(of: photo.id, with: TestImages.prepared(seed: 50)).new

        let afterCleanup = try #require(try store.draft(id: draft.id)).photos
        #expect(afterCleanup.first?.id == cleaned.id)
        #expect(afterCleanup.first?.role == .front)
        #expect(afterCleanup.first?.position == 0)
        #expect(cleaned.originalFileName == photo.fileName)
        #expect(exists(store.database.originalFileURL(for: cleaned)))
        #expect(try store.photo(id: photo.id) == nil)

        let restored = try store.restoreOriginal(of: cleaned.id).new

        #expect(restored.originalFileName == nil)
        #expect(restored.sha256 == original.sha256)
        #expect(try store.imageData(of: restored) == original.data)
        #expect(!exists(store.fileURL(for: cleaned)), "the cleaned image is gone")
        #expect(!exists(store.database.originalFileURL(for: cleaned)), "the original moved into the photo")
        #expect(try store.draft(id: draft.id)?.photos.map(\.id) == [restored.id, afterCleanup[1].id])
    }

    @Test
    func `cleaning twice keeps the first original, and a crop ends the undo`() throws {
        let draft = try store.createDraft(photos: [(TestImages.prepared(seed: 1), .front)])
        let photo = try #require(try store.draft(id: draft.id)?.photos.first)
        let once = try store.cleanBackground(of: photo.id, with: TestImages.prepared(seed: 50)).new
        let twice = try store.cleanBackground(of: once.id, with: TestImages.prepared(seed: 51)).new

        #expect(twice.originalFileName == photo.fileName)
        #expect(!exists(store.fileURL(for: once)))

        let cropped = try store.replaceImage(of: twice.id, with: TestImages.prepared(seed: 52)).new

        #expect(cropped.originalFileName == nil)
        #expect(!exists(store.database.originalFileURL(for: twice)))
        #expect(throws: DraftStoreError.notFound) { try store.restoreOriginal(of: cropped.id) }
    }

    @Test
    func `removing a cleaned photo or its draft removes its original too`() throws {
        let draft = try store.createDraft(photos: [
            (TestImages.prepared(seed: 1), .front),
            (TestImages.prepared(seed: 2), .back),
        ])
        let photos = try #require(try store.draft(id: draft.id)).photos
        let first = try store.cleanBackground(of: photos[0].id, with: TestImages.prepared(seed: 50)).new
        let second = try store.cleanBackground(of: photos[1].id, with: TestImages.prepared(seed: 51)).new

        try store.deletePhoto(first.id)
        #expect(!exists(store.database.originalFileURL(for: first)))

        try store.deleteDraft(draft.id)
        #expect(!exists(store.database.originalFileURL(for: second)))
        #expect(!exists(store.fileURL(for: second)))
    }

    @Test
    func `a photo that was already uploaded uploads its cleaned image as a new photo`() throws {
        let draft = try store.createDraft(photos: [(TestImages.prepared(seed: 1), .front)])
        let photo = try #require(try store.draft(id: draft.id)?.photos.first)
        try store.updateDraft(draft.id) { $0.serverItemID = "item-1" }
        try store.updatePhoto(photo.id) { $0.serverPhotoID = "server-photo-1"; $0.step = .done }

        let cleaned = try store.cleanBackground(of: photo.id, with: TestImages.prepared(seed: 50)).new

        #expect(cleaned.step == .session)
        #expect(try store.uploadSnapshot().deletions.map(\.serverPhotoID) == ["server-photo-1"])
    }
}
