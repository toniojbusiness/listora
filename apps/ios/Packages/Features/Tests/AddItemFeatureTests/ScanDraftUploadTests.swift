import Foundation
import Testing
@testable import AddItemFeature

/// The upload queue's part of a kept scan: its draft's server item is the scan's (`keepScan`).
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct ScanDraftUploadTests {
    @Test
    func `a kept scan's draft becomes the scan's item, never a second one`() async throws {
        let harness = try UploadHarness()
        let draft = try harness.createScanDraft(scanID: "scan-1")
        await harness.start()

        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        #expect(harness.server.requests("POST", "/v1/items").filter { $0.path == "/v1/items" }.isEmpty)
        let keeps = harness.server.requests("POST", "/v1/scans/scan-1/keep")
        #expect(keeps.map { $0.header("Idempotency-Key") } == [draft.createItemKey])
        #expect(harness.server.items.count == 1)
        #expect(try harness.draft(draft.id)?.record.serverItemID == harness.server.item(ofScan: "scan-1"))
        await harness.stop()
    }

    @Test
    func `a scan draft deleted before its keep's answer arrived still has its item deleted`() async throws {
        let harness = try UploadHarness(policy: RetryPolicy(
            maxAttempts: 4,
            baseDelay: .seconds(30),
            maxDelay: .seconds(30),
            jitter: 1 ... 1,
        ))
        harness.server.fail(
            { $0.path == "/v1/scans/scan-2/keep" },
            with: .error(503, code: "service_unavailable", retryable: true),
        )
        let draft = try harness.createScanDraft(scanID: "scan-2")
        await harness.start()
        #expect(try await eventually { try harness.draft(draft.id)?.record.retry.attempt == 1 })

        try harness.store.deleteDraft(draft.id)
        await harness.uploader.wake()

        // Keeping the scan again finds (or makes) its item, which is then deleted.
        #expect(try await eventually { try harness.store.uploadSnapshot().deletions.isEmpty })
        #expect(harness.server.items.isEmpty)
        await harness.stop()
    }

    @Test
    func `a scan its run ended without can't be kept, and the draft says so`() async throws {
        let harness = try UploadHarness()
        harness.server.closeScan("scan-3")
        let draft = try harness.createScanDraft(scanID: "scan-3")
        await harness.start()

        #expect(try await eventually { try harness.draft(draft.id)?.record.retry.failure != nil })
        #expect(harness.server.items.isEmpty)
        await harness.stop()
    }
}
