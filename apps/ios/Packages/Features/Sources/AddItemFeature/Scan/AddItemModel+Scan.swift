import Core
import Foundation

/// Scan mode (docs/features/thrift-scan.md): the run at the store, and the drafts it keeps.
extension AddItemModel {
    /// The marketplaces with a comparison reader on this iPhone.
    static let comparedMarketplaces = ["depop"]

    /// The run going on, or a new one at the place the seller named (nil: none).
    func scanRun(in environment: AddItemEnvironment, place: String? = nil) -> ScanRunModel {
        if let scanRun, !scanRun.isEnded {
            return scanRun
        }
        // Comparisons only where they passed live (or the owner's Test mode), Depop first.
        let comparing = Self.comparedMarketplaces.filter {
            environment.features?.shows(.marketComps, on: $0) == true
        }
        let run = ScanRunModel(
            service: environment.scanService,
            tagReader: environment.tagReader,
            directory: environment.scanDirectory,
            place: place,
            saveDraft: { [weak self] photos, scan in await self?.saveScanDraft(photos, scan: scan) },
            comparisons: environment.comparisons,
            comparing: comparing,
        )
        meter.begin(run.meterSession)
        scanRun = run
        lastRunSummary = nil
        return run
    }

    /// The places the seller bought from lately, the cost screen's too.
    var recentPlaces: RecentPurchaseSources {
        RecentPurchaseSources(defaults: defaults)
    }

    /// The checkout of the run going on, one per run.
    func scanCheckout(for run: ScanRunModel, in environment: AddItemEnvironment) -> ScanCheckoutModel {
        if let scanCheckout, scanCheckout.run === run {
            return scanCheckout
        }
        let checkout = ScanCheckoutModel(run: run, service: environment.scanService)
        scanCheckout = checkout
        return checkout
    }

    /// Checks the run out at the register; once it went through, the run is over, its place is
    /// remembered, and its summary stays on Add Item until the next run starts.
    func checkOut(_ checkout: ScanCheckoutModel, totalCents: Int64, itemCount: Int, miles: Int?) async {
        await checkout.checkout(totalCents: totalCents, itemCount: itemCount, miles: miles)
        guard let summary = checkout.summary else { return }
        if let place = summary.run.place {
            recentPlaces.remember(place)
        }
        logEnd(of: checkout.run)
        if scanRun === checkout.run {
            scanRun = nil
        }
        scanCheckout = nil
        lastRunSummary = summary
    }

    /// A kept scan's draft: saved on this iPhone at once, its server item created from the scan by
    /// the upload queue.
    func saveScanDraft(_ photos: [(PreparedPhoto, PhotoRole)], scan: DraftScanOrigin) async -> String? {
        let store = store
        let result = await Task.detached(priority: .userInitiated) {
            Result { try store.createDraft(photos: photos, scan: scan).id }
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
        logEnd(of: run)
        await run.end()
    }

    /// The run's active time, logged as it ends, and its measurement dropped.
    private func logEnd(of run: ScanRunModel) {
        if let session = meter.session(run.meterSession) {
            let active = session.active.formatted(.number.precision(.fractionLength(1)))
            let counts = "\(run.entries.count) scanned, \(run.keptCount) kept"
            log.info("scan run ended: \(counts, privacy: .public), active \(active, privacy: .public) s")
        }
        meter.discard(run.meterSession)
    }
}
