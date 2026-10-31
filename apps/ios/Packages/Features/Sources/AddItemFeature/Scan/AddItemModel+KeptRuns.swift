import Core
import Foundation

/// Upgrading a run's kept drafts (docs/features/thrift-scan.md, "Upgrading drafts"): the drafts
/// list groups them by run, Shoot this run takes their real photos, and the rapid review approves
/// them.
extension AddItemModel {
    /// The runs whose kept drafts are on this iPhone, newest first.
    var keptRuns: [KeptScanRun] {
        KeptScanRun.runs(of: drafts)
    }

    /// The drafts not kept in a scan run: single items, and scans kept before runs were recorded.
    var looseDrafts: [Draft] {
        drafts.filter { $0.record.scanRunID == nil }
    }

    /// Saves a guided shoot's photos to a kept scan's draft, in front of its scan shots, which go
    /// unless the seller keeps them. Returns whether they were saved; a failure shows its alert.
    func saveShoot(_ photos: [(PreparedPhoto, PhotoRole)], to draftID: String, keepingScanShots: Bool) async -> Bool {
        guard !photos.isEmpty else { return false }
        let store = store
        let result = await Task.detached(priority: .userInitiated) {
            Result {
                try store.replaceScanShots(of: draftID, with: photos, keepingScanShots: keepingScanShots).map(\.id)
            }
        }.value
        switch result {
        case let .success(dropped):
            let uploader = uploader
            await uploader.cancelTransfers(of: dropped)
            await uploader.wake()
            return true
        case let .failure(error):
            show(error)
            return false
        }
    }

    /// What the run's rapid review did: an approved item's draft is done on this iPhone.
    func handleRunReview(_ event: BatchReviewEvent) {
        if case let .saved(sessionID, _, _, _) = event {
            completeDraft(sessionID)
        }
        let uploader = uploader
        Task { await uploader.wake() }
    }
}
