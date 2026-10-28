import APIClient
import Foundation
import ListoraAPI

/// How Listora's AI writes the account's listing copy (docs/features/description-style.md): the
/// Depop style in the seller's words, or Listora's default when they never saved their own.
public struct DescriptionStyle: Equatable, Sendable {
    public let depop: String
    /// True when `depop` is Listora's default.
    public let depopIsDefault: Bool

    public init(depop: String, depopIsDefault: Bool) {
        self.depop = depop
        self.depopIsDefault = depopIsDefault
    }
}

/// The description style calls, a protocol so the model's tests run against a fake.
public protocol DescriptionStyleService: Sendable {
    func style() async throws(APIFailure) -> DescriptionStyle
    /// Saves the seller's own Depop style; nil goes back to Listora's default.
    func save(depop: String?) async throws(APIFailure) -> DescriptionStyle
}

/// ``DescriptionStyleService`` over the generated client (`getDescriptionStyle`,
/// `replaceDescriptionStyle`).
public struct APIDescriptionStyleService: DescriptionStyleService {
    let client: Client

    public init(client: Client) {
        self.client = client
    }

    public func style() async throws(APIFailure) -> DescriptionStyle {
        let output = try await call { try await client.getDescriptionStyle() }
        switch output {
        case let .ok(response):
            return try DescriptionStyle(decode { try response.body.json })
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    public func save(depop: String?) async throws(APIFailure) -> DescriptionStyle {
        let output = try await call {
            try await client.replaceDescriptionStyle(body: .json(.init(depop: depop)))
        }
        switch output {
        case let .ok(response):
            return try DescriptionStyle(decode { try response.body.json })
        case let .forbidden(response):
            throw APIFailure(statusCode: 403, response: response)
        case let .unprocessableContent(response):
            throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    private func call<Output>(_ body: () async throws -> Output) async throws(APIFailure) -> Output {
        do {
            return try await body()
        } catch {
            throw APIFailure(error)
        }
    }

    private func decode<Value>(_ body: () throws -> Value) throws(APIFailure) -> Value {
        do {
            return try body()
        } catch {
            throw APIFailure(error)
        }
    }
}

extension DescriptionStyle {
    init(_ style: Components.Schemas.DescriptionStyle) {
        self.init(depop: style.depop, depopIsDefault: style.depopIsDefault)
    }
}
