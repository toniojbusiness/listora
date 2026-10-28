import APIClient
import Foundation
import ListoraAPI

/// Listing refresh's server side (docs/features/listing-refresh.md): the account's setting and
/// an item's own cadence. Neither changes a listing; the server's schedule refreshes each one.
protocol ListingRefreshService: Sendable {
    func settings() async throws(APIFailure) -> Components.Schemas.ListingRefreshSettings
    func saveSettings(
        _ replace: Components.Schemas.ListingRefreshSettingsReplace,
    ) async throws(APIFailure) -> Components.Schemas.ListingRefreshSettings
    func itemRefresh(itemID: String) async throws(APIFailure) -> Components.Schemas.ItemRefresh
    func saveItemRefresh(
        itemID: String,
        _ replace: Components.Schemas.ItemRefreshReplace,
    ) async throws(APIFailure) -> Components.Schemas.ItemRefresh
}

/// ``ListingRefreshService`` over the generated client.
struct APIListingRefreshService: ListingRefreshService {
    let client: Client

    func settings() async throws(APIFailure) -> Components.Schemas.ListingRefreshSettings {
        switch try await call({ try await client.getListingRefreshSettings() }) {
        case let .ok(response): try body { try response.body.json }
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func saveSettings(
        _ replace: Components.Schemas.ListingRefreshSettingsReplace,
    ) async throws(APIFailure) -> Components.Schemas.ListingRefreshSettings {
        switch try await call({ try await client.replaceListingRefreshSettings(body: .json(replace)) }) {
        case let .ok(response): try body { try response.body.json }
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func itemRefresh(itemID: String) async throws(APIFailure) -> Components.Schemas.ItemRefresh {
        switch try await call({ try await client.getItemRefresh(path: .init(itemId: itemID)) }) {
        case let .ok(response): try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func saveItemRefresh(
        itemID: String,
        _ replace: Components.Schemas.ItemRefreshReplace,
    ) async throws(APIFailure) -> Components.Schemas.ItemRefresh {
        let output = try await call {
            try await client.replaceItemRefresh(path: .init(itemId: itemID), body: .json(replace))
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
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
