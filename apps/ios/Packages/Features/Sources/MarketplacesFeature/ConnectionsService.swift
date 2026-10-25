import APIClient
import Foundation
import ListoraAPI

/// The connection calls the Marketplaces screen makes. ``APIConnectionsService`` sends them to
/// the API; tests use a fake.
public protocol ConnectionsService: Sendable {
    /// Every marketplace and its connection, in the server's order.
    func connections() async throws(APIFailure) -> [Components.Schemas.Connection]
    /// Starts connecting a marketplace account: the attempt, with the consent URL to open.
    func startAuthorization(
        marketplace: Components.Schemas.KnownMarketplace,
        idempotencyKey: String,
    ) async throws(APIFailure) -> Components.Schemas.ConnectionAuthorization
    /// Reads an attempt back after the consent page returned to the app.
    func authorization(
        marketplace: Components.Schemas.KnownMarketplace,
        id: String,
    ) async throws(APIFailure) -> Components.Schemas.ConnectionAuthorization
}

/// ``ConnectionsService`` over the generated client.
public struct APIConnectionsService: ConnectionsService {
    let client: Client

    public init(client: Client) {
        self.client = client
    }

    public func connections() async throws(APIFailure) -> [Components.Schemas.Connection] {
        let output = try await call { try await client.listConnections() }
        switch output {
        case let .ok(response):
            return try body { try response.body.json }.data
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    public func startAuthorization(
        marketplace: Components.Schemas.KnownMarketplace,
        idempotencyKey: String,
    ) async throws(APIFailure) -> Components.Schemas.ConnectionAuthorization {
        let output = try await call {
            try await client.startConnectionAuthorization(
                path: .init(marketplace: marketplace),
                headers: .init(idempotencyKey: idempotencyKey),
            )
        }
        switch output {
        case let .created(created):
            return try body { try created.body.json }
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response):
            throw APIFailure(statusCode: 409, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    public func authorization(
        marketplace: Components.Schemas.KnownMarketplace,
        id: String,
    ) async throws(APIFailure) -> Components.Schemas.ConnectionAuthorization {
        let output = try await call {
            try await client.getConnectionAuthorization(path: .init(marketplace: marketplace, authorizationId: id))
        }
        switch output {
        case let .ok(response):
            return try body { try response.body.json }
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
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
