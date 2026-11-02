import APIClient
import Foundation
import ListoraAPI

typealias YearReport = Components.Schemas.YearReport
typealias ReportTotals = Components.Schemas.ReportTotals
typealias CsvExport = Components.Schemas.CsvExport
typealias Expense = Components.Schemas.Expense
typealias ExpenseWrite = Components.Schemas.ExpenseWrite
typealias MileageRate = Components.Schemas.MileageRate
typealias YearExpenses = Components.Schemas.YearExpenses

/// What a CSV export holds: a year's sales or expenses, or the inventory now.
enum ReportExport: String, CaseIterable, Identifiable, Sendable {
    case sales
    case expenses
    case inventory

    var id: Self {
        self
    }
}

/// The Reports screen's calls (`getYearReport`, the CSV exports, and the year's expenses and
/// mileage rate, docs/features/expenses.md), returning the contract's bodies and throwing
/// ``APIFailure`` for every other answer. A protocol so the model's tests run against a fake.
protocol ReportsService: Sendable {
    func yearReport(year: Int, timeZone: String) async throws(APIFailure) -> YearReport
    func export(_ export: ReportExport, year: Int, timeZone: String) async throws(APIFailure) -> CsvExport
    func expenses(year: Int) async throws(APIFailure) -> [Expense]
    func addExpense(_ expense: ExpenseWrite, idempotencyKey: String) async throws(APIFailure) -> Expense
    func deleteExpense(id: String) async throws(APIFailure)
    func setMileageRate(year: Int, tenthCentsPerMile: Int) async throws(APIFailure) -> MileageRate
}

/// ``ReportsService`` over the generated client.
struct APIReportsService: ReportsService {
    let client: Client

    func yearReport(year: Int, timeZone: String) async throws(APIFailure) -> YearReport {
        let output: Operations.GetYearReport.Output
        do {
            output = try await client.getYearReport(query: .init(year: Int32(year), timeZone: timeZone))
        } catch {
            throw APIFailure(error)
        }
        switch output {
        case let .ok(response):
            do {
                return try response.body.json
            } catch {
                throw APIFailure(error)
            }
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func export(_ export: ReportExport, year: Int, timeZone: String) async throws(APIFailure) -> CsvExport {
        switch export {
        case .sales: try await sales(year: year, timeZone: timeZone)
        case .expenses: try await expensesFile(year: year)
        case .inventory: try await inventory(timeZone: timeZone)
        }
    }

    private func expensesFile(year: Int) async throws(APIFailure) -> CsvExport {
        let output: Operations.ExportExpenses.Output
        do {
            output = try await client.exportExpenses(query: .init(year: Int32(year)))
        } catch {
            throw APIFailure(error)
        }
        switch output {
        case let .ok(response):
            do {
                return try response.body.json
            } catch {
                throw APIFailure(error)
            }
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func expenses(year: Int) async throws(APIFailure) -> [Expense] {
        let output: Operations.ListExpenses.Output
        do {
            output = try await client.listExpenses(query: .init(year: Int32(year)))
        } catch {
            throw APIFailure(error)
        }
        switch output {
        case let .ok(response):
            do {
                return try response.body.json.expenses
            } catch {
                throw APIFailure(error)
            }
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func addExpense(_ expense: ExpenseWrite, idempotencyKey: String) async throws(APIFailure) -> Expense {
        let output: Operations.CreateExpense.Output
        do {
            output = try await client.createExpense(
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(expense),
            )
        } catch {
            throw APIFailure(error)
        }
        switch output {
        case let .created(response):
            do {
                return try response.body.json
            } catch {
                throw APIFailure(error)
            }
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func deleteExpense(id: String) async throws(APIFailure) {
        let output: Operations.DeleteExpense.Output
        do {
            output = try await client.deleteExpense(path: .init(expenseId: id))
        } catch {
            throw APIFailure(error)
        }
        switch output {
        // Already gone is what the seller asked for.
        case .noContent, .notFound: return
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func setMileageRate(year: Int, tenthCentsPerMile: Int) async throws(APIFailure) -> MileageRate {
        let output: Operations.SetMileageRate.Output
        do {
            output = try await client.setMileageRate(
                query: .init(year: Int32(year)),
                body: .json(.init(tenthCentsPerMile: Int32(clamping: tenthCentsPerMile))),
            )
        } catch {
            throw APIFailure(error)
        }
        switch output {
        case let .ok(response):
            do {
                return try response.body.json
            } catch {
                throw APIFailure(error)
            }
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    private func sales(year: Int, timeZone: String) async throws(APIFailure) -> CsvExport {
        let output: Operations.ExportSales.Output
        do {
            output = try await client.exportSales(query: .init(year: Int32(year), timeZone: timeZone))
        } catch {
            throw APIFailure(error)
        }
        switch output {
        case let .ok(response):
            do {
                return try response.body.json
            } catch {
                throw APIFailure(error)
            }
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    private func inventory(timeZone: String) async throws(APIFailure) -> CsvExport {
        let output: Operations.ExportInventory.Output
        do {
            output = try await client.exportInventory(query: .init(timeZone: timeZone))
        } catch {
            throw APIFailure(error)
        }
        switch output {
        case let .ok(response):
            do {
                return try response.body.json
            } catch {
                throw APIFailure(error)
            }
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }
}
