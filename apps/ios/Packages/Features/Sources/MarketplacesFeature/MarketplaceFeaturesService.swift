import APIClient
import Core
import Foundation
import ListoraAPI

/// Reads Listora's list of each marketplace's verified features (`listMarketplaceFeatures`,
/// docs/features/verified-features.md), for ``Core/MarketplaceFeatures``.
public enum MarketplaceFeaturesService {
    /// The loader ``MarketplaceFeatures`` reads the list with, over the generated client.
    public static func loader(client: Client) -> @Sendable () async throws -> [String: Set<String>] {
        {
            switch try await client.listMarketplaceFeatures() {
            case let .ok(response):
                let list = try response.body.json.data
                return Dictionary(
                    list.map { entry in
                        (
                            entry.marketplace.value1?.rawValue ?? entry.marketplace.value2 ?? "",
                            Set(entry.features.compactMap { $0.value1?.rawValue ?? $0.value2 }),
                        )
                    },
                    uniquingKeysWith: { first, _ in first },
                )
            case let .default(statusCode, response):
                throw APIFailure(statusCode: statusCode, response: response)
            }
        }
    }
}
