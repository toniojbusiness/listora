import APIClient
import Foundation
import ListoraAPI
@testable import InventoryFeature

/// A scripted ``InventoryService`` that records what it was asked.
final class FakeInventoryService: InventoryService, @unchecked Sendable {
    private let lock = NSLock()
    private var _pages: [ItemPage] = []
    private var _item: Schemas.Item = Fixtures.item()
    private var _connections: [Schemas.Connection] = [Fixtures.connection(.ebay, mode: "api")]
    private var _variants: [Schemas.VariantSuggestion] = []
    private var _operations: [Schemas.Operation] = []
    private var _failure: APIFailure?
    private var _failingCall: String?
    private var _calls: [String] = []
    private var _queries: [InventoryQuery] = []
    private var _variantsSent: [Schemas.ListingVariant] = []
    private var _requests: [(ListingRequest, String)] = []
    private var _createdOn: [String] = []
    private var _replaced: [Schemas.ItemReplace] = []
    private var _floors: [Schemas.MarketplaceFloor] = []
    private var _activityPages: [ActivityPage] = []
    private var _itemsByID: [String: Schemas.Item] = [:]
    private var _deleted: [String] = []
    private var _categories: Schemas.MarketplaceCategories?
    private var _changes: [Schemas.ItemChangeWaitResult] = []

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    var pages: [ItemPage] {
        get { locked { _pages } }
        set { locked { _pages = newValue } }
    }

    var item: Schemas.Item {
        get { locked { _item } }
        set { locked { _item = newValue } }
    }

    var connectionList: [Schemas.Connection] {
        get { locked { _connections } }
        set { locked { _connections = newValue } }
    }

    var variants: [Schemas.VariantSuggestion] {
        get { locked { _variants } }
        set { locked { _variants = newValue } }
    }

    /// The next call that can fail throws this, once.
    var failure: APIFailure? {
        get { locked { _failure } }
        set { locked { _failure = newValue } }
    }

    /// Only this call (by name prefix) throws ``failure``; nil means the next call that can.
    var failingCall: String? {
        get { locked { _failingCall } }
        set { locked { _failingCall = newValue } }
    }

    /// The marketplace of every draft created, in order.
    var createdOn: [String] {
        locked { _createdOn }
    }

    var calls: [String] {
        locked { _calls }
    }

    var queries: [InventoryQuery] {
        locked { _queries }
    }

    var variantsSent: [Schemas.ListingVariant] {
        locked { _variantsSent }
    }

    var requests: [(ListingRequest, String)] {
        locked { _requests }
    }

    private func record(_ call: String) throws(APIFailure) {
        let failure = locked { () -> APIFailure? in
            _calls.append(call)
            if let only = _failingCall, !call.hasPrefix(only) {
                return nil
            }
            defer { _failure = nil }
            return _failure
        }
        if let failure {
            throw failure
        }
    }

    func items(_ query: InventoryQuery, cursor: String?) async throws(APIFailure) -> ItemPage {
        locked { _queries.append(query) }
        try record("items\(cursor.map { ":\($0)" } ?? "")")
        return locked { _pages.isEmpty ? ItemPage(items: [], nextCursor: nil) : _pages.removeFirst() }
    }

    /// Items by id, for the calls about several items; any other id answers ``item``.
    var itemsByID: [String: Schemas.Item] {
        get { locked { _itemsByID } }
        set { locked { _itemsByID = newValue } }
    }

    /// The ids of the items deleted, in order.
    var deleted: [String] {
        locked { _deleted }
    }

    /// What `marketplaceCategories` answers; nil maps every item (nothing to pick).
    var categories: Schemas.MarketplaceCategories? {
        get { locked { _categories } }
        set { locked { _categories = newValue } }
    }

    func item(id: String) async throws(APIFailure) -> Schemas.Item {
        locked { _calls.append("item") }
        return locked { _itemsByID[id] ?? _item }
    }

    func deleteItem(id: String) async throws(APIFailure) {
        try record("delete:\(id)")
        locked { _deleted.append(id) }
    }

    /// The details of every replace, in order.
    var replaced: [Schemas.ItemReplace] {
        locked { _replaced }
    }

    func replaceItem(id _: String, with replace: Schemas.ItemReplace) async throws(APIFailure) -> Schemas.Item {
        locked { _replaced.append(replace) }
        try record("replaceItem")
        return locked {
            _item.details = replace.details
            _item.version = replace.expectedVersion + 1
            return _item
        }
    }

    /// The item's floors, as `getItemPricing` gives them.
    var floorList: [Schemas.MarketplaceFloor] {
        get { locked { _floors } }
        set { locked { _floors = newValue } }
    }

    func floors(itemID _: String) async throws(APIFailure) -> [Schemas.MarketplaceFloor] {
        try record("floors")
        return floorList
    }

    func connections() async throws(APIFailure) -> [Schemas.Connection] {
        connectionList
    }

    func analysisVariants(analysisID _: String) async throws(APIFailure) -> [Schemas.VariantSuggestion] {
        locked { _calls.append("analysis") }
        return variants
    }

    func operations(listingID _: String) async throws(APIFailure) -> [Schemas.Operation] {
        locked { _operations }
    }

    func events(operationID _: String) async throws(APIFailure) -> [Schemas.OperationEvent] {
        []
    }

    /// The answers of the item's waits for a change, one per wait, in order; once none is left,
    /// a wait answers after a moment that nothing changed.
    var changes: [Schemas.ItemChangeWaitResult] {
        get { locked { _changes } }
        set { locked { _changes = newValue } }
    }

    func waitForChange(itemID _: String, after: String?, waitSeconds _: Int) async throws(APIFailure)
        -> Schemas.ItemChangeWaitResult
    {
        try record("wait:\(after ?? "none")")
        if let answer = locked({ _changes.isEmpty ? nil : _changes.removeFirst() }) {
            return answer
        }
        try? await Task.sleep(for: .milliseconds(20))
        return .init(changed: after == nil, token: after ?? "t0")
    }

    /// The item's activity, one page per call, in order.
    var activityPages: [ActivityPage] {
        get { locked { _activityPages } }
        set { locked { _activityPages = newValue } }
    }

    func activity(itemID _: String, cursor: String?) async throws(APIFailure) -> ActivityPage {
        try record("activity\(cursor.map { ":\($0)" } ?? "")")
        return locked {
            _activityPages.isEmpty ? ActivityPage(entries: [], nextCursor: nil) : _activityPages.removeFirst()
        }
    }

    func createListing(
        itemID _: String,
        marketplace: Schemas.KnownMarketplace,
        variant: Schemas.ListingVariant,
        idempotencyKey _: String,
    ) async throws(APIFailure) -> Schemas.Listing {
        locked {
            _variantsSent.append(variant)
            _createdOn.append(marketplace.rawValue)
        }
        try record("create")
        return Fixtures.listing(status: .draft, label: "Draft", tone: .neutral, actions: [.publish], variant: variant)
    }

    func marketplaceCategories(
        itemID _: String,
        marketplace _: String,
    ) async throws(APIFailure) -> Schemas.MarketplaceCategories {
        if let categories {
            return categories
        }
        // Listora maps the item, as for most items: nothing to pick.
        let mapped = Schemas.MarketplaceCategory(ref: "Men > Tops > T-shirts", path: ["Men", "Tops", "T-shirts"])
        return Schemas.MarketplaceCategories(suggested: mapped, likely: [mapped], choices: [mapped])
    }

    func replaceDraft(listingID _: String, variant: Schemas.ListingVariant) async throws(APIFailure) -> Schemas
        .Listing
    {
        locked { _variantsSent.append(variant) }
        try record("replace")
        return Fixtures.listing(status: .draft, label: "Draft", tone: .neutral, actions: [.publish], variant: variant)
    }

    func perform(_ request: ListingRequest, idempotencyKey: String) async throws(APIFailure) -> Schemas.Listing {
        locked { _requests.append((request, idempotencyKey)) }
        try record("perform")
        return Fixtures.listing()
    }

    func retry(operationID: String, idempotencyKey _: String) async throws(APIFailure) -> Schemas.Operation {
        try record("retry:\(operationID)")
        return Fixtures.operation(status: .queued, label: "Delisting...", tone: .inProgress)
    }

    func tryNow(operationID: String, idempotencyKey _: String) async throws(APIFailure) -> Schemas.Operation {
        try record("tryNow:\(operationID)")
        return Fixtures.operation(status: .retrying, label: "Delisting...", tone: .inProgress)
    }
}
