import APIClient
import AVFoundation
import Core
import Foundation
import os
import SwiftUI
import Synchronization

/// Builds the review flow for a draft whose photos are on the server. The review feature
/// implements it; `AppDependencies` hands it over, so the two features never import each other.
public typealias ItemReviewDestination = @MainActor (
    ItemReviewRequest,
    _ onFinished: @escaping @MainActor (ItemReviewOutcome) -> Void,
) -> AnyView

/// Builds the rapid review of a batch's analyzed items, which reports each saved item and the end
/// of the review as they happen. The review feature implements it, like ``ItemReviewDestination``.
public typealias BatchReviewDestination = @MainActor (
    BatchReviewRequest,
    _ onEvent: @escaping @MainActor (BatchReviewEvent) -> Void,
) -> AnyView

/// Everything the Add Item tab needs, built once at launch by `AppDependencies`: the on-device
/// draft store, the upload queue, and the background upload session.
@MainActor
public final class AddItemEnvironment {
    /// The background URLSession of photo uploads. The app must recreate it under this identifier
    /// when the system wakes it for upload events (see ``handleBackgroundSessionEvents()``).
    public static let backgroundSessionIdentifier = "com.listora.app.photo-uploads"

    /// Opens a saved item to list it everywhere (the app's Inventory, set by the root view);
    /// without it, List it now only closes the review.
    public var onListItem: (@MainActor (_ itemID: String) -> Void)?

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
    /// Debug builds only: a folder of photos that stands in for the camera
    /// (`LISTORA_FAKE_CAMERA`), so the simulator can show and test the guided capture.
    let fakeCameraDirectory: URL?
    /// Debug builds only: a folder whose JPEGs "Import photos" adds instead of opening the photo
    /// picker, so UI tests import fixture photos (`LISTORA_FIXTURE_PHOTOS`).
    let fixturePhotosDirectory: URL?
    /// Measures each new item's interaction time, from its first photo to its saved item.
    let meter: InteractionMeter
    /// Opens the review of a draft's item; nil offers no review (previews).
    let reviewDestination: ItemReviewDestination?
    /// Opens the rapid review of a batch's items; nil offers none (previews).
    let batchReviewDestination: BatchReviewDestination?
    /// Reads the grouping signals of batch photos on the device.
    let signalReader: any PhotoSignalReader
    /// Where the batch screen reads its batch's progress.
    let batchProgress: any BatchProgressSource
    /// Whether this iPhone holds any draft: the Add Item tab lists only these, so the Today card
    /// for drafts on the server opens it only then.
    public var hasDrafts: Bool {
        guard case let .ready(store, _) = state else { return false }
        return (try? store.drafts().isEmpty) == false
    }

    private let tokenChanges: AsyncStream<AccessGrant?>?
    private var tokenObservation: Task<Void, Never>?

    /// The app's environment: drafts in `dataDirectory`, uploads through the background session.
    public convenience init(
        dataDirectory: URL,
        apiClient: APIClient,
        accessTokens: AccessTokenStore,
        tagReader: any TagReader,
        signalReader: any PhotoSignalReader,
        meter: InteractionMeter,
        reviewDestination: ItemReviewDestination?,
        batchReviewDestination: BatchReviewDestination?,
        fixturePhotosDirectory: URL? = nil,
        fakeCameraDirectory: URL? = nil,
    ) {
        self.init(
            dataDirectory: dataDirectory,
            api: UploadAPI(client: apiClient.client),
            accessTokens: accessTokens,
            tokenChanges: accessTokens.changes(),
            tagReader: tagReader,
            signalReader: signalReader,
            transport: Self.backgroundTransport,
            isCameraAvailable: AVCaptureDevice.default(for: .video) != nil,
            fixturePhotosDirectory: fixturePhotosDirectory,
            fakeCameraDirectory: fakeCameraDirectory,
            meter: meter,
            reviewDestination: reviewDestination,
            batchReviewDestination: batchReviewDestination,
        )
    }

    init(
        dataDirectory: URL,
        api: UploadAPI,
        accessTokens: any AccessTokenProvider,
        tokenChanges: AsyncStream<AccessGrant?>?,
        tagReader: any TagReader,
        signalReader: any PhotoSignalReader,
        transport: any UploadTransport,
        isCameraAvailable: Bool,
        fixturePhotosDirectory: URL?,
        fakeCameraDirectory: URL? = nil,
        meter: InteractionMeter,
        reviewDestination: ItemReviewDestination?,
        batchReviewDestination: BatchReviewDestination? = nil,
        batchProgress: (any BatchProgressSource)? = nil,
        policy: RetryPolicy = .standard,
    ) {
        let activity = UploadActivity()
        self.activity = activity
        self.meter = meter
        self.reviewDestination = reviewDestination
        self.batchReviewDestination = batchReviewDestination
        self.signalReader = signalReader
        self.batchProgress = batchProgress ?? api
        self.isCameraAvailable = isCameraAvailable || fakeCameraDirectory != nil
        self.fixturePhotosDirectory = fixturePhotosDirectory
        self.fakeCameraDirectory = fakeCameraDirectory
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

    /// A camera for one capture session.
    func makeCamera() -> any CameraSource {
        #if DEBUG
            if let fakeCameraDirectory {
                return FixtureCamera(directory: fakeCameraDirectory)
            }
        #endif
        return DeviceCamera()
    }

    /// Forgets the Add Item tab's settings on this iPhone (`LISTORA_RESET_LOCAL_DATA`); the drafts
    /// are in ``defaultDataDirectory()``, which the reset removes.
    public static func resetLocalData(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: AddItemMode.storageKey)
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
        // Whichever finishes first: the waits do not end on cancellation, so they are raced
        // rather than run in a task group that would wait for both.
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let resume = ResumeOnce(continuation)
            Task {
                await uploader.finishBackgroundEvents()
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
