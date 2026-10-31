import APIClient
import Core
import Foundation
import os

/// The run's marketplace comparisons (docs/features/thrift-scan.md, "Marketplace comparisons"):
/// each read the server hands out runs once on this iPhone's logged-out lane.
extension ScanRunModel {
    /// Reads each marketplace comparison the server handed out for the scan, once, on this
    /// iPhone's logged-out lane, and hands the server the numbers; the card takes in the answer.
    /// A read the lane can't make is answered as failed, so the card never says "Checking..."
    /// for one that will not come.
    func startComparisons(_ entryID: String, _ scan: ItemScan) {
        guard let comparisons else { return }
        for comparison in scan.comparisons ?? [] {
            guard let read = comparison.read, !startedReads.contains(read.id) else { continue }
            startedReads.insert(read.id)
            let marketplace = comparison.marketplace.value1?.rawValue ?? comparison.marketplace.value2 ?? ""
            let service = service
            let log = log
            Task { [weak self] in
                let started = Date()
                let input = (try? JSONEncoder().encode(read.input)) ?? Data()
                let answer = await comparisons.compare(input, marketplace: marketplace) ?? Self.notRead
                do {
                    let answered = try await service.saveScanComparison(
                        scanID: scan.id, comparisonID: read.id, answer: answer,
                    )
                    let elapsed = Int(Date().timeIntervalSince(started) * 1000)
                    log.info("scan comparison \(marketplace, privacy: .public) after \(elapsed, privacy: .public) ms")
                    self?.finishComparison(entryID, answered)
                } catch let failure as APIFailure {
                    log.error("Scan comparison failed: \(failure.message, privacy: .public)")
                    self?.failComparison(entryID, scanID: scan.id, marketplace: marketplace)
                } catch {
                    self?.failComparison(entryID, scanID: scan.id, marketplace: marketplace)
                }
            }
        }
    }

    /// The answer for a read the app could not make at all.
    private static let notRead = Data(
        #"{"outcome":"failed","ms":0,"message":"the app could not run the read"}"#.utf8,
    )

    private func finishComparison(_ entryID: String, _ scan: ItemScan) {
        guard entries.first(where: { $0.id == entryID })?.scanID == scan.id else { return }
        update(entryID) { entry in
            entry.scan = scan
            entry.state = .read(ScanCard(scan))
        }
    }

    private func failComparison(_ entryID: String, scanID: String, marketplace: String) {
        guard let entry = entries.first(where: { $0.id == entryID }), entry.scanID == scanID,
              let card = entry.card
        else { return }
        update(entryID) { $0.state = .read(card.comparisonFailed(marketplace)) }
    }
}
