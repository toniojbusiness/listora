import APIClient
import Foundation
import ListoraAPI

typealias ItemSummary = Components.Schemas.ItemSummary
typealias Item = Components.Schemas.Item
typealias Listing = Components.Schemas.Listing
typealias ListingVariant = Components.Schemas.ListingVariant
typealias Operation = Components.Schemas.Operation
typealias OperationEvent = Components.Schemas.OperationEvent
typealias Connection = Components.Schemas.Connection
typealias Money = Components.Schemas.Money
typealias KnownMarketplace = Components.Schemas.KnownMarketplace
typealias ActivityEntry = Components.Schemas.ActivityEntry
typealias ItemChangeWait = Components.Schemas.ItemChangeWaitResult

/// One page of an item's activity, newest first.
struct ActivityPage: Equatable, Sendable {
    var entries: [ActivityEntry]
    var nextCursor: String?
}

/// One page of the inventory list.
struct ItemPage: Equatable, Sendable {
    var items: [ItemSummary]
    var nextCursor: String?
}

/// The inventory list's filters and order, as the API applies them.
struct InventoryQuery: Equatable, Sendable {
    var search = ""
    var filter = InventoryFilter.all
    var marketplace: KnownMarketplace?
    var brand: String?
    var sort = ItemSort.standard

    /// The same order with no filter or search.
    var unfiltered: InventoryQuery {
        InventoryQuery(sort: sort)
    }
}

/// The calls of the inventory, item, and listing screens, returning the contract's types and
/// throwing ``APIFailure`` for every other answer. A protocol so the models' tests run against a
/// fake. Every marketplace change goes through the server's operation engine: these calls only
/// queue it, and the screens show its progress from the server.
protocol InventoryService: Sendable {
    func items(_ query: InventoryQuery, cursor: String?) async throws(APIFailure) -> ItemPage
    func item(id: String) async throws(APIFailure) -> Item
    /// Replaces the item's details (`expectedVersion` is the version last read; a newer one is `409`).
    func replaceItem(id: String, with replace: Components.Schemas.ItemReplace) async throws(APIFailure) -> Item
    /// Deletes an item from Listora. Unless `leavingListings`, one with a listing that may be live
    /// is kept (`409` with the reason); with it, those listings stay up, no longer tracked.
    func deleteItem(id: String, leavingListings: Bool) async throws(APIFailure)
    func connections() async throws(APIFailure) -> [Connection]
    /// The item's "Don't sell below" price on each marketplace (none without a cost).
    func floors(itemID: String) async throws(APIFailure) -> [Components.Schemas.MarketplaceFloor]
    /// The marketplace copy the item's accepted analysis wrote.
    func analysisVariants(analysisID: String) async throws(APIFailure) -> [Components.Schemas.VariantSuggestion]
    /// Every operation on the listing, newest first.
    func operations(listingID: String) async throws(APIFailure) -> [Operation]
    /// Waits up to `waitSeconds` (at most 20) for a change to the item's operations
    /// (`waitForItemChange`): `after` is the previous answer's token; without it the answer is
    /// at once, changed.
    func waitForChange(itemID: String, after: String?, waitSeconds: Int) async throws(APIFailure) -> ItemChangeWait
    /// The operation's history, oldest first.
    func events(operationID: String) async throws(APIFailure) -> [OperationEvent]
    /// Everything that happened to the item, newest first (docs/features/activity.md).
    func activity(itemID: String, cursor: String?) async throws(APIFailure) -> ActivityPage

    func createListing(
        itemID: String,
        marketplace: KnownMarketplace,
        variant: ListingVariant,
        idempotencyKey: String,
    ) async throws(APIFailure) -> Listing
    func replaceDraft(listingID: String, variant: ListingVariant) async throws(APIFailure) -> Listing
    /// The item's categories on Poshmark, Mercari, or Depop (`getItemMarketplaceCategories`).
    func marketplaceCategories(
        itemID: String,
        marketplace: String,
    ) async throws(APIFailure) -> Components.Schemas.MarketplaceCategories
    func perform(_ action: ListingRequest, idempotencyKey: String) async throws(APIFailure) -> Listing
    func retry(operationID: String, idempotencyKey: String) async throws(APIFailure) -> Operation
    /// Runs a waiting operation's next attempt now (`tryOperationNow`).
    func tryNow(operationID: String, idempotencyKey: String) async throws(APIFailure) -> Operation
}

/// A listing action the server queues as an operation.
enum ListingRequest: Equatable, Sendable {
    case publish(listingID: String)
    case changePrice(listingID: String, price: Money)
    /// A live listing's new details (`reviseListing`); shown only where revise passed live, or
    /// in the owner's Test mode (docs/features/test-mode.md).
    case revise(listingID: String, variant: ListingVariant)
    case end(listingID: String, reason: Components.Schemas.ListingEndReason)
    case relist(listingID: String)
    case verify(listingID: String)
}

/// ``InventoryService`` over the generated client.
struct APIInventoryService: InventoryService {
    let client: Client
    /// Runs once the server queued a marketplace change: the phone takes at once the changes
    /// that run on it (docs/features/phone-execution.md).
    var queued: @MainActor @Sendable () -> Void = {}

    func items(_ query: InventoryQuery, cursor: String?) async throws(APIFailure) -> ItemPage {
        let search = query.search.trimmingCharacters(in: .whitespacesAndNewlines)
        let output = try await call {
            try await client.listItems(query: .init(
                status: query.filter.statuses.isEmpty ? nil : query.filter.statuses,
                q: search.isEmpty ? nil : String(search.prefix(200)),
                marketplace: query.marketplace,
                brand: query.brand,
                attention: query.filter.needsAttention ? true : nil,
                sort: query.sort,
                cursor: cursor,
                limit: 50,
            ))
        }
        switch output {
        case let .ok(response):
            let page = try body { try response.body.json }
            return ItemPage(items: page.data, nextCursor: page.nextCursor)
        case let .badRequest(response): throw APIFailure(statusCode: 400, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func item(id: String) async throws(APIFailure) -> Item {
        switch try await call({ try await client.getItem(path: .init(itemId: id)) }) {
        case let .ok(response): try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func replaceItem(id: String, with replace: Components.Schemas.ItemReplace) async throws(APIFailure) -> Item {
        let output = try await call {
            try await client.replaceItem(path: .init(itemId: id), body: .json(replace))
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response): throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func floors(itemID: String) async throws(APIFailure) -> [Components.Schemas.MarketplaceFloor] {
        let output = try await call { try await client.getItemPricing(path: .init(itemId: itemID)) }
        switch output {
        case let .ok(response): return try body { try response.body.json }.floors
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func connections() async throws(APIFailure) -> [Connection] {
        switch try await call({ try await client.listConnections() }) {
        case let .ok(response): try body { try response.body.json }.data
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func analysisVariants(analysisID: String) async throws(APIFailure)
        -> [Components.Schemas.VariantSuggestion]
    {
        switch try await call({ try await client.getAnalysis(path: .init(analysisId: analysisID)) }) {
        case let .ok(response): try body { try response.body.json }.result?.variants ?? []
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func waitForChange(itemID: String, after: String?, waitSeconds: Int) async throws(APIFailure) -> ItemChangeWait {
        let output = try await call {
            try await client.waitForItemChange(
                path: .init(itemId: itemID),
                query: .init(after: after, waitSeconds: Int32(max(1, min(20, waitSeconds)))),
            )
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .unprocessableContent(response): throw APIFailure(statusCode: 422, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func operations(listingID: String) async throws(APIFailure) -> [Operation] {
        let output = try await call {
            try await client.listOperations(query: .init(listingId: listingID, limit: 50))
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }.data
        case let .badRequest(response): throw APIFailure(statusCode: 400, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func events(operationID: String) async throws(APIFailure) -> [OperationEvent] {
        let output = try await call {
            try await client.listOperationEvents(path: .init(operationId: operationID), query: .init(limit: 100))
        }
        switch output {
        case let .ok(response): return try body { try response.body.json }.data
        case let .badRequest(response): throw APIFailure(statusCode: 400, response: response)
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func activity(itemID: String, cursor: String?) async throws(APIFailure) -> ActivityPage {
        let output = try await call {
            try await client.listItemActivity(path: .init(itemId: itemID), query: .init(cursor: cursor, limit: 50))
        }
        switch output {
        case let .ok(response):
            let page = try body { try response.body.json }
            return ActivityPage(entries: page.data, nextCursor: page.nextCursor)
        case let .badRequest(response): throw APIFailure(statusCode: 400, response: response)
        case let .notFound(response): throw APIFailure(statusCode: 404, response: response)
        case let .default(statusCode, response): throw APIFailure(statusCode: statusCode, response: response)
        }
    }

    func call<Output>(_ request: () async throws -> Output) async throws(APIFailure) -> Output {
        do {
            return try await request()
        } catch {
            throw APIFailure(error)
        }
    }

    func body<Body>(_ read: () throws -> Body) throws(APIFailure) -> Body {
        do {
            return try read()
        } catch {
            throw APIFailure(error)
        }
    }
}
