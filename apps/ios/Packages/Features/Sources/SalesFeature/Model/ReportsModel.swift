import APIClient
import Foundation
import Observation

/// A CSV export saved on the phone, ready for the share sheet.
struct ExportedFile: Equatable, Sendable {
    let url: URL
    let rowCount: Int
}

/// The Reports screen: the chosen year and the server's report for it, and the CSV exports.
/// Every number comes from the server (`getYearReport`); the app computes none of them, and shows
/// a number the server left out (one it cannot compute reliably) as not known, never as zero.
/// Changing the year reads the report again; an answer for a year no longer chosen is dropped.
@MainActor
@Observable
final class ReportsModel {
    enum Phase: Equatable {
        case loading
        case loaded
        case signedOut
        case failed(message: String)
    }

    enum ExportState: Equatable {
        case idle
        case preparing
        case ready(ExportedFile)
        case failed(message: String)
    }

    private(set) var year: Int
    private(set) var report: YearReport?
    private(set) var phase: Phase = .loading
    private(set) var exports: [ReportExport: ExportState] = [:]
    /// The chosen year's expenses, oldest first, once read (`listExpenses`).
    private(set) var expenses: [Expense]?
    /// Why the expenses couldn't be read or the last change to them failed, for a Retry.
    private(set) var expenseFailure: String?
    /// An expense or rate change on its way to the server.
    private(set) var isSavingExpense = false
    let calendar: Calendar
    private let service: any ReportsService
    private let isSignedIn: @MainActor () -> Bool
    private let now: @MainActor () -> Date
    /// Where the exports are saved: the app's temporary directory, which the system clears.
    private let directory: URL

    init(
        service: any ReportsService,
        calendar: Calendar = .current,
        now: @escaping @MainActor () -> Date = { Date() },
        isSignedIn: @escaping @MainActor () -> Bool = { true },
        directory: URL = FileManager.default.temporaryDirectory.appending(path: "Reports", directoryHint: .isDirectory),
    ) {
        self.service = service
        self.calendar = calendar
        self.now = now
        self.isSignedIn = isSignedIn
        self.directory = directory
        year = calendar.component(.year, from: now())
    }

    /// The report shown is for the chosen year (not one still loading).
    var isCurrent: Bool {
        report?.year == Int32(year)
    }

    /// Never past the year that contains today.
    var canStepForward: Bool {
        year < calendar.component(.year, from: now())
    }

    var timeZone: String {
        calendar.timeZone.identifier
    }

    func exportState(_ export: ReportExport) -> ExportState {
        exports[export] ?? .idle
    }

    func load() async {
        guard isSignedIn() else {
            report = nil
            phase = .signedOut
            return
        }
        let requested = year
        phase = .loading
        do {
            let report = try await service.yearReport(year: requested, timeZone: timeZone)
            guard requested == year else { return }
            self.report = report
            phase = .loaded
        } catch {
            guard requested == year else { return }
            phase = .failed(message: error.message)
        }
    }

    /// The previous (`-1`) or next (`1`) year; an export made for another year is dropped.
    func step(_ steps: Int) async {
        guard steps < 0 || canStepForward else { return }
        year += steps
        exports[.sales] = nil
        exports[.expenses] = nil
        expenses = nil
        expenseFailure = nil
        await load()
    }

    // MARK: Expenses (docs/features/expenses.md)

    /// Reads the chosen year's expenses for the list.
    func loadExpenses() async {
        let requested = year
        do {
            let list = try await service.expenses(year: requested)
            guard requested == year else { return }
            expenses = list
            expenseFailure = nil
        } catch {
            guard requested == year else { return }
            expenseFailure = error.message
        }
    }

    /// Records an expense, then reads the year's report and list again. `nil` when it went
    /// through, otherwise why not (nothing was recorded; the same key makes a retry safe).
    func addExpense(_ expense: ExpenseWrite, idempotencyKey: String) async -> String? {
        await change { [service] () async throws(APIFailure) in _ = try await service.addExpense(
            expense,
            idempotencyKey: idempotencyKey,
        ) }
    }

    func deleteExpense(id: String) async -> String? {
        await change { [service] () async throws(APIFailure) in try await service.deleteExpense(id: id) }
    }

    /// The chosen year's standard mileage rate, in tenths of a cent per mile.
    func setMileageRate(tenthCentsPerMile: Int) async -> String? {
        let requested = year
        return await change { [service] () async throws(APIFailure) in
            _ = try await service.setMileageRate(year: requested, tenthCentsPerMile: tenthCentsPerMile)
        }
    }

    private func change(_ body: @Sendable () async throws(APIFailure) -> Void) async -> String? {
        guard !isSavingExpense else { return "Still saving the last change." }
        isSavingExpense = true
        defer { isSavingExpense = false }
        do {
            try await body()
        } catch {
            return error.message
        }
        // Every number stays the server's: the totals and the list are read again.
        exports[.expenses] = nil
        await load()
        await loadExpenses()
        return nil
    }

    /// Reads the export from the server and saves it as its file, for the share sheet.
    func prepare(_ export: ReportExport) async {
        guard exportState(export) != .preparing else { return }
        let requested = year
        exports[export] = .preparing
        let file: CsvExport
        do {
            file = try await service.export(export, year: requested, timeZone: timeZone)
        } catch {
            guard export == .inventory || requested == year else { return }
            exports[export] = .failed(message: error.message)
            return
        }
        guard export == .inventory || requested == year else { return }
        do {
            let url = try save(file)
            exports[export] = .ready(ExportedFile(url: url, rowCount: Int(file.rowCount)))
        } catch {
            exports[export] = .failed(message: "Couldn't save the file on this iPhone. Try again.")
        }
    }

    private func save(_ file: CsvExport) throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appending(path: Self.safeFileName(file.fileName))
        try Data(file.content.utf8).write(to: url, options: [.atomic, .completeFileProtection])
        return url
    }

    /// The server's name without any folder, always ending in `.csv`.
    static func safeFileName(_ name: String) -> String {
        let base = name
            .split(whereSeparator: { $0 == "/" || $0 == "\\" || $0 == ":" })
            .last
            .map(String.init) ?? ""
        let trimmed = base.trimmingCharacters(in: .whitespacesAndNewlines.union(.init(charactersIn: ".")))
        let stem = trimmed.isEmpty ? "listora-export" : trimmed
        return stem.lowercased().hasSuffix(".csv") ? stem : "\(stem).csv"
    }
}
