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

    func item(id _: String) async throws(APIFailure) -> Schemas.Item {
        locked { _calls.append("item") }
        return item
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

    func createListing(
        itemID _: String,
        marketplace _: Schemas.KnownMarketplace,
        variant: Schemas.ListingVariant,
        idempotencyKey _: String,
    ) async throws(APIFailure) -> Schemas.Listing {
        locked { _variantsSent.append(variant) }
        try record("create")
        return Fixtures.listing(status: .draft, label: "Draft", tone: .neutral, actions: [.publish], variant: variant)
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
}
