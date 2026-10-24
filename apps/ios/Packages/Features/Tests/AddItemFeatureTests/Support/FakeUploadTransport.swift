import Foundation
import Synchronization
@testable import AddItemFeature

/// A transport whose transfers end only when the test says so, as the system ends background
/// transfers and delivers their events when it wakes the app.
final class FakeUploadTransport: UploadTransport {
    let events: AsyncStream<TransportEvent>
    private let continuation: AsyncStream<TransportEvent>.Continuation
    private let active = Mutex<Set<String>>([])

    init() {
        let (events, continuation) = AsyncStream.makeStream(of: TransportEvent.self)
        self.events = events
        self.continuation = continuation
    }

    /// Photos whose transfer started and has not ended.
    var running: Set<String> {
        active.withLock { $0 }
    }

    func start(_: URLRequest, fromFile _: URL, photoID: String) {
        active.withLock { _ = $0.insert(photoID) }
    }

    func activePhotoIDs() async -> Set<String> {
        running
    }

    func cancel(photoID: String) async {
        finish(photoID, with: .cancelled)
    }

    func finish(_ photoID: String, with result: TransferResult) {
        active.withLock { _ = $0.remove(photoID) }
        continuation.yield(.transfer(TransferEvent(photoID: photoID, result: result)))
    }

    /// The system has delivered every event it woke the app for.
    func finishBackgroundEvents() {
        continuation.yield(.backgroundEventsDelivered)
    }
}
