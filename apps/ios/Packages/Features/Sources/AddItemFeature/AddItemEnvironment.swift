import APIClient
import AVFoundation
import Core
import Foundation
import os
import Synchronization

/// Everything the Add Item tab needs, built once at launch by `AppDependencies`: the on-device
/// draft store, the upload queue, and the background upload session.
@MainActor
public final class AddItemEnvironment {
    /// The background URLSession of photo uploads. The app must recreate it under this identifier
    /// when the system wakes it for upload events (see ``handleBackgroundSessionEvents()``).
    public static let backgroundSessionIdentifier = "com.listora.app.photo-uploads"

    enum State {
        case ready(DraftStore, PhotoUploader)
        /// The draft database could not be opened; the tab explains instead of crashing the app.
        case unavailable(String)
    }

    /// One per process: the system allows a single session object per background identifier.
    private static let backgroundTransport = URLSessionUploadTransport
        .background(identifier: backgroundSessionIdentifier)

    let state: State
    let activity: UploadActivity
    /// False in the simulator and on devices without a camera: the tab offers library import only.
    let isCameraAvailable: Bool
    /// Debug builds only: a folder whose JPEGs "Import photos" adds instead of opening the photo
    /// picker, so UI tests import fixture photos (`LISTORA_FIXTURE_PHOTOS`).
    let fixturePhotosDirectory: URL?
    private let tokenChanges: AsyncStream<AccessGrant?>?
    private var tokenObservation: Task<Void, Never>?

    /// The app's environment: drafts in `dataDirectory`, uploads through the background session.
    public convenience init(
        dataDirectory: URL,
        apiClient: APIClient,
        accessTokens: AccessTokenStore,
        tagReader: any TagReader,
        fixturePhotosDirectory: URL? = nil,
    ) {
        self.init(
            dataDirectory: dataDirectory,
            api: UploadAPI(client: apiClient.client),
            accessTokens: accessTokens,
            tokenChanges: accessTokens.changes(),
            tagReader: tagReader,
            transport: Self.backgroundTransport,
            isCameraAvailable: AVCaptureDevice.default(for: .video) != nil,
            fixturePhotosDirectory: fixturePhotosDirectory,
        )
    }

    init(
        dataDirectory: URL,
        api: UploadAPI,
        accessTokens: any AccessTokenProvider,
        tokenChanges: AsyncStream<AccessGrant?>?,
        tagReader: any TagReader,
        transport: any UploadTransport,
        isCameraAvailable: Bool,
        fixturePhotosDirectory: URL?,
        policy: RetryPolicy = .standard,
    ) {
        let activity = UploadActivity()
        self.activity = activity
        self.isCameraAvailable = isCameraAvailable
        self.fixturePhotosDirectory = fixturePhotosDirectory
        self.tokenChanges = tokenChanges
        do {
            let store = try DraftStore(database: DraftDatabase(directory: dataDirectory))
            let uploader = PhotoUploader(
                store: store,
                api: api,
                accessTokens: accessTokens,
                tagReader: tagReader,
                transport: transport,
                activity: activity,
                policy: policy,
            )
            state = .ready(store, uploader)
        } catch {
            Logger(subsystem: "com.listora.app", category: "drafts")
                .error("Opening the draft database failed: \(String(describing: error), privacy: .public)")
            state =
                .unavailable("Drafts can't be saved on this iPhone right now. Free up some storage and reopen Listora.")
        }
    }

    /// Where the app keeps drafts: Application Support, which is backed up and never purged.
    public static func defaultDataDirectory() -> URL {
        URL.applicationSupportDirectory.appending(path: "Drafts", directoryHint: .isDirectory)
    }

    /// Starts the upload queue, and wakes it whenever someone signs in. Safe to call repeatedly.
    public func start() {
        guard case let .ready(_, uploader) = state else { return }
        Task { await uploader.start() }
        guard tokenObservation == nil, let tokenChanges else { return }
        tokenObservation = Task {
            for await _ in tokenChanges {
                await uploader.wake()
            }
        }
    }

    /// Call when the system wakes the app for the background upload session: waits until its events
    /// are delivered and the queue has acted on them (attached the uploaded photos), within the
    /// time the system allows.
    public func handleBackgroundSessionEvents() async {
        guard case let .ready(_, uploader) = state else { return }
        start()
        let transport = uploader.transport
        // Whichever finishes first: the waits do not end on cancellation, so they are raced
        // rather than run in a task group that would wait for both.
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let resume = ResumeOnce(continuation)
            Task {
                await transport.waitForBackgroundEvents()
                await uploader.wake()
                await uploader.waitUntilIdle()
                resume()
            }
            Task {
                try? await Task.sleep(for: .seconds(25))
                resume()
            }
        }
    }
}

/// Resumes a continuation the first time it is called and ignores later calls.
private final class ResumeOnce: Sendable {
    private let continuation: Mutex<CheckedContinuation<Void, Never>?>

    init(_ continuation: CheckedContinuation<Void, Never>) {
        self.continuation = Mutex(continuation)
    }

    func callAsFunction() {
        continuation.withLock { continuation in
            defer { continuation = nil }
            return continuation
        }?.resume()
    }
}
