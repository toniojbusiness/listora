import APIClient
import Foundation

/// The run's web research (docs/features/thrift-scan.md, "Web info"): asked for once a read's
/// card has been on screen a moment, without holding the card up.
extension ScanRunModel {
    /// Looks the read up on the web once its card has been on screen for ``researchDwell``, unless
    /// the seller moved on by then (shot the next item, asked for the tag, or added a note).
    func scheduleResearch(_ entryID: String, scanID: String) {
        guard researchDwell > .zero else {
            startResearch(entryID, scanID: scanID)
            return
        }
        let dwell = researchDwell
        Task { [weak self] in
            try? await Task.sleep(for: dwell)
            guard let self, !isEnded, currentID == entryID, tagShotFor == nil else { return }
            startResearch(entryID, scanID: scanID)
        }
    }

    /// Looks the read item up on the web in the background: the card shows the read at once and
    /// takes in the research, and the call made again with it, when it comes. Once per scan.
    func startResearch(_ entryID: String, scanID: String) {
        guard let entry = entries.first(where: { $0.id == entryID }), entry.scanID == scanID,
              entry.research == .none, entry.card?.hasBrand == true
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

    private func finishResearch(_ entryID: String, scanID: String, _ result: Result<ItemScan, APIFailure>) {
        // A later read of the item (a note, the tag) replaced this scan: its research is stale.
        guard entries.first(where: { $0.id == entryID })?.scanID == scanID else { return }
        switch result {
        case let .success(scan):
            update(entryID) { entry in
                entry.scan = scan
                entry.state = .read(ScanCard(scan))
                entry.research = .done
            }
            startComparisons(entryID, scan)
        case let .failure(failure):
            log.error("Scan research failed: \(failure.message, privacy: .public)")
            update(entryID) { $0.research = .failed }
        }
    }
}
