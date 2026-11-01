import APIClient
import Foundation
import ListoraAPI

/// Smart price drops' server side (docs/features/price-drops.md): the seller's rules, their
/// defaults, and each live listing's planned drop. None of it changes a price; the server's
/// schedule runs each drop when it is due, as a price change a read-back confirms.
protocol PriceDropService: Sendable {
    /// The rules and planned drops; with `itemID`, only the rule that applies to the item.
    func priceDrops(itemID: String?) async throws(APIFailure) -> Components.Schemas.PriceDrops
    func defaults(itemID: String?, brand: String?) async throws(APIFailure) -> Components.Schemas.PriceDropDefaults
    func create(_ rule: Components.Schemas.PriceDropRuleCreate) async throws(APIFailure)
        -> Components.Schemas.PriceDropRule
    func replace(ruleID: String, _ rule: Components.Schemas.PriceDropRuleReplace) async throws(APIFailure)
        -> Components.Schemas.PriceDropRule
    func delete(ruleID: String) async throws(APIFailure)
}

/// ``PriceDropService`` over the generated client.
struct APIPriceDropService: PriceDropService {
    let client: Client

    func priceDrops(itemID: String?) async throws(APIFailure) -> Components.Schemas.PriceDrops {
        switch try await call({ try await client.listPriceDrops(query: .init(itemId: itemID)) }) {
        case let .ok(response): try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func defaults(
        itemID: String?,
        brand: String?,
    ) async throws(APIFailure) -> Components.Schemas.PriceDropDefaults {
        switch try await call({
            try await client.getPriceDropDefaults(query: .init(itemId: itemID, brand: brand))
        }) {
        case let .ok(response): try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func create(
        _ rule: Components.Schemas.PriceDropRuleCreate,
    ) async throws(APIFailure) -> Components.Schemas.PriceDropRule {
        let output = try await call {
            try await client.createPriceDropRule(
                headers: .init(idempotencyKey: UUID().uuidString),
                body: .json(rule),
            )
        }
        switch output {
        case let .created(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func replace(
        ruleID: String,
        _ rule: Components.Schemas.PriceDropRuleReplace,
    ) async throws(APIFailure) -> Components.Schemas.PriceDropRule {
        let output = try await call {
            try await client.replacePriceDropRule(path: .init(ruleId: ruleID), body: .json(rule))
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func delete(ruleID: String) async throws(APIFailure) {
        switch try await call({ try await client.deletePriceDropRule(path: .init(ruleId: ruleID)) }) {
        case .noContent: return
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
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
