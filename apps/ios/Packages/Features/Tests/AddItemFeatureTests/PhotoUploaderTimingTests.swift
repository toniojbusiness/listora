import Foundation
import Testing
@testable import AddItemFeature

/// The upload queue on a slow machine, where time passes between any two of its decisions.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct PhotoUploaderTimingTests {
    @Test
    func `a retry that falls due while the queue decides what to do next still runs`() async throws {
        // Each clock reading is 15 ms later and the first retry waits 20 ms, so the retry is not yet
        // due when the queue looks for work, and is past due at the next reading.
        let clock = SteppingClock(step: .milliseconds(15))
        let transport = FakeUploadTransport()
        let harness = try UploadHarness(transport: transport, now: clock.now)
        let draft = try harness.createDraft(roles: [.front])
        await harness.start()
        #expect(try await eventually { try harness.draft(draft.id)?.record.serverItemID != nil })
        await harness.uploader.waitUntilIdle()
        let photo = try #require(try harness.draft(draft.id)?.photos.first)
        let fileID = try #require(photo.uploadFileID)

        harness.server.fail(
            { $0.method == "POST" && $0.path.hasSuffix("/photos") },
            with: .error(503, code: "service_unavailable", retryable: true),
        )
        try harness.server.markUploaded(fileID: fileID, bytes: harness.store.imageData(of: photo))
        transport.finish(photo.id, with: .response(statusCode: 200))

        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        #expect(harness.server.requests("POST", "/v1/items/").count == 2)
        await harness.stop()
    }
}
