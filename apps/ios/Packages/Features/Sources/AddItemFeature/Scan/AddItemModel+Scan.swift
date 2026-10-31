import Core
import Foundation

/// Scan mode (docs/features/thrift-scan.md): the run at the store, kept by ``ScanRuns``.
extension AddItemModel {
    /// The run going on, if any.
    var scanRun: ScanRunModel? {
        scanRuns?.current
    }

    /// The marketplaces with a comparison reader on this iPhone.
    static let comparedMarketplaces = ["depop"]

    /// The run going on, or a new one.
    func startScanRun(in environment: AddItemEnvironment) -> ScanRunModel? {
        // Comparisons only where they passed live (or the owner's Test mode), Depop first.
        let comparing = Self.comparedMarketplaces.filter {
            environment.features?.shows(.marketComps, on: $0) == true
        }
        guard let run = scanRuns?.startOrResume(comparisons: environment.comparisons, comparing: comparing)
        else { return nil }
        meter.begin(run.meterSession)
        return run
    }

    /// Ends the run going on: its items not kept are skipped; the kept drafts stay, and kept
    /// scans waiting for signal are saved once they are read.
    func endScanRun() async {
        guard let scanRuns, let run = scanRuns.current else { return }
        if let session = meter.session(run.meterSession) {
            let active = session.active.formatted(.number.precision(.fractionLength(1)))
            let counts = "\(run.entries.count) scanned, \(run.keptCount) kept, \(run.waitingCount) waiting for signal"
            log.info("scan run ended: \(counts, privacy: .public), active \(active, privacy: .public) s")
        }
        meter.discard(run.meterSession)
        await scanRuns.end(run)
    }
}
