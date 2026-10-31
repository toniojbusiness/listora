import DesignSystem
import Foundation
import ListoraAPI

/// A checked-out run as its summary shows it (docs/features/thrift-scan.md, "Checkout"): what
/// was scanned and kept, what the haul cost, the kept items' estimated resale and payout, and the
/// estimated profit, which exists only once the haul's total is known. Every resale number is
/// an estimate and says so.
struct RunSummaryCard: Equatable {
    let title: String
    /// "12 scanned · 3 kept · 8 miles".
    let counts: String
    /// "Paid $47.20 for 23 items · $2.05 each"; nil before checkout.
    let paid: String?
    /// "$310-$520"; nil when nothing kept had a range.
    let resale: String?
    /// "You'd get about $250-$430 after fees".
    let payout: String?
    /// "$203-$383", or "-$5 to $20" when the low end is a loss.
    let profit: String?
    let profitTone: StatusTone?
    let profitLabel: String?
    /// What the ranges rest on, with how many kept items they cover when not all.
    let basedOn: String?
    /// "Estimated", or the AI estimate's disclaimer: shown with the numbers, always.
    let estimateLabel: String?

    init(_ summary: SourcingRunSummary) {
        let run = summary.run
        title = run.place ?? "This run"
        var counts = ["\(run.scanCount) scanned", "\(summary.keptItems) kept"]
        if let miles = run.miles {
            counts.append(miles == 1 ? "1 mile" : "\(miles) miles")
        }
        self.counts = counts.joined(separator: " · ")
        paid = summary.haul.map { haul in
            let items = haul.itemCount == 1 ? "1 item" : "\(haul.itemCount) items"
            return "Paid \(Self.cents(haul.total)) for \(items) · \(Self.cents(haul.eachCost)) each"
        }
        if let estimate = summary.estimate {
            resale = ScanCard.range(estimate.resaleLow, estimate.resaleHigh)
            payout = ScanCard.range(estimate.payoutLow, estimate.payoutHigh).map { "You'd get about \($0) after fees" }
            let coverage = Int(estimate.itemCount) < Int(summary.keptItems)
                ? " (\(estimate.itemCount) of \(summary.keptItems) kept items)"
                : ""
            basedOn = estimate.basedOn + coverage
            estimateLabel = estimate.label
        } else {
            resale = nil
            payout = nil
            basedOn = summary.keptItems > 0 ? "Nothing kept had a price range to go on" : nil
            estimateLabel = nil
        }
        if let profit = summary.profitEstimate {
            self.profit = Self.profitRange(profit.low, profit.high)
            profitTone = profit.low
                .amountCents >= 0 ? .success : (profit.high.amountCents < 0 ? .failed : .actionNeeded)
            profitLabel = profit.label
        } else {
            profit = nil
            profitTone = nil
            profitLabel = nil
        }
    }

    /// Dollars and cents, as paid ("$47.20").
    static func cents(_ money: Components.Schemas.Money) -> String {
        (Decimal(money.amountCents) / 100).formatted(.currency(code: money.currency.rawValue))
    }

    /// "$203-$383", or "-$5 to $20" across zero, where a dash would read as a minus sign.
    static func profitRange(_ low: Components.Schemas.Money, _ high: Components.Schemas.Money) -> String {
        let lowText = ScanCard.dollars(low)
        let highText = ScanCard.dollars(high)
        if lowText == highText {
            return lowText
        }
        return low.amountCents < 0 ? "\(lowText) to \(highText)" : "\(lowText)-\(highText)"
    }
}
