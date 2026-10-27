import APIClient
import Foundation
import ListoraAPI

/// The import calls the Import listings screen makes. ``APIImportsService`` sends them to the
/// API; tests use a fake.
public protocol ImportsService: Sendable {
    /// Each marketplace Listora imports from, whether an import can start, and its newest import.
    func marketplaces() async throws(APIFailure) -> [Components.Schemas.ListingImportMarketplace]
    /// Starts importing the seller's listings for sale on `marketplace`.
    func start(
        marketplace: Components.Schemas.KnownMarketplace,
        idempotencyKey: String,
    ) async throws(APIFailure) -> Components.Schemas.ListingImport
    /// The import's open questions, oldest first.
    func questions(importID: String) async throws(APIFailure) -> [Components.Schemas.ListingImportQuestion]
    /// Answers one question; answers the import with the answer counted.
    func answer(
        importID: String,
        questionID: String,
        answer: Components.Schemas.ListingImportAnswer,
        idempotencyKey: String,
    ) async throws(APIFailure) -> Components.Schemas.ListingImport
}

/// ``ImportsService`` over the generated client.
public struct APIImportsService: ImportsService {
    let client: Client

    public init(client: Client) {
        self.client = client
    }

    public func marketplaces() async throws(APIFailure) -> [Components.Schemas.ListingImportMarketplace] {
        let output = try await call { try await client.listListingImports() }
        switch output {
        case let .ok(response):
            return try body { try response.body.json }.marketplaces
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    public func start(
        marketplace: Components.Schemas.KnownMarketplace,
        idempotencyKey: String,
    ) async throws(APIFailure) -> Components.Schemas.ListingImport {
        let output = try await call {
            try await client.startListingImport(
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(.init(marketplace: marketplace)),
            )
        }
        switch output {
        case let .accepted(accepted):
            return try body { try accepted.body.json }
        case let .conflict(response):
            throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response):
            throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    public func questions(importID: String) async throws(APIFailure) -> [Components.Schemas.ListingImportQuestion] {
        let output = try await call {
            try await client.listListingImportQuestions(path: .init(importId: importID))
        }
        switch output {
        case let .ok(response):
            return try body { try response.body.json }.questions
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    public func answer(
        importID: String,
        questionID: String,
        answer: Components.Schemas.ListingImportAnswer,
        idempotencyKey: String,
    ) async throws(APIFailure) -> Components.Schemas.ListingImport {
        let output = try await call {
            try await client.answerListingImportQuestion(
                path: .init(importId: importID, questionId: questionID),
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(answer),
            )
        }
        switch output {
        case let .ok(response):
            return try body { try response.body.json }
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response):
            throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response):
            throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    private func call<T>(_ request: () async throws -> T) async throws(APIFailure) -> T {
        do {
            return try await request()
        } catch {
            throw APIFailure(error)
        }
    }

    private func body<T>(_ read: () throws -> T) throws(APIFailure) -> T {
        do {
            return try read()
        } catch {
            throw APIFailure(error)
        }
    }
}
