import APIClient
import Core
import Foundation
import Synchronization

/// What a scan run sends to Listora: the API, or a fake in tests.
protocol ScanService: Sendable {
    func createSourcingRun(place: String?, idempotencyKey: String) async throws(APIFailure) -> String
    func createScan(_ request: ScanRequest, idempotencyKey: String) async throws(APIFailure) -> ItemScan
    func researchScan(scanID: String, idempotencyKey: String) async throws(APIFailure) -> ItemScan
    func endSourcingRun(runID: String, idempotencyKey: String) async throws(APIFailure)
    /// The household's own sales for the offline call (`getSourcingKit`).
    func sourcingKit() async throws(APIFailure) -> SourcingKit
    func saveScanComparison(scanID: String, comparisonID: String, answer: Data) async throws(APIFailure) -> ItemScan
    func checkoutSourcingRun(
        runID: String,
        _ checkout: RunCheckout,
        idempotencyKey: String,
    ) async throws(APIFailure) -> SourcingRunSummary
}

extension UploadAPI: ScanService {}

/// Saves a kept scan's photos as a draft whose server item is the scan's; answers the draft's
/// id, or nil when it could not be saved.
/// A nil `scan` saves an ordinary draft: a kept scan that could never be read.
typealias ScanDraftSaver = @MainActor (_ photos: [(PreparedPhoto, PhotoRole)], _ scan: DraftScanOrigin?) async
    -> String?

/// One item scanned in the run, from its shot to the seller's decision.
struct ScanEntry: Equatable, Identifiable {
    enum State: Equatable {
        case reading
        case read(ScanCard)
        /// The read failed; `message` is the server's or the app's, safe to show.
        case failed(message: String, retryable: Bool)
        /// No signal: the read waits on this iPhone until there is (docs/features/thrift-scan.md,
        /// "Offline at the bins"); the card shows the instant read from the seller's own sales.
        case waiting
    }

    /// The web research, which comes in after the read without holding the card up.
    enum Research: Equatable {
        case none
        case checking
        case done
        /// It could not be done; the card stands on the read.
        case failed
    }

    enum Decision: Equatable {
        /// Not kept yet: shooting the next item skips it, and the tray can still keep it.
        case open
        case keeping
        case kept(draftID: String)
        case keepFailed(String)
        /// Kept while the read waits for signal: the draft is saved once the item is read.
        case keepWhenRead
    }

    let id: String
    /// 1 for the run's first item.
    let number: Int
    let shotAt: Date
    /// The small JPEG the read sends; also the tray's thumbnail.
    var itemJPEG: Data
    var tagJPEG: Data?
    var tagText: [String] = []
    var note: String?
    var scanID: String?
    /// The server's answer the card shows, kept with the run.
    var scan: ItemScan?
    var state: State = .reading
    var research: Research = .none
    var decision: Decision = .open
    /// From the shutter to the first card, for the owner's measurements.
    var cardAfter: TimeInterval?
    /// The instant read from the household's own sales (``OfflineScanCall``), when the tag names
    /// one of their brands; what the card shows while the read waits for signal.
    var instant: OfflineScanRead?
    /// The read came only once there was signal again: the card says so.
    var readLate = false
    /// The run's earlier item this one looks like (its number), by the shots' feature prints.
    var duplicateOf: Int?
    var featurePrint: [Float]?
    /// The key of the read due, kept until it lands, so a read retried after a lost answer is
    /// replayed rather than read twice. A new read (a note, the tag) gets a new key.
    var readKey = UUID().uuidString.lowercased()
    /// The scan the read due replaces: a note or the tag after an earlier read.
    var replaces: String?

    var card: ScanCard? {
        if case let .read(card) = state {
            card
        } else {
            nil
        }
    }

    var isKept: Bool {
        if case .kept = decision {
            true
        } else {
            false
        }
    }

    /// Kept, or to be saved once read.
    var isKeptOrPending: Bool {
        isKept || decision == .keepWhenRead
    }

    var isWaiting: Bool {
        state == .waiting
    }
}

/// The tag text a scan shot carries to the read, read on this iPhone within a deadline, so a slow
/// read never holds the scan up. The deadline holds even though Vision only stops at its next
/// pass: the read runs on its own, and the scan goes on without it at the deadline.
enum ScanTagText {
    static func read(_ jpeg: Data, with reader: any TagReader, within deadline: Duration) async -> [String] {
        let first = FirstAnswer<[String]>()
        let work = Task.detached(priority: .userInitiated) {
            let reading = try? await reader.read(imageData: jpeg)
            first.answer(reading.map { Array($0.lines.map(\.text).filter { !$0.isEmpty }.prefix(40)) } ?? [])
        }
        let timer = Task.detached {
            try? await Task.sleep(for: deadline)
            first.answer([])
        }
        let lines = await first.value
        work.cancel()
        timer.cancel()
        return lines
    }
}

/// The first of several answers; later ones are dropped.
private final class FirstAnswer<Value: Sendable>: Sendable {
    private struct State {
        var answered = false
        var value: Value?
        var waiter: CheckedContinuation<Value, Never>?
    }

    private let state = Mutex(State())

    func answer(_ value: Value) {
        let waiter = state.withLock { state -> CheckedContinuation<Value, Never>? in
            guard !state.answered else { return nil }
            state.answered = true
            guard let waiter = state.waiter else {
                state.value = value
                return nil
            }
            state.waiter = nil
            return waiter
        }
        waiter?.resume(returning: value)
    }

    var value: Value {
        get async {
            await withCheckedContinuation { continuation in
                let ready = state.withLock { state -> Value? in
                    if let value = state.value {
                        return value
                    }
                    state.waiter = continuation
                    return nil
                }
                if let ready {
                    continuation.resume(returning: ready)
                }
            }
        }
    }
}
