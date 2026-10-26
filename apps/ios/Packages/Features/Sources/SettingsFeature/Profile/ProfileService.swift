import APIClient
import Foundation
import ListoraAPI

/// The signed-in person as the server knows them: the email they sign in with, the name they go
/// by, and the business they sell as. A nil name was never entered.
public struct Profile: Equatable, Sendable {
    public let email: String?
    public let displayName: String?
    public let businessName: String?

    public init(email: String?, displayName: String?, businessName: String?) {
        self.email = email
        self.displayName = displayName
        self.businessName = businessName
    }
}

/// The profile calls, a protocol so the model's tests run against a fake.
public protocol ProfileService: Sendable {
    func profile() async throws(APIFailure) -> Profile
    /// Replaces both names; nil clears one.
    func save(displayName: String?, businessName: String?) async throws(APIFailure) -> Profile
}

/// ``ProfileService`` over the generated client (`getProfile`, `replaceProfile`).
public struct APIProfileService: ProfileService {
    let client: Client

    public init(client: Client) {
        self.client = client
    }

    public func profile() async throws(APIFailure) -> Profile {
        let output = try await call { try await client.getProfile() }
        switch output {
        case let .ok(response):
            return try Profile(decode { try response.body.json })
        case let .default(statusCode, response):
            throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    public func save(displayName: String?, businessName: String?) async throws(APIFailure) -> Profile {
        let output = try await call {
            try await client.replaceProfile(body: .json(.init(displayName: displayName, businessName: businessName)))
        }
        switch output {
        case let .ok(response):
            return try Profile(decode { try response.body.json })
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

extension Profile {
    init(_ profile: Components.Schemas.Profile) {
        self.init(email: profile.email, displayName: profile.displayName, businessName: profile.businessName)
    }
}
