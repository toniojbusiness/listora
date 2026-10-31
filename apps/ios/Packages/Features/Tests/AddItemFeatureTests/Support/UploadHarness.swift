import APIClient
import Foundation
@testable import AddItemFeature

/// The upload queue wired to a ``FakeListoraServer`` through a `URLProtocol` stub: the real
/// generated API client, the real URLSession upload transport (in a foreground session, since
/// background sessions cannot use a stub), and a draft database in a temporary directory.
/// ``relaunch()`` builds everything again over the same directory, as an app relaunch does.
@MainActor
final class UploadHarness {
    let server: FakeListoraServer
    let directory: TemporaryDirectory
    let grants: InMemoryAccessGrantStorage
    let tokens: AccessTokenStore
    let tagReader = FakeTagReader()
    let activity = UploadActivity()
    let policy: RetryPolicy
    private let now: @Sendable () -> Date
    /// The transport every launch uses, or nil for a new URLSession transport per launch.
    private let fixedTransport: (any UploadTransport)?
    private var wiring: Wiring

    var store: DraftStore {
        wiring.store
    }

    var uploader: PhotoUploader {
        wiring.uploader
    }

    init(
        server: FakeListoraServer = FakeListoraServer(),
        signedIn: Bool = true,
        policy: RetryPolicy = .test,
        transport: (any UploadTransport)? = nil,
        now: @escaping @Sendable () -> Date = Date.init,
    ) throws {
        self.server = server
        self.policy = policy
        self.now = now
        fixedTransport = transport
        directory = try TemporaryDirectory()
        grants = InMemoryAccessGrantStorage(signedIn ? Self.grant : nil)
        tokens = AccessTokenStore(storage: grants)
        wiring = try Wiring(
            directory: directory.url,
            server: server,
            tokens: tokens,
            parts: Parts(tagReader: tagReader, activity: activity, policy: policy, transport: transport, now: now),
        )
    }

    static let grant = AccessGrant(accessToken: "test-token", expiresAt: .distantFuture, email: "seller@example.com")

    func start() async {
        await uploader.start()
    }

    /// Stops the queue and its session as if the app were terminated, then starts a new queue,
    /// store, and session over the same database.
    func relaunch() async throws {
        await uploader.stop()
        wiring.invalidate()
        wiring = try Wiring(
            directory: directory.url,
            server: server,
            tokens: tokens,
            parts: Parts(tagReader: tagReader, activity: activity, policy: policy, transport: fixedTransport, now: now),
        )
        await uploader.start()
    }

    func stop() async {
        await uploader.stop()
        wiring.invalidate()
    }

    /// A new draft with one photo per role, prepared as the app prepares them.
    func createDraft(roles: [PhotoRole]) throws -> DraftRecord {
        let photos = try roles.enumerated().map { index, role in
            try (TestImages.prepared(seed: UInt64(index + 1)), role)
        }
        return try store.createDraft(photos: photos)
    }

    /// A draft kept from a thrift scan: its server item is the scan's.
    func createScanDraft(scanID: String, runID: String = "run-1") throws -> DraftRecord {
        try store.createDraft(
            photos: [(TestImages.prepared(seed: 7), .front)],
            scan: DraftScanOrigin(scanID: scanID, runID: runID, title: "Acme blue shirt"),
        )
    }

    func draft(_ id: String) throws -> Draft? {
        try store.draft(id: id)
    }

    /// True when every photo is attached and the server has the draft's order.
    func isFullyUploaded(_ id: String) throws -> Bool {
        guard let draft = try store.draft(id: id) else { return false }
        return draft.photos.allSatisfy { $0.step == .done && $0.serverRole == $0.role }
            && draft.record.syncedPhotoOrder == draft.photos.compactMap(\.serverPhotoID)
    }

    /// What the queue shares across relaunches.
    private struct Parts {
        var tagReader: FakeTagReader
        var activity: UploadActivity
        var policy: RetryPolicy
        var transport: (any UploadTransport)?
        var now: @Sendable () -> Date
    }

    /// What a launch builds: the store over the database, the transport, and the queue.
    private struct Wiring {
        let store: DraftStore
        let transport: any UploadTransport
        let uploader: PhotoUploader

        init(directory: URL, server: FakeListoraServer, tokens: AccessTokenStore, parts: Parts) throws {
            store = try DraftStore(database: DraftDatabase(directory: directory))
            transport = parts.transport ?? URLSessionUploadTransport(configuration: StubURLProtocol.configuration())
            let api = APIClient(
                baseURL: server.baseURL,
                accessTokens: tokens,
                session: URLSession(configuration: StubURLProtocol.configuration()),
            )
            uploader = PhotoUploader(
                store: store,
                api: UploadAPI(client: api.client),
                accessTokens: tokens,
                tagReader: parts.tagReader,
                transport: transport,
                activity: parts.activity,
                policy: parts.policy,
                now: parts.now,
            )
        }

        func invalidate() {
            (transport as? URLSessionUploadTransport)?.invalidate()
        }
    }
}
