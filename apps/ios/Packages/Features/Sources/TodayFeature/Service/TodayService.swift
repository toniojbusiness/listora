import APIClient
import Foundation
import ListoraAPI

typealias Today = Components.Schemas.Today
typealias TodayCard = Components.Schemas.TodayCard
typealias TodayMoneyPeriod = Components.Schemas.TodayMoneyPeriod
typealias Money = Components.Schemas.Money
typealias SummarySettings = Components.Schemas.TodaySummarySettings

/// The Today screen's calls, returning the contract's types and throwing ``APIFailure`` for every
/// other answer. A protocol so the models' tests run against a fake.
protocol TodayService: Sendable {
    /// What needs the seller now, computed by the server on every call (`getToday`).
    func today() async throws(APIFailure) -> Today
    func summarySettings() async throws(APIFailure) -> SummarySettings
    func saveSummarySettings(
        enabled: Bool,
        time: String,
        timeZone: String,
    ) async throws(APIFailure) -> SummarySettings
}

/// ``TodayService`` over the generated client.
struct APITodayService: TodayService {
    let client: Client

    func today() async throws(APIFailure) -> Today {
        switch try await call({ try await client.getToday() }) {
        case let .ok(response): try body { try response.body.json }
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func summarySettings() async throws(APIFailure) -> SummarySettings {
        switch try await call({ try await client.getTodaySettings() }) {
        case let .ok(response): try body { try response.body.json }
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func saveSummarySettings(
        enabled: Bool,
        time: String,
        timeZone: String,
    ) async throws(APIFailure) -> SummarySettings {
        let output = try await call {
            try await client.replaceTodaySettings(body: .json(.init(enabled: enabled, time: time, timeZone: timeZone)))
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    private func call<Output>(_ request: () async throws -> Output) async throws(APIFailure) -> Output {
        do {
            return try await request()
        } catch {
            throw APIFailure(error)
        }
    }

    private func body<Body>(_ read: () throws -> Body) throws(APIFailure) -> Body {
        do {
            return try read()
        } catch {
            throw APIFailure(error)
        }
    }
}
