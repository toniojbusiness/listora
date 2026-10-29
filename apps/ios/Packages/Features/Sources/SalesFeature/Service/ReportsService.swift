import APIClient
import Foundation
import ListoraAPI

typealias YearReport = Components.Schemas.YearReport
typealias ReportTotals = Components.Schemas.ReportTotals
typealias CsvExport = Components.Schemas.CsvExport

/// What a CSV export holds: a year's sales, or the inventory now.
enum ReportExport: String, CaseIterable, Identifiable, Sendable {
    case sales
    case inventory

    var id: Self {
        self
    }
}

/// The Reports screen's calls (`getYearReport`, `exportSales`, `exportInventory`), returning the
/// contract's bodies and throwing ``APIFailure`` for every other answer. A protocol so the
/// model's tests run against a fake.
protocol ReportsService: Sendable {
    func yearReport(year: Int, timeZone: String) async throws(APIFailure) -> YearReport
    func export(_ export: ReportExport, year: Int, timeZone: String) async throws(APIFailure) -> CsvExport
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
        case .inventory: try await inventory(timeZone: timeZone)
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
