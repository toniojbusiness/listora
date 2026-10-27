import APIClient
import Foundation
import ListoraAPI

typealias ItemReplace = Components.Schemas.ItemReplace
typealias Usage = Components.Schemas.Usage
typealias MarketplacePrefill = Components.Schemas.ItemMarketplacePrefill
typealias PrefillDetails = Components.Schemas.PrefillDetails
typealias PrefillAnswer = Components.Schemas.PrefillAnswer

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
    /// The server's text model's reading of the phrases of a spoken correction this app could
    /// not parse. A proposal only: it changes nothing on the item.
    func interpretVoiceCorrection(itemID: String, transcript: String, idempotencyKey: String)
        async throws(APIFailure) -> VoiceCorrection
    /// What each marketplace's sell form will get for the item, with the review's questions,
    /// worked out from `details` (the review's unsaved edits over the saved item).
    func marketplacePrefill(itemID: String, details: PrefillDetails) async throws(APIFailure) -> MarketplacePrefill
    /// Records the seller's tap on one of the pre-fill's questions; answers the pre-fill again.
    func answerPrefill(itemID: String, answer: PrefillAnswer) async throws(APIFailure) -> MarketplacePrefill
    /// Every category of a marketplace, for a seller who wants one the short list doesn't have.
    func marketplaceCategories(itemID: String, marketplace: String) async throws(APIFailure)
        -> Components.Schemas.MarketplaceCategories
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

    func interpretVoiceCorrection(itemID: String, transcript: String, idempotencyKey: String)
        async throws(APIFailure) -> VoiceCorrection
    {
        let output = try await call {
            try await client.interpretVoiceCorrection(
                path: .init(itemId: itemID),
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(.init(transcript: transcript)),
            )
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .tooManyRequests(response): throw APIFailure(statusCode: 429, response: response)
        case let .serviceUnavailable(response): throw APIFailure(statusCode: 503, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func marketplacePrefill(itemID: String, details: PrefillDetails) async throws(APIFailure) -> MarketplacePrefill {
        let query = Operations.GetItemMarketplacePrefill.Input.Query(
            category: details.category,
            department: details.department,
            sizeLabel: details.sizeLabel,
            sizeSystem: details.sizeSystem,
            brand: details.brand,
            condition: details.condition,
            colors: details.colors,
            materials: details.materials,
        )
        switch try await call({ try await client.getItemMarketplacePrefill(path: .init(itemId: itemID), query: query)
        }) {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func answerPrefill(itemID: String, answer: PrefillAnswer) async throws(APIFailure) -> MarketplacePrefill {
        let output = try await call {
            try await client.answerItemMarketplacePrefill(path: .init(itemId: itemID), body: .json(answer))
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func marketplaceCategories(itemID: String, marketplace: String) async throws(APIFailure)
        -> Components.Schemas.MarketplaceCategories
    {
        guard let known = Components.Schemas.KnownMarketplace(rawValue: marketplace) else {
            throw APIFailure(
                statusCode: 404,
                code: "not_found",
                message: "Listora has no categories for it.",
                retryable: false,
            )
        }
        let output = try await call {
            try await client.getItemMarketplaceCategories(path: .init(itemId: itemID, marketplace: known))
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
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
