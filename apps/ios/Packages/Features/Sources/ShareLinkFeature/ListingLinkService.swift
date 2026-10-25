import APIClient
import Core
import DesignSystem
import Foundation
import ListoraAPI

/// An inventory item a shared listing can be linked to.
public struct ItemMatch: Identifiable, Equatable, Sendable {
    public let id: String
    public let sku: String
    public let title: String?
    public let brand: String?
    public let sizeLabel: String?
    /// Marketplaces (raw ids) where the item already has a listing that is not ended or sold.
    public let liveMarketplaces: Set<String>
    /// Whether a listing can be linked to it (the server refuses sold, shipped, archived items).
    public let acceptsLinks: Bool

    public init(
        id: String,
        sku: String,
        title: String? = nil,
        brand: String? = nil,
        sizeLabel: String? = nil,
        liveMarketplaces: Set<String> = [],
        acceptsLinks: Bool = true,
    ) {
        self.id = id
        self.sku = sku
        self.title = title
        self.brand = brand
        self.sizeLabel = sizeLabel
        self.liveMarketplaces = liveMarketplaces
        self.acceptsLinks = acceptsLinks
    }

    public var displayTitle: String {
        title ?? "Untitled item"
    }
}

/// What the server recorded for a linked listing.
public struct LinkedListing: Equatable, Sendable {
    public let itemSKU: String
    public let itemTitle: String?
    /// The server's honest status, shown as given (for example `Active (you confirmed)`).
    public let statusLabel: String
    public let statusTone: StatusLabel.Tone

    public init(itemSKU: String, itemTitle: String?, statusLabel: String, statusTone: StatusLabel.Tone) {
        self.itemSKU = itemSKU
        self.itemTitle = itemTitle
        self.statusLabel = statusLabel
        self.statusTone = statusTone
    }
}

/// The API calls the Share Extension makes. Every write takes the caller's Idempotency-Key, so
/// a retry after a lost answer never links twice.
public protocol ListingLinkService: Sendable {
    /// Whether a session is stored (the app signed in).
    func isSignedIn() -> Bool
    /// Items matching a title, brand, keyword, or SKU; the newest items for an empty query.
    func searchItems(_ query: String) async throws(APIFailure) -> [ItemMatch]
    func link(_ listing: ListingURL, to item: ItemMatch, idempotencyKey: String) async throws(APIFailure)
        -> LinkedListing
    func importListing(_ listing: ListingURL, title: String, idempotencyKey: String) async throws(APIFailure)
        -> LinkedListing
}

/// `ListingLinkService` on the Listora API.
public struct APIListingLinkService: ListingLinkService {
    private let api: APIClient
    private let accessTokens: AccessTokenStore

    public init(api: APIClient, accessTokens: AccessTokenStore) {
        self.api = api
        self.accessTokens = accessTokens
    }

    public func isSignedIn() -> Bool {
        accessTokens.grant != nil
    }

    public func searchItems(_ query: String) async throws(APIFailure) -> [ItemMatch] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let output = try await call {
            try await api.client.listItems(query: .init(
                q: trimmed.isEmpty ? nil : String(trimmed.prefix(200)),
                limit: 25,
            ))
        }
        switch output {
        case let .ok(response):
            return try decode { try response.body.json.data.map(ItemMatch.init(summary:)) }
        case let .badRequest(response):
            throw APIFailure(statusCode: 400, response: response)
        case let .default(status, response):
            throw APIFailure(statusCode: status, response: response)
        }
    }

    public func link(
        _ listing: ListingURL,
        to item: ItemMatch,
        idempotencyKey: String,
    ) async throws(APIFailure) -> LinkedListing {
        let output = try await call {
            try await api.client.linkItemListing(
                path: .init(itemId: item.id),
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(.init(url: listing.canonicalURL.absoluteString)),
            )
        }
        switch output {
        case let .created(response):
            let linked = try decode { try response.body.json }
            return LinkedListing(listing: linked, sku: item.sku, title: item.title)
        case let .notFound(response):
            throw APIFailure(statusCode: 404, response: response)
        case let .conflict(response):
            throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response):
            throw APIFailure(statusCode: 422, response: response)
        case let .default(status, response):
            throw APIFailure(statusCode: status, response: response)
        }
    }

    public func importListing(
        _ listing: ListingURL,
        title: String,
        idempotencyKey: String,
    ) async throws(APIFailure) -> LinkedListing {
        let output = try await call {
            try await api.client.importSharedListing(
                headers: .init(idempotencyKey: idempotencyKey),
                body: .json(.init(url: listing.canonicalURL.absoluteString, title: title)),
            )
        }
        switch output {
        case let .created(response):
            let result = try decode { try response.body.json }
            return LinkedListing(listing: result.listing, sku: result.item.sku, title: result.item.details.title)
        case let .conflict(response):
            throw APIFailure(statusCode: 409, response: response)
        case let .unprocessableContent(response):
            throw APIFailure(statusCode: 422, response: response)
        case let .default(status, response):
            throw APIFailure(statusCode: status, response: response)
        }
    }

    /// Runs a generated call; a thrown error means no usable answer arrived.
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

extension ItemMatch {
    /// Items the server still lists as live on a marketplace: anything but ended or sold.
    private static let notLiveStatuses: Set<String> = ["ended", "sold"]
    private static let linkableStatuses: Set<String> = ["draft", "ready", "listed"]

    init(summary: Components.Schemas.ItemSummary) {
        self.init(
            id: summary.id,
            sku: summary.sku,
            title: summary.title,
            brand: summary.brand,
            sizeLabel: summary.sizeLabel,
            liveMarketplaces: Set(summary.listings.compactMap { listing in
                let status = listing.status.value1?.rawValue ?? listing.status.value2 ?? ""
                guard !Self.notLiveStatuses.contains(status) else { return nil }
                // A listing waiting for the user to post it (its list task is open) takes the
                // shared link: sharing it is how the user says they posted it.
                if status == "draft", listing.statusDisplay.tone.value1 == .actionNeeded {
                    return nil
                }
                return listing.marketplace.value1?.rawValue ?? listing.marketplace.value2
            }),
            acceptsLinks: summary.status.value1.map { Self.linkableStatuses.contains($0.rawValue) } ?? false,
        )
    }
}

extension LinkedListing {
    init(listing: Components.Schemas.Listing, sku: String, title: String?) {
        self.init(
            itemSKU: sku,
            itemTitle: title,
            statusLabel: listing.statusDisplay.label,
            statusTone: StatusLabel.Tone(listing.statusDisplay.tone),
        )
    }
}

extension StatusLabel.Tone {
    /// A tone added after this build is styled like `neutral` (the label is still shown).
    init(_ tone: Components.Schemas.StatusTone) {
        switch tone.value1 {
        case .success: self = .success
        case .inProgress: self = .inProgress
        case .checking: self = .checking
        case .failed: self = .failed
        case .actionNeeded: self = .actionNeeded
        case .neutral, nil: self = .neutral
        }
    }
}
