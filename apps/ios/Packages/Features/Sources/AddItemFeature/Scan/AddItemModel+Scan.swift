import Core
import Foundation

/// Scan mode (docs/features/thrift-scan.md): the run at the store, and the drafts it keeps.
extension AddItemModel {
    /// The run going on, or a new one.
    func scanRun(in environment: AddItemEnvironment) -> ScanRunModel {
        if let scanRun, !scanRun.isEnded {
            return scanRun
        }
        let run = ScanRunModel(
            service: environment.scanService,
            tagReader: environment.tagReader,
            directory: environment.scanDirectory,
            saveDraft: { [weak self] photos, scanID in await self?.saveScanDraft(photos, scanID: scanID) },
        )
        meter.begin(run.meterSession)
        scanRun = run
        return run
    }

    /// A kept scan's draft: saved on this iPhone at once, its server item created from the scan by
    /// the upload queue.
    func saveScanDraft(_ photos: [(PreparedPhoto, PhotoRole)], scanID: String) async -> String? {
        let store = store
        let result = await Task.detached(priority: .userInitiated) {
            Result { try store.createDraft(photos: photos, scanID: scanID).id }
        }.value
        switch result {
        case let .success(id):
            await uploader.wake()
            return id
        case let .failure(error):
            log.error("Saving a kept scan failed: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    /// Ends the run going on: its items not kept are skipped; the kept drafts stay.
    func endScanRun() async {
        guard let run = scanRun else { return }
        scanRun = nil
        if let session = meter.session(run.meterSession) {
            let active = session.active.formatted(.number.precision(.fractionLength(1)))
            let counts = "\(run.entries.count) scanned, \(run.keptCount) kept"
            log.info("scan run ended: \(counts, privacy: .public), active \(active, privacy: .public) s")
        }
        meter.discard(run.meterSession)
        await run.end()
    }
}
