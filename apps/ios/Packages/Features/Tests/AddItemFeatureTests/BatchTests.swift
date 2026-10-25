import Core
import Foundation
import Testing
@testable import AddItemFeature

/// Signals as the grouper sees them: a garment's print at (`x`, 0), or a tag close-up.
private func garment(_ x: Float) -> ShotSignals {
    ShotSignals(featurePrint: [x, 0, 0], tagLikelihood: 0)
}

private let tag = ShotSignals(featurePrint: [9, 9, 9], tagLikelihood: 1)

extension DraftStore {
    /// Adds photos to a batch with their signals already read, a few seconds apart.
    @discardableResult
    func addShots(_ signals: [ShotSignals], to batchID: String, seed: UInt64 = 1) throws -> [BatchShotRecord] {
        let start = Date(timeIntervalSinceReferenceDate: 800_000_000)
        return try signals.enumerated().map { index, signals in
            let shot = try addShot(
                TestImages.prepared(seed: seed + UInt64(index)),
                to: batchID,
                capturedAt: start.addingTimeInterval(Double(index) * 5),
                startsNewItem: false,
            )
            try recordSignals(signals, of: shot.id)
            return shot
        }
    }
}

/// A haul of `items` items, front, back, and tag each, grouped and confirmed.
@discardableResult
private func confirmedHaul(_ store: DraftStore, items: Int = 3) throws -> (batch: BatchRecord, drafts: [DraftRecord]) {
    let batch = try store.createBatch()
    let signals = (0 ..< items).flatMap { item in [garment(Float(item) * 2), garment(Float(item) * 2 + 0.1), tag] }
    try store.addShots(signals, to: batch.id)
    try store.groupUngroupedShots(in: batch.id)
    return try (batch, store.confirmStacks(in: batch.id))
}

struct BatchStoreTests {
    private let directory: TemporaryDirectory
    private let store: DraftStore

    init() throws {
        directory = try TemporaryDirectory()
        store = try DraftStore(database: DraftDatabase(directory: directory.url))
    }

    @Test
    func `groups a haul's photos into one stack per item, in capture order`() throws {
        let batch = try store.createBatch()
        let shots = try store.addShots([garment(0), garment(0.1), tag, garment(2), garment(2.1), tag], to: batch.id)
        try store.groupUngroupedShots(in: batch.id)

        let grouped = try #require(try store.batch(id: batch.id))
        #expect(grouped.stacks.map { $0.shots.map(\.id) } == [Array(shots[0 ..< 3].map(\.id)), shots[3...].map(\.id)])
        #expect(grouped.ungrouped.isEmpty)
        #expect(grouped.reviewCount == 0)
    }

    @Test
    func `photos and their grouping survive reopening the database, as after a relaunch`() throws {
        let batch = try store.createBatch()
        try store.addShots([garment(0), garment(0.1)], to: batch.id)
        try store.groupUngroupedShots(in: batch.id)

        let reopened = try DraftStore(database: DraftDatabase(directory: directory.url))
        let saved = try #require(try reopened.batch(id: batch.id))
        #expect(saved.stacks.count == 1)
        #expect(saved.stacks[0].shots.map(\.signals) == [garment(0), garment(0.1)])
        for shot in saved.stacks[0].shots {
            #expect(FileManager.default.fileExists(atPath: reopened.fileURL(for: shot).path(percentEncoded: false)))
        }
    }

    @Test
    func `photos taken later are grouped after the stacks the seller already checked, which never change`() throws {
        let batch = try store.createBatch()
        try store.addShots([garment(0), garment(0.1)], to: batch.id)
        try store.groupUngroupedShots(in: batch.id)
        let first = try #require(try store.batch(id: batch.id)?.stacks.first)

        // More of the haul, after Keep shooting: it looks like the first item, but it is new.
        let more = try store.addShot(
            TestImages.prepared(seed: 9),
            to: batch.id,
            capturedAt: Date(),
            startsNewItem: true,
        )
        try store.recordSignals(garment(0.05), of: more.id)
        try store.groupUngroupedShots(in: batch.id)

        let grouped = try #require(try store.batch(id: batch.id))
        #expect(grouped.stacks.count == 2)
        #expect(grouped.stacks[0] == first)
        #expect(grouped.stacks[1].shots.map(\.id) == [more.id])
    }

    @Test
    func `the seller splits, moves, and merges, and every stack stays numbered without gaps`() throws {
        let batch = try store.createBatch()
        let shots = try store.addShots([garment(0), garment(0.1), garment(0.2), garment(0.3)], to: batch.id)
        try store.groupUngroupedShots(in: batch.id)
        #expect(try store.batch(id: batch.id)?.stacks.count == 1)

        try store.split(at: shots[2].id)
        var grouped = try #require(try store.batch(id: batch.id))
        #expect(grouped.stacks.map { $0.shots.map(\.id) } == [[shots[0].id, shots[1].id], [shots[2].id, shots[3].id]])
        #expect(grouped.stacks.map(\.record.position) == [0, 1])

        try store.moveShot(shots[1].id, toStack: grouped.stacks[1].id)
        grouped = try #require(try store.batch(id: batch.id))
        #expect(grouped.stacks[1].shots.map(\.id) == [shots[2].id, shots[3].id, shots[1].id])
        #expect(grouped.stacks[1].shots.map(\.stackPosition) == [0, 1, 2])

        try store.moveShotToNewItem(shots[0].id)
        grouped = try #require(try store.batch(id: batch.id))
        // The first stack lost its only photo and is gone; the new one takes its place.
        #expect(grouped.stacks.count == 2)
        #expect(grouped.stacks.map(\.record.position) == [0, 1])

        try store.mergeIntoPrevious(grouped.stacks[1].id)
        grouped = try #require(try store.batch(id: batch.id))
        #expect(grouped.stacks.count == 1)
        #expect(Set(grouped.stacks[0].shots.map(\.id)) == Set(shots.map(\.id)))
        #expect(grouped.stacks[0].shots.map(\.stackPosition) == [0, 1, 2, 3])
    }

    @Test
    func `a close call is counted until the seller decides it`() throws {
        let batch = try store.createBatch()
        // A photo whose signals could not be read joins by the shooting pattern, and asks.
        let shots = try store.addShots([garment(0), garment(0.1)], to: batch.id)
        try store.recordSignals(nil, of: shots[1].id)
        // A long pause, then a photo that looks somewhat different: split, but a close call.
        let later = try store.addShot(
            TestImages.prepared(seed: 7),
            to: batch.id,
            capturedAt: shots[1].capturedAt.addingTimeInterval(30),
            startsNewItem: false,
        )
        try store.recordSignals(garment(0.55), of: later.id)
        try store.groupUngroupedShots(in: batch.id)
        var grouped = try #require(try store.batch(id: batch.id))
        #expect(grouped.stacks.map { $0.shots.map(\.id) } == [[shots[0].id, shots[1].id], [later.id]])
        #expect(grouped.stacks[0].shots[1].uncertain)
        #expect(grouped.stacks[1].record.startNeedsReview)
        #expect(grouped.reviewCount == 2)

        try store.keepTogether(shots[1].id)
        try store.keepApart(grouped.stacks[1].id)
        grouped = try #require(try store.batch(id: batch.id))
        #expect(grouped.reviewCount == 0)
        #expect(grouped.stacks.count == 2)
    }

    @Test
    func `confirming makes one draft per stack with roles from the photos, keeping their files`() throws {
        let (batch, drafts) = try confirmedHaul(store)

        #expect(drafts.map(\.batchPosition) == [0, 1, 2])
        #expect(drafts.allSatisfy { $0.batchID == batch.id })
        let confirmed = try #require(try store.batch(id: batch.id))
        #expect(confirmed.stacks.isEmpty && confirmed.ungrouped.isEmpty)
        #expect(confirmed.record.nextPosition == 3)
        for draft in confirmed.drafts {
            #expect(draft.photos.map(\.role) == [.front, .back, .tag])
            #expect(draft.photos.map(\.tagReadState) == [.notNeeded, .notNeeded, .pending])
            for photo in draft.photos {
                #expect(try store.imageData(of: photo).count == photo.byteSize)
            }
        }
        // The store keeps them with the other drafts; Add Item lists them under their batch.
        #expect(try store.drafts().count == 3)
    }

    @Test
    func `refuses to confirm an item with more photos than the API allows`() throws {
        let batch = try store.createBatch()
        try store.addShots(Array(repeating: garment(0), count: DraftStore.maxPhotosPerDraft + 1), to: batch.id)
        try store.groupUngroupedShots(in: batch.id)
        #expect(throws: DraftStoreError.tooManyPhotos) { try store.confirmStacks(in: batch.id) }
        #expect(try store.batch(id: batch.id)?.drafts.isEmpty == true)
    }

    @Test
    func `a finished batch leaves this iPhone only once its interaction is on the server`() throws {
        let (batch, drafts) = try confirmedHaul(store, items: 1)
        try store.setInteraction(
            BatchInteraction(batch: .init(activeMs: 1, waitingMs: 0, taps: 1), items: []),
            of: batch.id,
        )
        try store.completeDraft(drafts[0].id)
        #expect(try !store.removeBatchIfFinished(batch.id))
        try store.updateBatch(batch.id) { $0.interactionSynced = true }
        #expect(try store.removeBatchIfFinished(batch.id))
        #expect(try store.batch(id: batch.id) == nil)
    }

    @Test
    func `deleting a batch deletes its photos, drafts, and the server items the drafts may have`() throws {
        let (batch, drafts) = try confirmedHaul(store, items: 2)
        try store.updateBatch(batch.id) { $0.serverBatchID = "server-batch" }
        try store.updateDraft(drafts[0].id) { $0.createItemSent = true }
        try store.updateDraft(drafts[1].id) { record in
            record.createItemSent = true
            record.serverItemID = "item-2"
        }
        let files = try #require(try store.batch(id: batch.id)).drafts.flatMap(\.photos).map(store.fileURL(for:))

        try store.deleteBatch(batch.id)

        #expect(try store.batch(id: batch.id) == nil)
        for file in files {
            #expect(!FileManager.default.fileExists(atPath: file.path(percentEncoded: false)))
        }
        let deletions = try store.uploadSnapshot().deletions
        // The item whose answer was lost is found again by its place in the batch.
        #expect(deletions
            .contains { $0.serverBatchID == "server-batch" && $0.batchPosition == 0 && $0.serverItemID == nil })
        #expect(deletions.contains { $0.serverItemID == "item-2" && $0.serverBatchID == nil })
    }

    @Test
    func `roles: tag-like photos are tags, then front, back, and details`() {
        func shot(_ signals: ShotSignals?) -> BatchShotRecord {
            var record = BatchShotRecord.new(
                batchID: "b",
                sequence: 0,
                photo: PreparedPhoto(data: Data(), width: 1, height: 1, sha256: "", sharpness: 100),
                capturedAt: Date(),
                startsNewItem: false,
            )
            record.signals = signals
            return record
        }
        let roles = DraftStore.roles(for: [shot(garment(0)), shot(tag), shot(garment(0)), shot(nil), shot(garment(0))])
        #expect(roles == [.front, .tag, .back, .detail, .detail])
    }
}

/// The upload queue's batch steps against the fake server.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct BatchUploadTests {
    private func fullyUploadedAndSubmitted(_ harness: UploadHarness, _ drafts: [DraftRecord]) throws -> Bool {
        try drafts.allSatisfy { draft in
            guard let saved = try harness.draft(draft.id) else { return false }
            return try harness.isFullyUploaded(draft.id)
                && saved.record.submittedPhotoIDs == saved.photos.compactMap(\.serverPhotoID).sorted()
        }
    }

    @Test
    func `a confirmed haul becomes one server batch with an item per position, each submitted once uploaded`(
    ) async throws {
        let harness = try UploadHarness()
        let (batch, drafts) = try confirmedHaul(harness.store)
        await harness.start()

        #expect(try await eventually { try fullyUploadedAndSubmitted(harness, drafts) })
        let server = try #require(harness.server.batches.first)
        #expect(harness.server.batches.count == 1)
        #expect(try harness.store.batch(id: batch.id)?.record.serverBatchID == server.id)
        #expect(server.positions.keys.sorted() == [0, 1, 2])
        // Every item has its three photos, front, back, then the tag read on the device.
        for draft in drafts {
            let saved = try #require(try harness.draft(draft.id))
            let item = try #require(harness.server.items.first { $0.id == saved.record.serverItemID })
            #expect(item.photos.map(\.role) == ["front", "back", "tag"])
            #expect(server.positions[draft.batchPosition ?? -1] == item.id)
            #expect(server.submitted[item.id] == 3)
        }
        #expect(server.submits == 3)
        #expect(harness.server.requests("POST", "/v1/items").filter { $0.path == "/v1/items" }.isEmpty)
        #expect(harness.server.requests("POST", "/v1/item-batches").filter { $0.path == "/v1/item-batches" }.count == 1)
        await harness.stop()
    }

    @Test
    func `a batch draft whose photos change is submitted again with its new photos`() async throws {
        let harness = try UploadHarness()
        let (_, drafts) = try confirmedHaul(harness.store, items: 1)
        await harness.start()
        #expect(try await eventually { try fullyUploadedAndSubmitted(harness, drafts) })

        let photo = try #require(try harness.draft(drafts[0].id)?.photos.last)
        try harness.store.deletePhoto(photo.id)
        await harness.uploader.wake()

        #expect(try await eventually {
            try harness.server.batches.first?.submits == 2 && fullyUploadedAndSubmitted(harness, drafts)
        })
        let itemID = try #require(try harness.draft(drafts[0].id)?.record.serverItemID)
        #expect(harness.server.batches.first?.submitted[itemID] == 2)
        await harness.stop()
    }

    @Test
    func `a failed add is retried with its key and makes one item`() async throws {
        let harness = try UploadHarness()
        harness.server.fail(
            { $0.method == "POST" && $0.path.hasSuffix("/items") && $0.path.contains("item-batches") },
            times: 1,
            with: .error(503, code: "service_unavailable", retryable: true),
        )
        let (_, drafts) = try confirmedHaul(harness.store, items: 1)
        await harness.start()

        #expect(try await eventually { try fullyUploadedAndSubmitted(harness, drafts) })
        #expect(harness.server.items.count == 1)
        await harness.stop()
    }

    @Test
    func `deleting a draft whose add answer was lost finds its item by position, after the key expired`() async throws {
        let harness = try UploadHarness()
        let (_, drafts) = try confirmedHaul(harness.store, items: 1)
        await harness.start()
        #expect(try await eventually { try fullyUploadedAndSubmitted(harness, drafts) })
        await harness.stop()
        let itemID = try #require(try harness.draft(drafts[0].id)?.record.serverItemID)

        // As if the add's answer never arrived, and the server has since forgotten the key.
        try harness.store.updateDraft(drafts[0].id) { $0.serverItemID = nil }
        harness.server.forgetIdempotencyKeys()
        try harness.store.deleteDraft(drafts[0].id)
        try await harness.relaunch()

        #expect(try await eventually { harness.server.items.isEmpty })
        #expect(try await eventually { try harness.store.uploadSnapshot().deletions.isEmpty })
        // Adding at the position found the existing item, which was deleted; none was made.
        #expect(harness.server.requests("DELETE", "/v1/items/\(itemID)").count == 1)
        #expect(harness.server.requests("DELETE", "/v1/items/").count == 1)
        await harness.stop()
    }

    @Test
    func `the batch's interaction is sent once, and again when it changes`() async throws {
        let harness = try UploadHarness()
        let (batch, drafts) = try confirmedHaul(harness.store, items: 1)
        await harness.start()
        #expect(try await eventually { try fullyUploadedAndSubmitted(harness, drafts) })
        let itemID = try #require(try harness.draft(drafts[0].id)?.record.serverItemID)

        try harness.store.setInteraction(
            BatchInteraction(
                batch: .init(activeMs: 30000, waitingMs: 4000, taps: 21),
                items: [.init(serverItemID: itemID, totals: .init(activeMs: 9000, waitingMs: 1000, taps: 7))],
            ),
            of: batch.id,
        )
        await harness.uploader.wake()
        #expect(try await eventually { try harness.store.batch(id: batch.id)?.record.interactionSynced == true })
        #expect(harness.server.batches.first?.interactionTaps == 21)
        #expect(harness.server.batches.first?.interactionItemIDs == [itemID])

        try harness.store.setInteraction(
            BatchInteraction(batch: .init(activeMs: 31000, waitingMs: 4000, taps: 22), items: []),
            of: batch.id,
        )
        await harness.uploader.wake()
        #expect(try await eventually { harness.server.batches.first?.interactionTaps == 22 })
        #expect(harness.server.requests("PUT", "/v1/item-batches").count == 2)
        await harness.stop()
    }
}
