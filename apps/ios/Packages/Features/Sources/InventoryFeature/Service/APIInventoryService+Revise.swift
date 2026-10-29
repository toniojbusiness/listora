import APIClient
import Foundation
import ListoraAPI

/// A live listing's new details (`reviseListing`), offered only where revise passed live or in
/// the owner's Test mode (docs/features/test-mode.md).
extension APIInventoryService {
    func revise(listingID: String, variant: ListingVariant, key: String) async throws(APIFailure) -> Listing {
        let output = try await call {
            try await client.reviseListing(
                path: .init(listingId: listingID),
                headers: .init(idempotencyKey: key),
                body: .json(.init(variant: variant)),
            )
        }
        switch output {
        case let .accepted(response): return try body { try response.body.json }.listing
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }
}
