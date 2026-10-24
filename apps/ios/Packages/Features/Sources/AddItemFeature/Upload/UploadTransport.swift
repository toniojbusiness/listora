import Foundation
import Synchronization

/// How one photo's bytes transfer ended.
enum TransferResult: Equatable, Sendable {
    /// The storage server answered with this HTTP status.
    case response(statusCode: Int)
    /// No answer: no network, a timeout, or a dropped connection.
    case failed
    /// The queue cancelled it (the photo was removed).
    case cancelled
}

struct TransferEvent: Equatable, Sendable {
    let photoID: String
    let result: TransferResult
}

/// Sends photo bytes to their upload targets. The bytes go from the photo's file, so the system
/// can keep sending while the app is suspended or not running.
protocol UploadTransport: Sendable {
    /// Every finished transfer, including ones that finished while the app was not running.
    var events: AsyncStream<TransferEvent> { get }
    func start(_ request: URLRequest, fromFile file: URL, photoID: String)
    /// Photos whose transfer is still running, for example after the app was relaunched.
    func activePhotoIDs() async -> Set<String>
    func cancel(photoID: String) async
    /// Waits until the system has delivered the events it woke the app for.
    func waitForBackgroundEvents() async
}

/// ``UploadTransport`` over URLSession upload tasks. In the app the session is a background
/// session (``background(identifier:)``): transfers continue while the app is suspended or
/// terminated by the system, and their results reach this delegate when the app runs again with
/// the same identifier. Tests use a foreground configuration with a `URLProtocol` stub.
final class URLSessionUploadTransport: UploadTransport {
    let events: AsyncStream<TransferEvent>
    private let session: URLSession
    private let delegate: Delegate

    init(configuration: URLSessionConfiguration) {
        let (events, continuation) = AsyncStream.makeStream(of: TransferEvent.self)
        self.events = events
        delegate = Delegate(events: continuation)
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    }

    /// The app's background session.
    static func background(identifier: String) -> URLSessionUploadTransport {
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        configuration.sessionSendsLaunchEvents = true
        // Photos should go now, not when the system finds it convenient.
        configuration.isDiscretionary = false
        configuration.httpMaximumConnectionsPerHost = 4
        return URLSessionUploadTransport(configuration: configuration)
    }

    func start(_ request: URLRequest, fromFile file: URL, photoID: String) {
        let task = session.uploadTask(with: request, fromFile: file)
        task.taskDescription = photoID
        task.resume()
    }

    func activePhotoIDs() async -> Set<String> {
        let tasks = await session.allTasks
        return Set(tasks.filter { $0.state == .running || $0.state == .suspended }.compactMap(\.taskDescription))
    }

    func cancel(photoID: String) async {
        for task in await session.allTasks where task.taskDescription == photoID {
            task.cancel()
        }
    }

    func waitForBackgroundEvents() async {
        await delegate.waitForBackgroundEvents()
    }

    /// Stops the session; tests call this so sessions do not outlive them.
    func invalidate() {
        session.invalidateAndCancel()
    }

    private final class Delegate: NSObject, URLSessionTaskDelegate, Sendable {
        private let events: AsyncStream<TransferEvent>.Continuation
        /// Waiters for `urlSessionDidFinishEvents`, and whether it already happened.
        private let backgroundEvents = Mutex<(finished: Bool, waiters: [CheckedContinuation<Void, Never>])>((false, []))

        init(events: AsyncStream<TransferEvent>.Continuation) {
            self.events = events
        }

        func urlSession(_: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
            guard let photoID = task.taskDescription else { return }
            let result: TransferResult = if let error {
                (error as? URLError)?.code == .cancelled ? .cancelled : .failed
            } else if let response = task.response as? HTTPURLResponse {
                .response(statusCode: response.statusCode)
            } else {
                .failed
            }
            events.yield(TransferEvent(photoID: photoID, result: result))
        }

        func urlSessionDidFinishEvents(forBackgroundURLSession _: URLSession) {
            let waiters = backgroundEvents.withLock { state in
                state.finished = true
                defer { state.waiters = [] }
                return state.waiters
            }
            for waiter in waiters {
                waiter.resume()
            }
        }

        func waitForBackgroundEvents() async {
            await withCheckedContinuation { continuation in
                let finished = backgroundEvents.withLock { state in
                    if state.finished {
                        state.finished = false
                        return true
                    }
                    state.waiters.append(continuation)
                    return false
                }
                if finished {
                    continuation.resume()
                }
            }
        }
    }
}
