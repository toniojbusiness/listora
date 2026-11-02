import APIClient
import DesignSystem
import Foundation

/// The card's prices (docs/features/thrift-scan.md, "Prices after the facts"): the server holds a
/// scan's prices and call until its web research and its marketplace comparisons are in, and
/// starts the research as the read lands. The card asks for them at once and the answer comes
/// when they are in (about 15 seconds at most), without holding the card or the camera up.
extension ScanRunModel {
    /// Asks for the scan's prices once: a read whose prices wait, or (from a server that holds
    /// none) one with a brand to look up on the web.
    func startResearch(_ entryID: String, scanID: String) {
        guard let entry = entries.first(where: { $0.id == entryID }), entry.scanID == scanID,
              entry.research == .none, let card = entry.card, card.needsPrices
        else { return }
        update(entryID) { $0.research = .checking }
        let service = service
        Task { [weak self] in
            let result: Result<ItemScan, APIFailure>
            do {
                result = try await .success(service.researchScan(
                    scanID: scanID,
                    idempotencyKey: UUID().uuidString.lowercased(),
                ))
            } catch let failure as APIFailure {
                result = .failure(failure)
            } catch {
                result = .failure(.networkUnavailable)
            }
            self?.finishResearch(entryID, scanID: scanID, result)
        }
    }

    /// Asks again for prices that never came (the card's Retry).
    func retryPrices(_ entryID: String) {
        guard let entry = entries.first(where: { $0.id == entryID }), entry.research == .failed,
              let scanID = entry.scanID
        else { return }
        update(entryID) { $0.research = .none }
        startResearch(entryID, scanID: scanID)
    }

    private func finishResearch(_ entryID: String, scanID: String, _ result: Result<ItemScan, APIFailure>) {
        // A later read of the item (a note, the tag) replaced this scan: its prices are stale.
        guard entries.first(where: { $0.id == entryID })?.scanID == scanID else { return }
        switch result {
        case let .success(scan):
            take(entryID, scan)
            update(entryID) { $0.research = .done }
            startComparisons(entryID, scan)
        case let .failure(failure):
            log.error("Scan prices failed: \(failure.message, privacy: .public)")
            update(entryID) { $0.research = .failed }
        }
    }

    /// The card takes in a newer answer of its scan. Prices that just came in are felt on the
    /// card in view, as a read's call is: the seller learns the call without looking.
    func take(_ entryID: String, _ scan: ItemScan) {
        let before = entries.first(where: { $0.id == entryID })?.card
        let card = ScanCard(scan)
        update(entryID) { entry in
            entry.scan = scan
            entry.state = .read(card)
        }
        if before?.pricesPending == true, !card.pricesPending, currentID == entryID,
           let haptic = card.haptic
        {
            Haptics.play(haptic)
        }
    }
}
