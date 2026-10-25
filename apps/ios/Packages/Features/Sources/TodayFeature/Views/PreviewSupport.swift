import APIClient
import Foundation
import ListoraAPI

/// A day with nothing to do, for SwiftUI previews.
private struct CaughtUpTodayService: TodayService {
    func today() async throws(APIFailure) -> Today {
        let period = TodayMoneyPeriod(
            start: Date(timeIntervalSinceNow: -7 * 86400),
            end: Date(),
            sales: 0,
            itemsSold: 0,
            salesTotal: .init(amountCents: 0, currency: .usd),
            profitPendingSales: 0,
        )
        return Today(generatedAt: Date(), cards: [], money: .init(thisWeek: period, lastWeek: period))
    }

    func summarySettings() async throws(APIFailure) -> SummarySettings {
        SummarySettings(enabled: true, time: "08:00")
    }

    func saveSummarySettings(enabled: Bool, time: String, timeZone: String) async throws(APIFailure)
        -> SummarySettings
    {
        SummarySettings(enabled: enabled, time: time, timeZone: timeZone)
    }
}

extension TodayEnvironment {
    /// A caught-up day, for previews.
    static var preview: TodayEnvironment {
        TodayEnvironment(service: CaughtUpTodayService())
    }
}
