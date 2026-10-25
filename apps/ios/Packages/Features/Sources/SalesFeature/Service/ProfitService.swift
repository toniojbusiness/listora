import APIClient
import Foundation
import ListoraAPI

typealias ProfitReport = Components.Schemas.ProfitReport
typealias ProfitGroup = Components.Schemas.ProfitGroup
typealias MarketplaceProfit = Components.Schemas.MarketplaceProfit
typealias DeadStockItem = Components.Schemas.DeadStockItem

/// The days a report covers: `YYYY-MM-DD`, both inclusive, in an IANA time zone.
struct ProfitQuery: Equatable, Sendable {
    var firstDay: String
    var lastDay: String
    var timeZone: String
}

/// The profit dashboard's call (`getProfit`), returning the contract's report and throwing
/// ``APIFailure`` for every other answer. A protocol so the model's tests run against a fake.
protocol ProfitService: Sendable {
    func profit(_ query: ProfitQuery) async throws(APIFailure) -> ProfitReport
}

/// ``ProfitService`` over the generated client.
struct APIProfitService: ProfitService {
    let client: Client

    func profit(_ query: ProfitQuery) async throws(APIFailure) -> ProfitReport {
        let output: Operations.GetProfit.Output
        do {
            output = try await client.getProfit(query: .init(
                from: query.firstDay,
                to: query.lastDay,
                timeZone: query.timeZone,
            ))
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
