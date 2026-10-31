import APIClient
import DesignSystem
import Foundation
import Observation

/// The run's checkout at the register (docs/features/thrift-scan.md, "Checkout"): the kept items
/// become one haul of what the seller paid, and the run ends. A kept item whose draft has not
/// reached Listora yet is sent with it, so none is left out. Nothing shows as checked out until
/// Listora answered; a failure says why and is tried again as the same checkout.
@MainActor
@Observable
final class ScanCheckoutModel {
    let run: ScanRunModel
    private(set) var isCheckingOut = false
    /// Why the last attempt failed; nil once one went through.
    private(set) var failure: String?
    /// The run's summary, with the estimated profit, once checked out.
    private(set) var summary: SourcingRunSummary?

    private let service: any ScanService
    private let now: () -> Date
    /// One checkout per run: a retry after a lost answer replays the one that went through.
    private let idempotencyKey = UUID().uuidString.lowercased()

    init(run: ScanRunModel, service: any ScanService, now: @escaping () -> Date = Date.init) {
        self.run = run
        self.service = service
        self.now = now
    }

    var canCheckOut: Bool {
        summary == nil && !isCheckingOut && run.canCheckOut
    }

    func checkout(totalCents: Int64, itemCount: Int, miles: Int?) async {
        guard canCheckOut, totalCents >= 0, itemCount >= 1 else { return }
        isCheckingOut = true
        failure = nil
        defer { isCheckingOut = false }
        let checkout = RunCheckout(
            totalCents: totalCents,
            itemCount: itemCount,
            keptScanIDs: run.keptScanIDs,
            place: run.place,
            purchaseDate: Self.localDate(now()),
            miles: miles,
        )
        do {
            let runID = try await run.serverRunID()
            summary = try await service.checkoutSourcingRun(runID: runID, checkout, idempotencyKey: idempotencyKey)
        } catch let failure as APIFailure {
            self.failure = failure.message
            Haptics.play(.failure)
            return
        } catch {
            failure = APIFailure.networkUnavailable.message
            Haptics.play(.failure)
            return
        }
        run.close()
        Haptics.play(.success)
    }

    /// The day on this iPhone, as the haul's purchase date ("2026-10-31").
    static func localDate(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}
