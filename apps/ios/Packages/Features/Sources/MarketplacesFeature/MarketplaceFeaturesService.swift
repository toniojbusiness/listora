import APIClient
import Core
import Foundation
import ListoraAPI

/// Reads Listora's list of each marketplace's verified features (`listMarketplaceFeatures`,
/// docs/features/verified-features.md), and turns the owner's Test mode on or off
/// (`setTestMode`, docs/features/test-mode.md), for ``Core/MarketplaceFeatures``.
public enum MarketplaceFeaturesService {
    /// The loader ``MarketplaceFeatures`` reads the list with, over the generated client.
    public static func loader(client: Client) -> @Sendable () async throws -> MarketplaceFeatures.List {
        {
            switch try await client.listMarketplaceFeatures() {
            case let .ok(response):
                return try list(response.body.json)
            case let .default(statusCode, response):
                throw APIFailure(statusCode: statusCode, response: response)
            }
        }
    }

    /// What ``MarketplaceFeatures`` turns Test mode on or off with.
    public static func testModeSaver(client: Client) -> @Sendable (Bool) async throws -> MarketplaceFeatures.List {
        { enabled in
            switch try await client.setTestMode(body: .json(.init(on: enabled))) {
            case let .ok(response):
                return try list(response.body.json)
            case let .notFound(response):
                throw APIFailure(statusCode: 404, response: response)
            case let .unprocessableContent(response):
                throw APIFailure(statusCode: 422, response: response)
            case let .default(statusCode, response):
                throw APIFailure(statusCode: statusCode, response: response)
            }
        }
    }

    private static func list(_ body: Components.Schemas.MarketplaceFeatureList) -> MarketplaceFeatures.List {
        var shown: [String: Set<String>] = [:]
        var testing: [String: Set<String>] = [:]
        for entry in body.data {
            let marketplace = entry.marketplace.value1?.rawValue ?? entry.marketplace.value2 ?? ""
            shown[marketplace, default: []].formUnion(entry.features.compactMap { $0.value1?.rawValue ?? $0.value2 })
            testing[marketplace, default: []]
                .formUnion((entry.testing ?? []).compactMap { $0.value1?.rawValue ?? $0.value2 })
        }
        let testMode: MarketplaceFeatures.TestMode = switch body.testMode?.on {
        case nil: .unavailable
        case false?: .off
        case true?: .enabled
        }
        return MarketplaceFeatures.List(shown: shown, testing: testing, testMode: testMode)
    }
}
