import Core
import Foundation

/// The drafts one thrift run kept on this iPhone (docs/features/thrift-scan.md, "Upgrading
/// drafts"): shot together with their real photos ("Shoot this run"), then reviewed together.
struct KeptScanRun: Identifiable, Equatable {
    /// The run on this iPhone (``ScanRunModel/id``).
    let id: String
    /// In the order they were kept.
    let drafts: [Draft]

    /// The drafts whose only photos are the scan's shots.
    var needingPhotos: [Draft] {
        drafts.filter(\.needsPhotos)
    }

    /// When the run's last item was kept: runs list newest first.
    var lastKeptAt: Date {
        drafts.map(\.record.createdAt).max() ?? .distantPast
    }

    /// The runs of `drafts`, newest first. Drafts not kept from a scan run are left out.
    static func runs(of drafts: [Draft]) -> [KeptScanRun] {
        let byRun = Dictionary(grouping: drafts.filter { $0.record.scanRunID != nil }) { $0.record.scanRunID ?? "" }
        return byRun
            .map { runID, drafts in
                KeptScanRun(
                    id: runID,
                    drafts: drafts.sorted {
                        ($0.record.createdAt, $0.id) < ($1.record.createdAt, $1.id)
                    },
                )
            }
            .sorted { ($0.lastKeptAt, $0.id) > ($1.lastKeptAt, $1.id) }
    }

    /// The drafts ready for the rapid review: their real photos taken and every one of them on the
    /// server, attached in order. A draft still uploading waits, so no analysis ever runs on half
    /// of an item's photos.
    func reviewable(transferring: Set<String>, isSignedIn: Bool) -> [Draft] {
        drafts.filter { draft in
            !draft.needsPhotos && draft.record.serverItemID != nil
                && DraftUploadSummary(draft: draft, transferring: transferring, isSignedIn: isSignedIn).isComplete
        }
    }

    /// The rapid review of the drafts ready for it, in the order they were kept; nil when none is.
    func reviewRequest(transferring: Set<String>, isSignedIn: Bool) -> BatchReviewRequest? {
        let items = reviewable(transferring: transferring, isSignedIn: isSignedIn).compactMap { draft in
            draft.record.serverItemID.map {
                BatchReviewRequest.Item(sessionID: draft.id, itemID: $0, sku: draft.record.sku)
            }
        }
        guard !items.isEmpty else { return nil }
        return BatchReviewRequest(batchID: id, items: items, batchSessionID: Self.meterSession(id), source: .scanRun)
    }

    /// The ``InteractionMeter`` session of the run's camera (``ScanRunModel/meterSession``).
    static func meterSession(_ runID: String) -> String {
        "scan-\(runID)"
    }

    /// "3 of 23: Patagonia green fleece", for the guided shoot.
    static func shootTitle(_ draft: Draft, number: Int, of total: Int) -> String {
        let name = draft.record.scanTitle ?? draft.record.sku ?? "Item \(number)"
        return "\(number) of \(total): \(name)"
    }
}
