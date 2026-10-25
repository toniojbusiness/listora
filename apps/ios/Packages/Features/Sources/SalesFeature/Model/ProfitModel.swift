import Foundation
import Observation

/// What the profit chart plots.
enum ProfitChartMetric: String, CaseIterable, Identifiable, Sendable {
    case netProfit
    case revenue

    var id: Self {
        self
    }

    var title: String {
        switch self {
        case .netProfit: "Net profit"
        case .revenue: "Revenue"
        }
    }
}

/// The profit dashboard: the chosen period and the server's report for it. Every number comes
/// from the server (`getProfit`); the app computes none of them. Changing the period reads the
/// report again; an answer for a period no longer chosen is dropped.
@MainActor
@Observable
final class ProfitModel {
    enum Phase: Equatable {
        case loading
        case loaded
        case signedOut
        case failed(message: String)
    }

    private(set) var period: ProfitPeriod
    private(set) var report: ProfitReport?
    private(set) var phase: Phase = .loading
    var chartMetric: ProfitChartMetric = .netProfit
    let calendar: Calendar
    private let service: any ProfitService
    private let isSignedIn: @MainActor () -> Bool
    private let now: @MainActor () -> Date

    init(
        service: any ProfitService,
        calendar: Calendar = .current,
        now: @escaping @MainActor () -> Date = { Date() },
        isSignedIn: @escaping @MainActor () -> Bool = { true },
    ) {
        self.service = service
        self.calendar = calendar
        self.now = now
        self.isSignedIn = isSignedIn
        period = ProfitPeriod.containing(now(), range: .month, calendar: calendar)
    }

    /// The report shown is for the chosen period (not one still loading).
    var isCurrent: Bool {
        guard let report else { return false }
        let query = period.query(calendar: calendar)
        return report.period.from == query.firstDay && report.period.to == query.lastDay
    }

    var canStepForward: Bool {
        period.range != .custom && !period.reachesToday(now(), calendar: calendar)
    }

    var title: String {
        period.title(calendar: calendar)
    }

    func load() async {
        guard isSignedIn() else {
            report = nil
            phase = .signedOut
            return
        }
        let requested = period
        phase = .loading
        do {
            let report = try await service.profit(requested.query(calendar: calendar))
            guard requested == period else { return }
            self.report = report
            phase = .loaded
        } catch {
            guard requested == period else { return }
            phase = .failed(message: error.message)
        }
    }

    /// The period of `range` that contains today; Custom keeps the days shown.
    func select(_ range: ProfitRange) async {
        guard range != period.range else { return }
        period = range == .custom
            ? ProfitPeriod.custom(from: period.start, to: period.end, calendar: calendar)
            : ProfitPeriod.containing(now(), range: range, calendar: calendar)
        await load()
    }

    /// The previous (`-1`) or next (`1`) week, month, or year.
    func step(_ steps: Int) async {
        guard period.range != .custom, steps < 0 || canStepForward else { return }
        period = period.shifted(by: steps, calendar: calendar)
        await load()
    }

    func setCustom(from start: Date, to end: Date) async {
        let chosen = ProfitPeriod.custom(from: start, to: end, calendar: calendar)
        guard chosen != period else { return }
        period = chosen
        await load()
    }
}
