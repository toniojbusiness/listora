import APIClient
import Foundation
import ListoraAPI

/// The listing calls: creating and editing a draft, its marketplace categories, and the listing
/// actions the server queues as operations.
extension APIInventoryService {
    func createListing(
        itemID: String,
        marketplace: KnownMarketplace,
        variant: ListingVariant,
        idempotencyKey: String,
    ) async throws(APIFailure) -> Listing {
        let output = try await call {
            try await client.createListing(
                path: .init(itemId: itemID),
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(.init(marketplace: marketplace, variant: variant)),
            )
        }
        switch output {
        case let .created(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func replaceDraft(listingID: String, variant: ListingVariant) async throws(APIFailure) -> Listing {
        let output = try await call {
            try await client.replaceListingDraft(
                path: .init(listingId: listingID),
                body: .json(.init(variant: variant)),
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

    func marketplaceCategories(
        itemID: String,
        marketplace: String,
    ) async throws(APIFailure) -> Components.Schemas.MarketplaceCategories {
        guard let known = Components.Schemas.KnownMarketplace(rawValue: marketplace) else {
            throw APIFailure(statusCode: 404, code: "not_found", message: "No categories here.", retryable: false)
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

    func perform(_ action: ListingRequest, idempotencyKey key: String) async throws(APIFailure) -> Listing {
        let listing: Listing = switch action {
        case let .publish(listingID): try await publish(listingID: listingID, key: key)
        case let .changePrice(listingID, price):
            try await changePrice(listingID: listingID, price: price, key: key)
        case let .end(listingID, reason): try await end(listingID: listingID, reason: reason, key: key)
        case let .relist(listingID): try await relist(listingID: listingID, key: key)
        case let .verify(listingID): try await verify(listingID: listingID, key: key)
        }
        await queued()
        return listing
    }

    private func publish(listingID: String, key: String) async throws(APIFailure) -> Listing {
        let output = try await call {
            try await client.publishListing(path: .init(listingId: listingID), headers: .init(idempotencyKey: key))
        }
        switch output {
        case let .accepted(response): return try body { try response.body.json }.listing
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    private func changePrice(listingID: String, price: Money, key: String) async throws(APIFailure) -> Listing {
        let output = try await call {
            try await client.changeListingPrice(
                path: .init(listingId: listingID),
                headers: .init(idempotencyKey: key),
                body: .json(.init(price: price)),
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

    private func end(
        listingID: String,
        reason: Components.Schemas.ListingEndReason,
        key: String,
    ) async throws(APIFailure) -> Listing {
        let output = try await call {
            try await client.endListing(
                path: .init(listingId: listingID),
                headers: .init(idempotencyKey: key),
                body: .json(.init(reason: reason)),
            )
        }
        switch output {
        case let .accepted(response): return try body { try response.body.json }.listing
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    private func relist(listingID: String, key: String) async throws(APIFailure) -> Listing {
        let output = try await call {
            try await client.relistListing(path: .init(listingId: listingID), headers: .init(idempotencyKey: key))
        }
        switch output {
        case let .accepted(response): return try body { try response.body.json }.listing
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    private func verify(listingID: String, key: String) async throws(APIFailure) -> Listing {
        let output = try await call {
            try await client.verifyListing(path: .init(listingId: listingID), headers: .init(idempotencyKey: key))
        }
        switch output {
        case let .accepted(response): return try body { try response.body.json }.listing
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }
}
