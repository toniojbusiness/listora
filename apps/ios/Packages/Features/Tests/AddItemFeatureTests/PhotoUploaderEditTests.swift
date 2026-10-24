import Foundation
import Testing
@testable import AddItemFeature

/// Edits after upload reach the server: role changes, removals, re-uploads, deleted drafts.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct PhotoUploaderEditTests {
    @Test
    func `role and order changes after upload are sent to the server`() async throws {
        let harness = try UploadHarness()
        let draft = try harness.createDraft(roles: [.front, .back, .detail])
        await harness.start()
        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        let photos = try #require(try harness.draft(draft.id)).photos

        try harness.store.setRole(.flaw, of: photos[2].id)
        try harness.store.movePhoto(photos[2].id, to: 0)
        await harness.uploader.wake()

        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        let item = try #require(harness.server.items.first)
        #expect(item.photos.map(\.role) == ["flaw", "front", "back"])
        #expect(harness.server.requests("PATCH", "/v1/items/").count == 1)
        await harness.stop()
    }

    @Test
    func `a removed photo is deleted on the server`() async throws {
        let harness = try UploadHarness()
        let draft = try harness.createDraft(roles: [.front, .back])
        await harness.start()
        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        let removed = try #require(try harness.draft(draft.id)?.photos.first)

        try harness.store.deletePhoto(removed.id)
        await harness.uploader.wake()

        #expect(try await eventually { harness.server.items.first?.photos.count == 1 })
        #expect(try await eventually { try harness.store.uploadSnapshot().deletions.isEmpty })
        #expect(harness.server.items.first?.photos.first?.role == "back")
        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        await harness.stop()
    }

    @Test
    func `a removed photo whose attach answer was lost is found by its SHA-256 once the server forgot the key`(
    ) async throws {
        let harness = try UploadHarness()
        let draft = try harness.createDraft(roles: [.front, .back])
        await harness.start()
        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        let removed = try #require(try harness.draft(draft.id)?.photos.last)
        // The attach reached the server but its answer did not reach the phone, and a day passed.
        try harness.store.updatePhoto(removed.id) { $0.serverPhotoID = nil }
        harness.server.forgetIdempotencyKeys()

        try harness.store.deletePhoto(removed.id)
        await harness.uploader.wake()

        #expect(try await eventually { try harness.store.uploadSnapshot().deletions.isEmpty })
        #expect(harness.server.items.first?.photos.map(\.role) == ["front"])
        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        await harness.stop()
    }

    @Test
    func `cropping a photo of an item with the most photos replaces it without hitting the limit`() async throws {
        let harness = try UploadHarness()
        let draft = try harness.createDraft(roles: Array(repeating: .detail, count: DraftStore.maxPhotosPerDraft))
        await harness.start()
        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        let photo = try #require(try harness.draft(draft.id)?.photos.first)

        let replaced = try harness.store.replaceImage(of: photo.id, with: TestImages.prepared(seed: 99))
        await harness.uploader.wake()

        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        let item = try #require(harness.server.items.first)
        #expect(item.photos.count == DraftStore.maxPhotosPerDraft)
        #expect(item.photos.first?.sha256 == replaced.new.sha256)
        #expect(!item.photos.contains { $0.id == photo.serverPhotoID })
        await harness.stop()
    }

    @Test
    func `a photo changed to a tag after upload is uploaded again with its tag reads`() async throws {
        let harness = try UploadHarness()
        let draft = try harness.createDraft(roles: [.front, .detail])
        await harness.start()
        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        let photo = try #require(try harness.draft(draft.id)?.photos.last)

        try harness.store.setRole(.tag, of: photo.id)
        await harness.uploader.wake()

        #expect(try await eventually {
            try harness.isFullyUploaded(draft.id) && harness.server.items.first?.photos.count == 2
                && harness.server.items.first?.photos.last?.role == "tag"
        })
        let item = try #require(harness.server.items.first)
        #expect(item.photos.map(\.role) == ["front", "tag"])
        #expect(item.photos.last?.ocrLines == ["ACME", "RN 12345"])
        #expect(!item.photos.contains { $0.id == photo.serverPhotoID })
        await harness.stop()
    }

    @Test
    func `deleting a draft deletes its server item`() async throws {
        let harness = try UploadHarness()
        let draft = try harness.createDraft(roles: [.front])
        await harness.start()
        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })

        try harness.store.deleteDraft(draft.id)
        await harness.uploader.wake()

        #expect(try await eventually { harness.server.items.isEmpty })
        #expect(try await eventually { try harness.store.uploadSnapshot().deletions.isEmpty })
        await harness.stop()
    }

    @Test
    func `a draft deleted before its item's answer arrived still has its item deleted`() async throws {
        let harness = try UploadHarness()
        // The item is created, but the answer is lost: the queue retries later.
        harness.server.fail({ $0.path == "/v1/items" }, with: .error(503, code: "service_unavailable", retryable: true))
        let draft = try harness.createDraft(roles: [.front])
        await harness.start()
        #expect(try await eventually { try harness.draft(draft.id)?.record.retry.attempt == 1 })
        #expect(try harness.draft(draft.id)?.record.createItemSent == true)

        try harness.store.deleteDraft(draft.id)
        await harness.uploader.wake()

        // The deletion replays the create with the same key to learn the item, then deletes it.
        #expect(try await eventually { try harness.store.uploadSnapshot().deletions.isEmpty })
        #expect(harness.server.items.isEmpty)
        let creates = harness.server.requests.filter { $0.method == "POST" && $0.path == "/v1/items" }
        let keys = Set(creates.compactMap { $0.header("Idempotency-Key") })
        #expect(keys == [draft.createItemKey])
        await harness.stop()
    }
}
