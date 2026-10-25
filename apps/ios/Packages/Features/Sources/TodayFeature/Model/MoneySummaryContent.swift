import DesignSystem
import Foundation
import ListoraAPI

/// The money summary's words: this week's sales next to last week's, and the profit where the
/// server knows it. A profit the server does not know is never shown as a number.
struct MoneySummaryContent: Equatable {
    struct Comparison: Equatable {
        let text: String
        let systemImage: String
        let tone: StatusTone
    }

    let sales: String
    let itemsSold: String
    let comparison: Comparison
    /// "$64", or nil while no sale's profit is known.
    let profit: String?
    /// Why the profit is missing or partial; nil when every sale is counted.
    let profitNote: String?
    /// False when neither week had a sale, so the summary has nothing to say.
    let hasSales: Bool

    init(_ money: Components.Schemas.TodayMoney) {
        let week = money.thisWeek
        let last = money.lastWeek
        sales = TodayFormatting.money(week.salesTotal)
        itemsSold = week.itemsSold == 1 ? "1 item sold" : "\(week.itemsSold) items sold"
        hasSales = week.sales + last.sales > 0
        let difference = week.salesTotal.amountCents - last.salesTotal.amountCents
        let amount = TodayFormatting.money(.init(amountCents: abs(difference), currency: week.salesTotal.currency))
        comparison = if difference > 0 {
            Comparison(text: "\(amount) more than last week", systemImage: "arrow.up.right", tone: .success)
        } else if difference < 0 {
            Comparison(text: "\(amount) less than last week", systemImage: "arrow.down.right", tone: .neutral)
        } else {
            Comparison(text: "Same as last week", systemImage: "equal", tone: .neutral)
        }
        profit = week.profit.map(TodayFormatting.money)
        let missing = Int(week.profitPendingSales)
        profitNote = if missing == 0 {
            nil
        } else if week.profit == nil {
            "Shows once each sale's fees and item costs are in."
        } else {
            missing == 1
                ? "Not counting 1 sale whose fees or cost aren't in yet."
                : "Not counting \(missing) sales whose fees or costs aren't in yet."
        }
    }
}
