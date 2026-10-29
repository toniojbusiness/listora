import APIClient
import Foundation
import ListoraAPI
import Testing
@testable import SalesFeature

private typealias Schemas = Components.Schemas

/// A scripted ``ReportsService`` that records each call it got.
private final class FakeReportsService: ReportsService, @unchecked Sendable {
    enum Call: Equatable {
        case year(Int, String)
        case export(ReportExport, Int, String)
    }

    private let lock = NSLock()
    private var _calls: [Call] = []
    private var _failures: [APIFailure] = []
    private var _fileName = "listora-sales-2026.csv"

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    var calls: [Call] {
        locked { _calls }
    }

    var failures: [APIFailure] {
        get { locked { _failures } }
        set { locked { _failures = newValue } }
    }

    var fileName: String {
        get { locked { _fileName } }
        set { locked { _fileName = newValue } }
    }

    private func failure() -> APIFailure? {
        locked { _failures.isEmpty ? nil : _failures.removeFirst() }
    }

    func yearReport(year: Int, timeZone: String) async throws(APIFailure) -> YearReport {
        locked { _calls.append(.year(year, timeZone)) }
        if let failure = failure() {
            throw failure
        }
        return report(year: year)
    }

    func export(_ export: ReportExport, year: Int, timeZone: String) async throws(APIFailure) -> CsvExport {
        locked { _calls.append(.export(export, year, timeZone)) }
        if let failure = failure() {
            throw failure
        }
        return .init(fileName: fileName, rowCount: 2, content: "\u{FEFF}SKU,Title\r\nAB-000001,Shirt\r\n")
    }
}

private func usd(_ cents: Int64) -> Schemas.Money {
    .init(amountCents: cents, currency: .usd)
}

private func report(year: Int) -> YearReport {
    let known = Schemas.ReportTotals(
        salesCount: 2,
        itemsSold: 3,
        revenue: usd(10000),
        shipping: usd(500),
        fees: usd(1000),
        feesUnknownCount: 0,
        costOfGoods: usd(2000),
        missingCostCount: 0,
        netProfit: usd(6500),
    )
    // Poshmark's fees are still an estimate there, so the year's fees and profit are not known.
    let estimated = Schemas.ReportTotals(
        salesCount: 1,
        itemsSold: 1,
        revenue: usd(4000),
        shipping: usd(0),
        feesUnknownCount: 1,
        costOfGoods: usd(800),
        missingCostCount: 0,
    )
    return .init(
        year: Int32(year),
        timeZone: "America/New_York",
        total: .init(
            salesCount: 3,
            itemsSold: 4,
            revenue: usd(14000),
            shipping: usd(500),
            feesUnknownCount: 1,
            costOfGoods: usd(2800),
            missingCostCount: 0,
        ),
        months: [.init(month: "\(year)-03", totals: known), .init(month: "\(year)-05", totals: estimated)],
        marketplaces: [
            .init(marketplace: .init(value1: .ebay), totals: known),
            .init(marketplace: .init(value1: .poshmark), totals: estimated),
        ],
    )
}

private let calendar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/New_York") ?? .gmt
    calendar.locale = Locale(identifier: "en_US")
    return calendar
}()

/// December 31, 2026, 11 PM in New York (already 2027 in UTC).
private let now = calendar.date(from: DateComponents(year: 2026, month: 12, day: 31, hour: 23)) ?? .distantPast

@MainActor
@Suite("Reports")
struct ReportsModelTests {
    private let directory = FileManager.default.temporaryDirectory
        .appending(path: "ReportsModelTests-\(UUID().uuidString)", directoryHint: .isDirectory)

    private func model(_ service: FakeReportsService, signedIn: Bool = true) -> ReportsModel {
        ReportsModel(
            service: service,
            calendar: calendar,
            now: { now },
            isSignedIn: { signedIn },
            directory: directory,
        )
    }

    @Test
    func `opens on this year in the calendar's time zone, and shows the server's numbers`() async {
        let service = FakeReportsService()
        let model = model(service)
        await model.load()
        #expect(model.year == 2026)
        #expect(model.phase == .loaded)
        #expect(model.isCurrent)
        #expect(service.calls == [.year(2026, "America/New_York")])
        // The server left the year's fees and profit out: not known, never zero.
        #expect(model.report?.total.fees == nil)
        #expect(model.report?.total.netProfit == nil)
    }

    @Test
    func `steps back through years but never past this one`() async {
        let service = FakeReportsService()
        let model = model(service)
        #expect(!model.canStepForward)
        await model.step(1)
        #expect(model.year == 2026)
        #expect(service.calls.isEmpty)
        await model.step(-1)
        #expect(model.year == 2025)
        #expect(model.canStepForward)
        #expect(service.calls == [.year(2025, "America/New_York")])
        #expect(model.report?.year == 2025)
    }

    @Test
    func `a failure keeps the report shown, and a retry reads it again`() async {
        let service = FakeReportsService()
        let model = model(service)
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
        let service = FakeReportsService()
        let model = model(service, signedIn: false)
        await model.load()
        #expect(model.phase == .signedOut)
        #expect(service.calls.isEmpty)
    }

    @Test
    func `prepares an export as a CSV file on the phone, ready to share`() async throws {
        let service = FakeReportsService()
        let model = model(service)
        await model.prepare(.sales)
        guard case let .ready(file) = model.exportState(.sales) else {
            Issue.record("not ready: \(model.exportState(.sales))")
            return
        }
        #expect(file.url.lastPathComponent == "listora-sales-2026.csv")
        #expect(file.rowCount == 2)
        // Byte for byte, the byte order mark included (reading a String would drop it).
        let saved = try Data(contentsOf: file.url)
        #expect(saved == Data("\u{FEFF}SKU,Title\r\nAB-000001,Shirt\r\n".utf8))
        #expect(service.calls == [.export(.sales, 2026, "America/New_York")])
        #expect(model.exportState(.inventory) == .idle)
    }

    @Test
    func `a failed export says why and can be tried again`() async {
        let service = FakeReportsService()
        let model = model(service)
        service.failures = [.networkUnavailable]
        await model.prepare(.inventory)
        #expect(model.exportState(.inventory) == .failed(message: APIFailure.networkUnavailable.message))
        await model.prepare(.inventory)
        guard case .ready = model.exportState(.inventory) else {
            Issue.record("not ready: \(model.exportState(.inventory))")
            return
        }
    }

    @Test
    func `another year drops the sales export made for the last one, not the inventory`() async {
        let service = FakeReportsService()
        let model = model(service)
        await model.prepare(.sales)
        await model.prepare(.inventory)
        await model.step(-1)
        #expect(model.exportState(.sales) == .idle)
        guard case .ready = model.exportState(.inventory) else {
            Issue.record("inventory export dropped")
            return
        }
    }

    @Test
    func `saves under the server's name only, inside its own folder`() {
        #expect(ReportsModel.safeFileName("listora-sales-2026.csv") == "listora-sales-2026.csv")
        #expect(ReportsModel.safeFileName("../../etc/passwd") == "passwd.csv")
        #expect(ReportsModel.safeFileName("..") == "listora-export.csv")
        #expect(ReportsModel.safeFileName("") == "listora-export.csv")
    }

    @Test
    func `says why a number is not known yet`() {
        let totals = report(year: 2026).total
        #expect(ReportNotes.fees(totals) == "1 sale's fees aren't final from the marketplace")
        #expect(ReportNotes.rowProfit(totals) == "Profit waits for final fees")
        #expect(ReportNotes.rowProfit(report(year: 2026).months[0].totals) == "Profit $65.00")
    }
}
