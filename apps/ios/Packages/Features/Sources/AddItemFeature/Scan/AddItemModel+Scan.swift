import Core
import Foundation

/// Scan mode (docs/features/thrift-scan.md): the run at the store, kept by ``ScanRuns``.
extension AddItemModel {
    /// The run going on, if any.
    var scanRun: ScanRunModel? {
        scanRuns?.current
    }

    /// The marketplaces with a comparison reader on this iPhone, in the card's order.
    static let comparedMarketplaces = ["depop", "ebay"]

    /// The run going on, or a new one at the place the seller named (nil: none).
    func startScanRun(in environment: AddItemEnvironment, place: String? = nil) -> ScanRunModel? {
        // Comparisons only where they passed live (or the owner's Test mode), Depop first.
        let comparing = Self.comparedMarketplaces.filter {
            environment.features?.shows(.marketComps, on: $0) == true
        }
        guard let run = scanRuns?.startOrResume(
            place: place,
            comparisons: environment.comparisons,
            comparing: comparing,
        )
        else { return nil }
        meter.begin(run.meterSession)
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
        scanRuns?.closed(checkout.run)
        scanCheckout = nil
        lastRunSummary = summary
    }

    /// Ends the run going on: its items not kept are skipped; the kept drafts stay, and kept
    /// scans waiting for signal are saved once they are read.
    func endScanRun() async {
        guard let scanRuns, let run = scanRuns.current else { return }
        logEnd(of: run)
        await scanRuns.end(run)
    }

    /// The run's active time, logged as it ends, and its measurement dropped.
    private func logEnd(of run: ScanRunModel) {
        if let session = meter.session(run.meterSession) {
            let active = session.active.formatted(.number.precision(.fractionLength(1)))
            let counts = "\(run.entries.count) scanned, \(run.keptCount) kept, \(run.waitingCount) waiting for signal"
            log.info("scan run ended: \(counts, privacy: .public), active \(active, privacy: .public) s")
        }
        meter.discard(run.meterSession)
    }
}
