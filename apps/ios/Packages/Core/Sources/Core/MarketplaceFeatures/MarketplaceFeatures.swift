import Foundation
import Observation

/// What the app shows of each marketplace (docs/features/verified-features.md): only the
/// features that passed a live end-to-end test there, as Listora lists them. A feature not in the
/// list has no screen, row, button, empty state, or error. Until the list loads, and when it
/// can't, nothing gated shows.
@MainActor
@Observable
public final class MarketplaceFeatures {
    /// A feature the app shows only once Listora says it passed live (`KnownMarketplaceFeature`).
    public enum Feature: String, CaseIterable, Sendable {
        case salesHistory = "sales_history"
        case saleChecks = "sale_checks"
        case offers
        case offerAnswers = "offer_answers"
        case listingImport = "listing_import"
        case listingRefresh = "listing_refresh"
    }

    /// Each marketplace (`depop`) with the features Listora says it shows; features this build
    /// doesn't know are kept and never asked for.
    private var shown: [String: Set<String>] = [:]
    private let load: @Sendable () async throws -> [String: Set<String>]

    /// `load` asks Listora for every marketplace's verified features.
    public init(load: @escaping @Sendable () async throws -> [String: Set<String>]) {
        self.load = load
    }

    /// Reads the list again; a read that fails keeps what showed before.
    public func refresh() async {
        guard let loaded = try? await load() else { return }
        shown = loaded
    }

    /// Whether the feature shows on the marketplace (`depop`).
    public func shows(_ feature: Feature, on marketplace: String) -> Bool {
        shown[marketplace]?.contains(feature.rawValue) == true
    }

    /// Whether the feature shows on any marketplace.
    public func showsAnywhere(_ feature: Feature) -> Bool {
        shown.values.contains { $0.contains(feature.rawValue) }
    }
}
