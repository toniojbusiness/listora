import Foundation
import Testing
@testable import AddItemFeature

struct CaptureGuideTests {
    @Test
    func `the guide walks front, back, tag, then takes any number of flaws and details`() throws {
        var guide = CaptureGuide()
        #expect(guide.step == .front)

        try guide.accept(TestImages.prepared(seed: 1))
        try guide.accept(TestImages.prepared(seed: 2))
        try guide.accept(TestImages.prepared(seed: 3))
        #expect(guide.step == .details)
        try guide.accept(TestImages.prepared(seed: 4))
        guide.detailRole = .detail
        try guide.accept(TestImages.prepared(seed: 5))

        #expect(guide.step == .details)
        #expect(guide.shots.map(\.role) == [.front, .back, .tag, .flaw, .detail])
        #expect(guide.count(of: .details) == 2)
    }

    @Test
    func `skipping a step moves on without a shot`() throws {
        var guide = CaptureGuide()
        guide.skip()
        try guide.accept(TestImages.prepared())

        #expect(guide.shots.map(\.role) == [.back])
        #expect(guide.step == .tag)
    }

    @Test
    func `the guide takes only as many shots as the draft has room for`() throws {
        var guide = CaptureGuide(capacity: 2)
        try guide.accept(TestImages.prepared(seed: 1))
        try guide.accept(TestImages.prepared(seed: 2))
        #expect(!guide.canTakeMore)

        try guide.accept(TestImages.prepared(seed: 3))

        #expect(guide.shots.map(\.role) == [.front, .back])
    }
}

struct CropGeometryTests {
    @Test
    func `dragging a corner resizes the frame inside the photo`() {
        let full = CGRect(x: 0, y: 0, width: 1, height: 1)

        let resized = CropView.resized(
            full,
            corner: .topLeft,
            by: CGSize(width: 0.2, height: 0.1),
            square: false,
            aspectRatio: 1,
        )
        #expect(resized == CGRect(x: 0.2, y: 0.1, width: 0.8, height: 0.9))

        let clamped = CropView.resized(
            full,
            corner: .bottomRight,
            by: CGSize(width: 0.5, height: -0.95),
            square: false,
            aspectRatio: 1,
        )
        #expect(clamped.maxX == 1)
        #expect(abs(clamped.height - 0.1) < 1e-9)
    }

    @Test
    func `square keeps the frame 1 to 1 in pixels for a portrait photo`() {
        // A 3:4 portrait photo: a normalized width of 1 is 0.75 of the height.
        let squared = CropView.squared(CGRect(x: 0, y: 0, width: 1, height: 1), aspectRatio: 0.75)

        #expect(abs(squared.width * 0.75 - squared.height) < 1e-9)
        #expect(squared.width == 1)
        #expect(abs(squared.midY - 0.5) < 1e-9)
    }
}

struct UploadStatusTests {
    private func photo(step: UploadStep = .session, retry: RetryState = RetryState()) throws -> DraftPhotoRecord {
        var photo = try DraftPhotoRecord.new(
            draftID: "d",
            position: 0,
            role: .front,
            photo: TestImages.prepared(),
            now: .now,
        )
        photo.step = step
        photo.retry = retry
        if step == .done {
            photo.serverPhotoID = "p"
            photo.serverRole = .front
        }
        return photo
    }

    @Test
    func `uploaded only once the server attached the photo with its current role`() throws {
        #expect(try PhotoUploadStatus(photo: photo(step: .done), isTransferring: false, isSignedIn: true) == .uploaded)
        #expect(try PhotoUploadStatus(photo: photo(step: .attach), isTransferring: false, isSignedIn: true) == .waiting)
        var changed = try photo(step: .done)
        changed.role = .back
        #expect(PhotoUploadStatus(photo: changed, isTransferring: false, isSignedIn: true) == .waiting)
    }

    @Test
    func `failures, retries, transfers, and signed-out waits read as such`() throws {
        let stopped = RetryState(attempt: 8, failure: "Listora is busy.")
        #expect(try PhotoUploadStatus(photo: photo(retry: stopped), isTransferring: false, isSignedIn: true) ==
            .failed(message: "Listora is busy."))
        let waiting = RetryState(attempt: 2, retryAt: .now.addingTimeInterval(4))
        #expect(try PhotoUploadStatus(photo: photo(retry: waiting), isTransferring: false, isSignedIn: true) ==
            .retrying(
                attempt: 2,
                maxAttempts: 8,
            ))
        #expect(try PhotoUploadStatus(photo: photo(step: .transfer), isTransferring: true, isSignedIn: true) ==
            .uploading)
        #expect(try PhotoUploadStatus(photo: photo(), isTransferring: false, isSignedIn: false) == .waitingForSignIn)
    }

    @Test
    func `a draft is saved to Listora only when every photo is attached in the right order`() throws {
        var record = DraftRecord.new(now: .now)
        let done = try photo(step: .done)
        let draft = Draft(record: record, photos: [done])
        #expect(DraftUploadSummary(draft: draft, transferring: [], isSignedIn: true).tone == .neutral)
        record.syncedPhotoOrder = ["p"]
        let synced = Draft(record: record, photos: [done])
        #expect(DraftUploadSummary(draft: synced, transferring: [], isSignedIn: true)
            .text == "Saved to Listora with 1 photo")
        let pending = try Draft(record: record, photos: [photo()])
        #expect(DraftUploadSummary(draft: pending, transferring: [], isSignedIn: false)
            .text == "Saved on this phone. Sign in to upload.")
    }

    @Test
    func `a draft with no photos asks for photos instead of counting uploads`() {
        let empty = Draft(record: DraftRecord.new(now: .now), photos: [])

        let summary = DraftUploadSummary(draft: empty, transferring: [], isSignedIn: true)

        #expect(summary.text == "No photos yet. Add photos to continue.")
        #expect(summary.tone == .empty)
        #expect(!summary.canRetry)
    }
}
