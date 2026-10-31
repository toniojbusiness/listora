import APIClient
import Core
import Foundation

/// What a scan run sends to Listora: the API, or a fake in tests.
protocol ScanService: Sendable {
    func createSourcingRun(place: String?, idempotencyKey: String) async throws(APIFailure) -> String
    func createScan(_ request: ScanRequest, idempotencyKey: String) async throws(APIFailure) -> ItemScan
    func researchScan(scanID: String, idempotencyKey: String) async throws(APIFailure) -> ItemScan
    func endSourcingRun(runID: String, idempotencyKey: String) async throws(APIFailure)
    func checkoutSourcingRun(
        runID: String,
        _ checkout: RunCheckout,
        idempotencyKey: String,
    ) async throws(APIFailure) -> SourcingRunSummary
}

extension UploadAPI: ScanService {}

/// Saves a kept scan's photos as a draft whose server item is the scan's; answers the draft's
/// id, or nil when it could not be saved.
typealias ScanDraftSaver = @MainActor (_ photos: [(PreparedPhoto, PhotoRole)], _ scanID: String) async -> String?

/// One item scanned in the run, from its shot to the seller's decision.
struct ScanEntry: Equatable, Identifiable {
    enum State: Equatable {
        case reading
        case read(ScanCard)
        /// The read failed; `message` is the server's or the app's, safe to show.
        case failed(message: String, retryable: Bool)
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
    var state: State = .reading
    var research: Research = .none
    var decision: Decision = .open
    /// From the shutter to the first card, for the owner's measurements.
    var cardAfter: TimeInterval?

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
}

/// The tag text a scan shot carries to the read, read on this iPhone within a deadline, so a slow
/// read never holds the scan up.
enum ScanTagText {
    static func read(_ jpeg: Data, with reader: any TagReader, within deadline: Duration) async -> [String] {
        await withTaskGroup(of: [String]?.self) { group in
            group.addTask {
                guard let reading = try? await reader.read(imageData: jpeg) else { return [] }
                return Array(reading.lines.map(\.text).filter { !$0.isEmpty }.prefix(40))
            }
            group.addTask {
                try? await Task.sleep(for: deadline)
                return nil
            }
            let first = await group.next()
            group.cancelAll()
            return first.flatMap(\.self) ?? []
        }
    }
}
