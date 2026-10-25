import APIClient
import Foundation
import ListoraAPI
import Testing
@testable import SalesFeature

private typealias Schemas = Components.Schemas

/// A scripted ``ProfitService`` that records each period it was asked for.
private final class FakeProfitService: ProfitService, @unchecked Sendable {
    private let lock = NSLock()
    private var _requests: [ProfitQuery] = []
    private var _failures: [APIFailure] = []

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    var requests: [ProfitQuery] {
        locked { _requests }
    }

    var failures: [APIFailure] {
        get { locked { _failures } }
        set { locked { _failures = newValue } }
    }

    func profit(_ query: ProfitQuery) async throws(APIFailure) -> ProfitReport {
        locked { _requests.append(query) }
        if let failure = locked({ _failures.isEmpty ? nil : _failures.removeFirst() }) {
            throw failure
        }
        return report(for: query)
    }
}

private func usd(_ cents: Int64) -> Schemas.Money {
    .init(amountCents: cents, currency: .usd)
}

private func report(for query: ProfitQuery) -> ProfitReport {
    .init(
        period: .init(
            from: query.firstDay,
            to: query.lastDay,
            timeZone: query.timeZone,
            granularity: .init(value1: .day),
        ),
        summary: .init(
            revenue: usd(10000),
            fees: usd(1000),
            shipping: usd(500),
            costOfGoods: usd(2000),
            netProfit: usd(6500),
            roiBasisPoints: 32500,
            salesCount: 3,
            itemsSold: 4,
            missingCostCount: 0,
            feesEstimated: false,
        ),
        series: [],
        marketplaces: [],
        brands: .init(best: [], worst: []),
        categories: .init(best: [], worst: []),
        deadStock: .init(
            over60Days: .init(itemCount: 0, cost: usd(0), missingCostCount: 0),
            over90Days: .init(itemCount: 0, cost: usd(0), missingCostCount: 0),
            oldest: [],
        ),
    )
}

/// New York, weeks from Sunday, so the tests do not depend on the machine's settings.
private let newYork = TimeZone(identifier: "America/New_York") ?? .gmt

private let calendar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = newYork
    calendar.locale = Locale(identifier: "en_US")
    calendar.firstWeekday = 1
    return calendar
}()

private func date(_ year: Int, _ month: Int, _ day: Int, hour: Int = 12) -> Date {
    calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour)) ?? .distantPast
}

private func query(_ firstDay: String, _ lastDay: String) -> ProfitQuery {
    ProfitQuery(firstDay: firstDay, lastDay: lastDay, timeZone: "America/New_York")
}

/// Wednesday, October 21, 2026, 11 PM in New York (already the 22nd in UTC).
private let now = date(2026, 10, 21, hour: 23)

@Suite("Profit period")
struct ProfitPeriodTests {
    @Test
    func `the month, week, and year contain today, in the calendar's time zone`() {
        let month = ProfitPeriod.containing(now, range: .month, calendar: calendar)
        #expect(month.query(calendar: calendar) == query("2026-10-01", "2026-10-31"))
        #expect(month.title(calendar: calendar) == "October 2026")

        let week = ProfitPeriod.containing(now, range: .week, calendar: calendar)
        #expect(week.query(calendar: calendar) == query("2026-10-18", "2026-10-24"))

        let year = ProfitPeriod.containing(now, range: .year, calendar: calendar)
        #expect(year.query(calendar: calendar) == query("2026-01-01", "2026-12-31"))
        #expect(year.title(calendar: calendar) == "2026")
    }

    @Test
    func `steps through whole periods across a year end`() {
        let january = ProfitPeriod.containing(date(2026, 1, 15), range: .month, calendar: calendar)
        let december = january.shifted(by: -1, calendar: calendar)
        #expect(december.query(calendar: calendar) == query("2025-12-01", "2025-12-31"))
        #expect(december.shifted(by: 1, calendar: calendar) == january)
        let february = january.shifted(by: 1, calendar: calendar)
        #expect(february.query(calendar: calendar) == query("2026-02-01", "2026-02-28"))
    }

    @Test
    func `a custom period is in order and at most ten years long`() {
        let custom = ProfitPeriod.custom(from: date(2026, 10, 20), to: date(2026, 10, 1), calendar: calendar)
        #expect(custom.range == .custom)
        #expect(custom.query(calendar: calendar) == query("2026-10-01", "2026-10-20"))

        let long = ProfitPeriod.custom(from: date(1990, 1, 1), to: date(2026, 10, 20), calendar: calendar)
        let days = calendar.dateComponents([.day], from: long.start, to: long.end).day ?? 0
        #expect(days + 1 == ProfitPeriod.maximumDays)
    }
}

@MainActor
@Suite("Profit model")
struct ProfitModelTests {
    @Test
    func `loads this month in the seller's time zone`() async {
        let service = FakeProfitService()
        let model = ProfitModel(service: service, calendar: calendar, now: { now })
        await model.load()
        #expect(model.phase == .loaded)
        #expect(model.isCurrent)
        #expect(model.report?.summary.netProfit.amountCents == 6500)
        #expect(service.requests == [query("2026-10-01", "2026-10-31")])
    }

    @Test
    func `never steps past the period that contains today`() async {
        let service = FakeProfitService()
        let model = ProfitModel(service: service, calendar: calendar, now: { now })
        #expect(!model.canStepForward)
        await model.step(1)
        #expect(service.requests.isEmpty)

        await model.step(-1)
        #expect(model.title == "September 2026")
        #expect(model.canStepForward)
        await model.select(.year)
        #expect(service.requests.last == query("2026-01-01", "2026-12-31"))
    }

    @Test
    func `custom keeps the days shown, then reads the days chosen`() async {
        let service = FakeProfitService()
        let model = ProfitModel(service: service, calendar: calendar, now: { now })
        await model.select(.week)
        await model.select(.custom)
        #expect(model.period.range == .custom)
        #expect(service.requests.last == query("2026-10-18", "2026-10-24"))
        #expect(!model.canStepForward)
        await model.setCustom(from: date(2026, 9, 1), to: date(2026, 9, 30))
        #expect(service.requests.last == query("2026-09-01", "2026-09-30"))
    }

    @Test
    func `a failure keeps the last report and says why, and a retry reads again`() async {
        let service = FakeProfitService()
        let model = ProfitModel(service: service, calendar: calendar, now: { now })
        await model.load()
        service.failures = [.networkUnavailable]
        await model.load()
        #expect(model.phase == .failed(message: APIFailure.networkUnavailable.message))
        #expect(model.report != nil)
        await model.load()
        #expect(model.phase == .loaded)
    }

    @Test
    func `signed out, it never calls the server`() async {
        let service = FakeProfitService()
        let model = ProfitModel(service: service, calendar: calendar, now: { now }, isSignedIn: { false })
        await model.load()
        #expect(model.phase == .signedOut)
        #expect(service.requests.isEmpty)
    }
}
