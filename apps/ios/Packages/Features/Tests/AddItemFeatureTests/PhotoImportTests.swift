import Foundation
import Testing
@testable import AddItemFeature

/// Library picks that do not all load are reported, never dropped silently.
@MainActor
struct PhotoImportTests {
    @Test
    func `photos that did not load are counted, and Try again loads only those, in the order picked`() async {
        var unavailable: Set = [1, 3]
        var picked = PickedPhotos([0, 1, 2, 3])
        await picked.load { unavailable.contains($0) ? nil : Data([UInt8($0)]) }

        #expect(picked.loaded == [Data([0]), Data([2])])
        #expect(picked.problem == "2 photos could not be loaded from iCloud.")

        unavailable = [3]
        var tried: [Int] = []
        await picked.load { item in
            tried.append(item)
            return unavailable.contains(item) ? nil : Data([UInt8(item)])
        }

        #expect(tried == [1, 3])
        #expect(picked.loaded == [Data([0]), Data([1]), Data([2])])
        #expect(picked.problem == "1 photo could not be loaded from iCloud.")
    }

    @Test
    func `default roles go to the photos that loaded, in the order picked`() async throws {
        let harness = try UploadHarness()
        let model = AddItemModel(store: harness.store, uploader: harness.uploader, activity: harness.activity)
        var picked = PickedPhotos([1, 2, 3, 4])
        await picked.load { $0 == 2 ? nil : TestImages.jpeg(width: 64, height: 48, seed: UInt64($0)) }

        let id = try #require(await model.addPhotos(picked.loaded))

        #expect(try harness.draft(id)?.photos.map(\.role) == [.front, .back, .detail])
        #expect(picked.problem == "1 photo could not be loaded from iCloud.")
        await harness.stop()
    }
}
