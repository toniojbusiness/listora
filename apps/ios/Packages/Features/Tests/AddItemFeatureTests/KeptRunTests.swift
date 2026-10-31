import Core
import Foundation
import Testing
@testable import AddItemFeature

/// Upgrading a run's kept drafts (docs/features/thrift-scan.md, "Upgrading drafts"): "Needs
/// photos", the guided shoot's photos replacing the scan shots, and the run's rapid review.
struct KeptRunStoreTests {
    private let directory: TemporaryDirectory
    private let store: DraftStore

    init() throws {
        directory = try TemporaryDirectory()
        store = try DraftStore(database: DraftDatabase(directory: directory.url))
    }

    private func photos(_ roles: [PhotoRole], seed: UInt64 = 1) throws -> [(PreparedPhoto, PhotoRole)] {
        try roles.enumerated().map { index, role in try (TestImages.prepared(seed: seed + UInt64(index)), role) }
    }

    private func scanDraft(
        _ scanID: String,
        run: String = "run-1",
        roles: [PhotoRole] = [.front],
    ) throws -> DraftRecord {
        try store.createDraft(
            photos: photos(roles, seed: 40),
            scan: DraftScanOrigin(scanID: scanID, runID: run, title: "Patagonia green fleece"),
        )
    }

    @Test
    func `a kept scan's draft holds only its scan shots and needs photos, after a relaunch too`() throws {
        let kept = try scanDraft("scan-1", roles: [.front, .tag])
        let single = try store.createDraft(photos: photos([.front]))

        let reopened = try DraftStore(database: DraftDatabase(directory: directory.url))
        let draft = try #require(try reopened.draft(id: kept.id))
        #expect(draft.record.scanID == "scan-1")
        #expect(draft.record.scanRunID == "run-1")
        #expect(draft.record.scanTitle == "Patagonia green fleece")
        #expect(draft.photos.map(\.isScanShot) == [true, true])
        #expect(draft.needsPhotos)
        // A single item's photos are its own; it never needs photos.
        let other = try #require(try reopened.draft(id: single.id))
        #expect(other.photos.map(\.isScanShot) == [false])
        #expect(!other.needsPhotos)
    }

    @Test
    func `the shoot's photos come first and the scan shots go, so it no longer needs photos`() throws {
        let kept = try scanDraft("scan-1", roles: [.front, .tag])

        let dropped = try store.replaceScanShots(
            of: kept.id,
            with: photos([.front, .back, .tag]),
            keepingScanShots: false,
        )

        #expect(dropped.count == 2)
        let draft = try #require(try store.draft(id: kept.id))
        #expect(draft.photos.map(\.role) == [.front, .back, .tag])
        #expect(draft.photos.map(\.position) == [0, 1, 2])
        #expect(draft.photos.allSatisfy { !$0.isScanShot })
        #expect(!draft.needsPhotos)
        // The new tag photo is read on the device before it uploads.
        #expect(draft.photos.last?.tagReadState == .pending)
        // Nothing was on the server yet, so there is nothing to delete there.
        #expect(try store.uploadSnapshot().deletions.isEmpty)
        for photo in dropped {
            #expect(!FileManager.default.fileExists(atPath: store.fileURL(for: photo).path(percentEncoded: false)))
        }
    }

    @Test
    func `a scan shot the seller keeps follows the new photos`() throws {
        let kept = try scanDraft("scan-1")

        let dropped = try store.replaceScanShots(of: kept.id, with: photos([.front, .back]), keepingScanShots: true)

        #expect(dropped.isEmpty)
        let draft = try #require(try store.draft(id: kept.id))
        #expect(draft.photos.map(\.isScanShot) == [false, false, true])
        #expect(draft.photos.map(\.position) == [0, 1, 2])
        #expect(!draft.needsPhotos)
    }

    @Test
    func `a shoot that would pass the photo limit saves nothing`() throws {
        let kept = try scanDraft("scan-1")
        let tooMany = try photos(Array(repeating: .detail, count: DraftStore.maxPhotosPerDraft))

        #expect(throws: DraftStoreError.tooManyPhotos) {
            try store.replaceScanShots(of: kept.id, with: tooMany, keepingScanShots: true)
        }
        let draft = try #require(try store.draft(id: kept.id))
        #expect(draft.photos.count == 1)
        #expect(draft.needsPhotos)
    }

    @Test
    func `a deleted draft's shoot saves nothing and leaves no files behind`() throws {
        let kept = try scanDraft("scan-1")
        try store.deleteDraft(kept.id)

        #expect(throws: DraftStoreError.notFound) {
            try store.replaceScanShots(of: kept.id, with: photos([.front]), keepingScanShots: false)
        }
        let files = try FileManager.default
            .contentsOfDirectory(atPath: store.database.photosDirectory.path(percentEncoded: false))
        #expect(files.isEmpty)
    }

    @Test
    func `the drafts list groups kept drafts by run, newest run first, each in the order kept`() throws {
        let first = try scanDraft("scan-1", run: "run-a")
        let second = try scanDraft("scan-2", run: "run-a")
        let later = try scanDraft("scan-3", run: "run-b")
        _ = try store.createDraft(photos: photos([.front]))

        let runs = try KeptScanRun.runs(of: store.drafts())

        #expect(runs.map(\.id) == ["run-b", "run-a"])
        #expect(runs.last?.drafts.map(\.id) == [first.id, second.id])
        #expect(runs.first?.drafts.map(\.id) == [later.id])
        #expect(runs.last?.needingPhotos.count == 2)
    }

    @Test
    func `the run's review holds only the items whose real photos are all on the server`() throws {
        let shot = try scanDraft("scan-1")
        let waiting = try scanDraft("scan-2")
        _ = try scanDraft("scan-3")
        try store.replaceScanShots(of: shot.id, with: photos([.front, .back]), keepingScanShots: false)
        try store.replaceScanShots(of: waiting.id, with: photos([.front]), keepingScanShots: false)
        try markUploaded(shot.id, itemID: "item-1", sku: "LS-1")

        let run = try #require(try KeptScanRun.runs(of: store.drafts()).first)

        #expect(run.needingPhotos.count == 1)
        let request = try #require(run.reviewRequest(transferring: [], isSignedIn: true))
        #expect(request.items == [BatchReviewRequest.Item(sessionID: shot.id, itemID: "item-1", sku: "LS-1")])
        #expect(request.batchID == "run-1")
        #expect(request.batchSessionID == "scan-run-1")
        #expect(request.source == .scanRun)
        // An item still needing photos, or uploading, is never reviewed.
        #expect(run.reviewable(transferring: [], isSignedIn: true).map(\.id) == [shot.id])
    }

    @Test
    func `the run's words`() throws {
        #expect(KeptRunSection.subtitle(kept: 5, needing: 4) == "5 kept · 4 need photos")
        #expect(KeptRunSection.subtitle(kept: 2, needing: 1) == "2 kept · 1 needs photos")
        #expect(KeptRunSection.subtitle(kept: 3, needing: 0) == "3 kept, all with photos")
        let draft = try #require(try store.draft(id: scanDraft("scan-1").id))
        #expect(KeptScanRun.shootTitle(draft, number: 3, of: 23) == "3 of 23: Patagonia green fleece")
    }

    /// The upload queue's end state: the server item exists with every photo attached in order.
    private func markUploaded(_ draftID: String, itemID: String, sku: String) throws {
        try store.writer.write { db in
            guard var draft = try DraftRecord.fetchOne(db, key: draftID) else { return }
            var ids: [String] = []
            for var photo in try DraftStore.photos(of: draftID, in: db) {
                photo.step = .done
                photo.serverPhotoID = "photo-\(photo.id)"
                photo.serverRole = photo.role
                ids.append("photo-\(photo.id)")
                try photo.update(db)
            }
            draft.serverItemID = itemID
            draft.sku = sku
            draft.createItemSent = true
            draft.syncedPhotoOrder = ids
            try draft.update(db)
        }
    }
}

/// The upload queue's part: the shoot's photos reach the server item and the scan shot leaves it.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct KeptRunUploadTests {
    @Test
    func `the scan shot already on the server is replaced there by the shoot's photos`() async throws {
        let harness = try UploadHarness()
        let draft = try harness.createScanDraft(scanID: "scan-1")
        await harness.start()
        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        let scanShot = try #require(harness.server.items.first?.photos.first)

        let photos = try [(TestImages.prepared(seed: 1), PhotoRole.front), (TestImages.prepared(seed: 2), .back)]
        try harness.store.replaceScanShots(of: draft.id, with: photos, keepingScanShots: false)
        await harness.uploader.wake()

        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        #expect(try await eventually { try harness.store.uploadSnapshot().deletions.isEmpty })
        let item = try #require(harness.server.items.first)
        #expect(harness.server.items.count == 1)
        #expect(item.photos.map(\.role) == ["front", "back"])
        #expect(!item.photos.contains { $0.id == scanShot.id })
        #expect(try harness.draft(draft.id)?.needsPhotos == false)
        await harness.stop()
    }
}
