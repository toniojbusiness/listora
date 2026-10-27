import APIClient
import Foundation
import ListoraAPI

/// The invite calls (docs/features/invites.md), a protocol so the model's tests run against a fake.
public protocol InvitesService: Sendable {
    func list() async throws(APIFailure) -> Components.Schemas.InviteList
    func create(
        _ invite: Components.Schemas.InviteCreate,
        idempotencyKey: String,
    ) async throws(APIFailure) -> Components.Schemas.CreatedInvite
    func revoke(id: String, idempotencyKey: String) async throws(APIFailure) -> Components.Schemas.Invite
    func restore(id: String, idempotencyKey: String) async throws(APIFailure) -> Components.Schemas.Invite
}

/// ``InvitesService`` over the generated client.
public struct APIInvitesService: InvitesService {
    let client: Client

    public init(client: Client) {
        self.client = client
    }

    public func list() async throws(APIFailure) -> Components.Schemas.InviteList {
        let output: Operations.ListInvites.Output
        do {
            output = try await client.listInvites()
        } catch {
            throw APIFailure(error)
        }
        switch output {
        case let .ok(response): return try Self.decode { try response.body.json }
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    public func create(
        _ invite: Components.Schemas.InviteCreate,
        idempotencyKey: String,
    ) async throws(APIFailure) -> Components.Schemas.CreatedInvite {
        let output: Operations.CreateInvite.Output
        do {
            output = try await client.createInvite(headers: .init(idempotencyKey: idempotencyKey), body: .json(invite))
        } catch {
            throw APIFailure(error)
        }
        switch output {
        case let .created(response): return try Self.decode { try response.body.json }
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    public func revoke(id: String, idempotencyKey: String) async throws(APIFailure) -> Components.Schemas.Invite {
        let output: Operations.RevokeInvite.Output
        do {
            output = try await client.revokeInvite(
                path: .init(inviteId: id),
                headers: .init(idempotencyKey: idempotencyKey),
            )
        } catch {
            throw APIFailure(error)
        }
        switch output {
        case let .ok(response): return try Self.decode { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    public func restore(id: String, idempotencyKey: String) async throws(APIFailure) -> Components.Schemas.Invite {
        let output: Operations.RestoreInvite.Output
        do {
            output = try await client.restoreInvite(
                path: .init(inviteId: id),
                headers: .init(idempotencyKey: idempotencyKey),
            )
        } catch {
            throw APIFailure(error)
        }
        switch output {
        case let .ok(response): return try Self.decode { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    private static func decode<T>(_ body: () throws -> T) throws(APIFailure) -> T {
        do {
            return try body()
        } catch {
            throw APIFailure(error)
        }
    }
}
