import APIClient
import Foundation
import Testing
@testable import AddItemFeature

/// The upload queue against a fake API and storage server behind a `URLProtocol` stub.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct PhotoUploaderTests {
    @Test
    func `uploads a draft: item, bytes, attach with roles and tag reads, then the order`() async throws {
        let harness = try UploadHarness()
        let draft = try harness.createDraft(roles: [.front, .back, .tag])
        await harness.start()

        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        let item = try #require(harness.server.items.first)
        #expect(harness.server.items.count == 1)
        #expect(try harness.draft(draft.id)?.record.sku == item.sku)
        #expect(item.photos.map(\.role) == ["front", "back", "tag"])
        let photos = try #require(try harness.draft(draft.id)?.photos)
        #expect(item.photos.map(\.id) == photos.compactMap(\.serverPhotoID))
        // The stored bytes are exactly the prepared JPEGs.
        for (photo, serverPhoto) in zip(photos, item.photos) {
            #expect(try harness.server
                .storedBytes(ofFile: serverPhoto.uploadFileID) == (harness.store.imageData(of: photo)))
        }
        // Only the tag photo was read on the device, and its reads went with it.
        #expect(harness.tagReader.callCount == 1)
        #expect(item.photos[2].ocrLines == ["ACME", "RN 12345"])
        #expect(item.photos[2].barcodes == ["0012345678905"])
        #expect(item.photos[0].ocrLines.isEmpty)
        let summary = try #require(try harness.draft(draft.id))
        #expect(DraftUploadSummary(draft: summary, transferring: [], isSignedIn: true).tone == .success)
        await harness.stop()
    }

    @Test
    func `a transfer that fails with 503 is retried with backoff, then succeeds`() async throws {
        let harness = try UploadHarness()
        harness.server.fail(
            { $0.method == "PUT" && $0.url.host() == harness.server.storageHost },
            times: 2,
            with: StubReply(status: 503),
        )
        let draft = try harness.createDraft(roles: [.front])
        await harness.start()

        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        let puts = harness.server.requests("PUT", "/uploads/")
        #expect(puts.count == 3)
        // The session and the attach each ran once: only the transfer was retried.
        #expect(harness.server.requests("POST", "/v1/upload-sessions").count == 1)
        #expect(harness.server.requests("POST", "/v1/items/").count == 1)
        #expect(try harness.draft(draft.id)?.photos.first?.retry == RetryState())
        await harness.stop()
    }

    @Test
    func `retries stop after the policy's attempts with a visible failure, and Retry starts again`() async throws {
        let harness = try UploadHarness()
        let attach: @Sendable (StubRequest) -> Bool = { $0.method == "POST" && $0.path.hasSuffix("/photos") }
        harness.server.fail(
            attach,
            times: RetryPolicy.test.maxAttempts,
            with: .error(503, code: "service_unavailable", message: "Listora is busy.", retryable: true),
        )
        let draft = try harness.createDraft(roles: [.front])
        await harness.start()

        let stopped = try await eventually { try harness.draft(draft.id)?.photos.first?.retry.failure != nil }
        #expect(stopped)
        let photo = try #require(try harness.draft(draft.id)?.photos.first)
        #expect(photo.retry.failure == "Listora is busy.")
        #expect(photo.retry.attempt == RetryPolicy.test.maxAttempts)
        #expect(PhotoUploadStatus(photo: photo, isTransferring: false, isSignedIn: true) ==
            .failed(message: "Listora is busy."))
        let summary = try DraftUploadSummary(
            draft: #require(try harness.draft(draft.id)),
            transferring: [],
            isSignedIn: true,
        )
        #expect(summary.tone == .danger)
        #expect(summary.canRetry)
        // Every attempt reused the same Idempotency-Key.
        #expect(Set(harness.server.requests("POST", "/v1/items/").map { $0.header("Idempotency-Key") }).count == 1)

        try harness.store.retry(draftID: draft.id)
        await harness.uploader.wake()
        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        await harness.stop()
    }

    @Test
    func `a request the server says cannot succeed stops at once with the server's message`() async throws {
        let harness = try UploadHarness()
        harness.server.fail(
            { $0.method == "POST" && $0.path == "/v1/upload-sessions" },
            with: .error(422, code: "validation_failed", message: "This file is too large.", retryable: false),
        )
        let draft = try harness.createDraft(roles: [.front])
        await harness.start()

        #expect(try await eventually { try harness.draft(draft.id)?.photos.first?.retry.failure != nil })
        let photo = try #require(try harness.draft(draft.id)?.photos.first)
        #expect(photo.retry.failure == "This file is too large.")
        #expect(photo.retry.attempt == 1)
        #expect(photo.step == .session)
        await harness.stop()
    }

    @Test
    func `resumes after a relaunch mid-transfer without creating anything twice`() async throws {
        let harness = try UploadHarness()
        // The first transfer never gets an answer, as when the app is killed while sending.
        harness.server.fail({ $0.method == "PUT" }, with: nil)
        let draft = try harness.createDraft(roles: [.front, .tag])
        await harness.start()
        #expect(try await eventually { await !harness.uploader.transferring.isEmpty })
        #expect(try await eventually { harness.server.items.count == 1 })

        try await harness.relaunch()

        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        #expect(harness.server.items.count == 1)
        #expect(harness.server.items.first?.photos.count == 2)
        // The relaunched queue asked the session what arrived, then sent the missing bytes again.
        #expect(!harness.server.requests("GET", "/v1/upload-sessions/").isEmpty)
        #expect(harness.server.requests("POST", "/v1/upload-sessions").count == 2)
        await harness.stop()
    }

    @Test
    func `after a relaunch, bytes that arrived while the app was closed are attached without sending them again`(
    ) async throws {
        let harness = try UploadHarness()
        harness.server.fail({ $0.method == "PUT" }, with: nil)
        let draft = try harness.createDraft(roles: [.front])
        await harness.start()
        #expect(try await eventually { await !harness.uploader.transferring.isEmpty })
        let photo = try #require(try harness.draft(draft.id)?.photos.first)
        let fileID = try #require(photo.uploadFileID)
        // The system finished the background transfer while the app was not running.
        try harness.server.markUploaded(fileID: fileID, bytes: harness.store.imageData(of: photo))

        try await harness.relaunch()

        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        #expect(harness.server.requests("PUT", "/uploads/").count == 1)
        #expect(harness.server.items.first?.photos.first?.uploadFileID == fileID)
        await harness.stop()
    }

    @Test
    func `nothing is sent while signed out, and signing in starts the upload`() async throws {
        let harness = try UploadHarness(signedIn: false)
        let draft = try harness.createDraft(roles: [.front, .tag])
        await harness.start()

        // Tag reading runs on the device without a session; nothing reaches the server.
        #expect(try await eventually { try harness.draft(draft.id)?.photos.last?.tagReadState == .done })
        try await Task.sleep(for: .milliseconds(200))
        #expect(harness.server.requests.isEmpty)
        let photo = try #require(try harness.draft(draft.id)?.photos.first)
        #expect(PhotoUploadStatus(photo: photo, isTransferring: false, isSignedIn: harness.activity.isSignedIn) ==
            .waitingForSignIn)

        harness.tokens.signIn(UploadHarness.grant)
        await harness.uploader.wake()
        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        await harness.stop()
    }

    @Test
    func `a 401 signs the user out and the upload waits for the next sign-in`() async throws {
        let harness = try UploadHarness()
        harness.server.fail(
            { $0.path == "/v1/items" },
            with: .error(401, code: "unauthenticated", message: "Sign in again.", retryable: false),
        )
        let draft = try harness.createDraft(roles: [.front])
        await harness.start()

        #expect(try await eventually { harness.tokens.grant == nil })
        #expect(try harness.draft(draft.id)?.record.retry.failure == nil)

        harness.tokens.signIn(UploadHarness.grant)
        await harness.uploader.wake()
        #expect(try await eventually { try harness.isFullyUploaded(draft.id) })
        await harness.stop()
    }
}
