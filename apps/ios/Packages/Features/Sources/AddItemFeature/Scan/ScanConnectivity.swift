import Foundation
import Network
import Synchronization

/// Whether this iPhone can reach the network now, and when that changes: the scan reads at once
/// with signal and queues its reads without (docs/features/thrift-scan.md, "Offline at the
/// bins"). A path that says online can still fail a request; the queue treats such a failure as
/// no signal too.
protocol ScanConnectivity: Sendable {
    var isOnline: Bool { get }
    /// Every change, starting with the current state.
    func changes() -> AsyncStream<Bool>
}

/// ``ScanConnectivity`` from the system's network path (`NWPathMonitor`).
final class PathConnectivity: ScanConnectivity {
    private let monitor = NWPathMonitor()
    private let state = Mutex<(online: Bool, listeners: [UUID: AsyncStream<Bool>.Continuation])>((true, [:]))

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            self?.update(path.status == .satisfied)
        }
        monitor.start(queue: DispatchQueue(label: "com.listora.app.scan-connectivity"))
    }

    deinit {
        monitor.cancel()
    }

    var isOnline: Bool {
        state.withLock { $0.online }
    }

    func changes() -> AsyncStream<Bool> {
        let (stream, continuation) = AsyncStream<Bool>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let id = UUID()
        let online = state.withLock { state in
            state.listeners[id] = continuation
            return state.online
        }
        continuation.yield(online)
        continuation.onTermination = { [weak self] _ in
            _ = self?.state.withLock { $0.listeners.removeValue(forKey: id) }
        }
        return stream
    }

    private func update(_ online: Bool) {
        let listeners = state.withLock { state -> [AsyncStream<Bool>.Continuation] in
            guard state.online != online else { return [] }
            state.online = online
            return Array(state.listeners.values)
        }
        for listener in listeners {
            listener.yield(online)
        }
    }
}

/// No signal ever (`LISTORA_SCAN_NO_SIGNAL`, debug builds): the UI tests' store with no signal.
struct NoSignal: ScanConnectivity {
    var isOnline: Bool {
        false
    }

    func changes() -> AsyncStream<Bool> {
        AsyncStream { $0.yield(false) }
    }
}
