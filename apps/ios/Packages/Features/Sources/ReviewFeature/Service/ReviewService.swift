import APIClient
import Foundation
import ListoraAPI

typealias ItemReplace = Components.Schemas.ItemReplace
typealias Usage = Components.Schemas.Usage

/// The API calls of review and pricing, returning the contract's types and throwing
/// ``APIFailure`` for every other answer. A protocol so the view model's tests run against a fake.
protocol ReviewService: Sendable {
    func item(id: String) async throws(APIFailure) -> Item
    /// Starts (or returns the existing) fast analysis of the item's current photo set.
    func startAnalysis(itemID: String, idempotencyKey: String) async throws(APIFailure) -> Analysis
    func analysis(id: String) async throws(APIFailure) -> Analysis
    /// Starts (or returns the existing) premium identification of a fast analysis.
    func escalate(analysisID: String, idempotencyKey: String) async throws(APIFailure) -> Analysis
    func apply(analysisID: String, expectedVersion: Int64, idempotencyKey: String) async throws(APIFailure) -> Item
    func replace(itemID: String, with replace: ItemReplace) async throws(APIFailure) -> Item
    func pricing(itemID: String) async throws(APIFailure) -> PricingSuggestion
    func usage() async throws(APIFailure) -> Usage
}

/// ``ReviewService`` over the generated client.
struct APIReviewService: ReviewService {
    let client: Client

    func item(id: String) async throws(APIFailure) -> Item {
        switch try await call({ try await client.getItem(path: .init(itemId: id)) }) {
        case let .ok(response): try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func startAnalysis(itemID: String, idempotencyKey: String) async throws(APIFailure) -> Analysis {
        let output = try await call {
            try await client.startItemAnalysis(
                path: .init(itemId: itemID),
                headers: .init(idempotencyKey: idempotencyKey),
            )
        }
        switch output {
        case let .accepted(response): return try body { try response.body.json }
        case let .code402(response): throw APIFailure(statusCode: 402, response: response)
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .tooManyRequests(response): throw APIFailure(statusCode: 429, response: response)
        case let .serviceUnavailable(response): throw APIFailure(statusCode: 503, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func analysis(id: String) async throws(APIFailure) -> Analysis {
        switch try await call({ try await client.getAnalysis(path: .init(analysisId: id)) }) {
        case let .ok(response): try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func escalate(analysisID: String, idempotencyKey: String) async throws(APIFailure) -> Analysis {
        let output = try await call {
            try await client.escalateAnalysis(
                path: .init(analysisId: analysisID),
                headers: .init(idempotencyKey: idempotencyKey),
            )
        }
        switch output {
        case let .accepted(response): return try body { try response.body.json }
        case let .code402(response): throw APIFailure(statusCode: 402, response: response)
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .tooManyRequests(response): throw APIFailure(statusCode: 429, response: response)
        case let .serviceUnavailable(response): throw APIFailure(statusCode: 503, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func apply(analysisID: String, expectedVersion: Int64, idempotencyKey: String) async throws(APIFailure) -> Item {
        let output = try await call {
            try await client.applyAnalysis(
                path: .init(analysisId: analysisID),
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(.init(expectedVersion: expectedVersion)),
            )
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func replace(itemID: String, with replace: ItemReplace) async throws(APIFailure) -> Item {
        let output = try await call {
            try await client.replaceItem(path: .init(itemId: itemID), body: .json(replace))
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func pricing(itemID: String) async throws(APIFailure) -> PricingSuggestion {
        switch try await call({ try await client.getItemPricing(path: .init(itemId: itemID)) }) {
        case let .ok(response): try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func usage() async throws(APIFailure) -> Usage {
        switch try await call({ try await client.getUsage() }) {
        case let .ok(response): try body { try response.body.json }
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
