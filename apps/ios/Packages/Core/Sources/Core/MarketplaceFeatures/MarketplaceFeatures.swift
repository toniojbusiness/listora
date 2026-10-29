import Foundation
import Observation

/// What the app shows of each marketplace (docs/features/verified-features.md): only the
/// features that passed a live end-to-end test there, as Listora lists them. A feature not in the
/// list has no screen, row, button, empty state, or error. Until the list loads, and when it
/// can't, nothing gated shows.
///
/// The deployment owner's account also has Test mode (docs/features/test-mode.md): with it on,
/// Listora lists every built feature, and the ones on only for the test show a "Testing" tag.
/// Every other account never sees Test mode.
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
        case revise
    }

    /// The owner's Test mode as the list says it; every customer's account has none.
    public enum TestMode: Equatable, Sendable {
        case unavailable
        case off
        case enabled
    }

    /// Listora's list: each marketplace (`depop`) with the features it shows, those on only for
    /// Test mode, and the account's Test mode. Features this build doesn't know are kept and
    /// never asked for.
    public struct List: Equatable, Sendable, ExpressibleByDictionaryLiteral {
        public var shown: [String: Set<String>]
        public var testing: [String: Set<String>]
        public var testMode: TestMode

        public init(
            shown: [String: Set<String>],
            testing: [String: Set<String>] = [:],
            testMode: TestMode = .unavailable,
        ) {
            self.shown = shown
            self.testing = testing
            self.testMode = testMode
        }

        public init(dictionaryLiteral elements: (String, Set<String>)...) {
            self.init(shown: Dictionary(elements, uniquingKeysWith: { first, _ in first }))
        }
    }

    private var list = List(shown: [:])
    /// The last Test mode change that didn't go through, in words for the switch's footer.
    public private(set) var testModeError: String?
    private let load: @Sendable () async throws -> List
    private let saveTestMode: (@Sendable (Bool) async throws -> List)?

    /// `load` asks Listora for every marketplace's features; `saveTestMode` turns Test mode on or
    /// off and returns the list under it.
    public init(
        load: @escaping @Sendable () async throws -> List,
        saveTestMode: (@Sendable (Bool) async throws -> List)? = nil,
    ) {
        self.load = load
        self.saveTestMode = saveTestMode
    }

    /// Reads the list again; a read that fails keeps what showed before.
    public func refresh() async {
        guard let loaded = try? await load() else { return }
        list = loaded
    }

    /// Whether the feature shows on the marketplace (`depop`).
    public func shows(_ feature: Feature, on marketplace: String) -> Bool {
        list.shown[marketplace]?.contains(feature.rawValue) == true
    }

    /// Whether the feature shows on any marketplace.
    public func showsAnywhere(_ feature: Feature) -> Bool {
        list.shown.values.contains { $0.contains(feature.rawValue) }
    }

    /// Whether the feature shows on the marketplace only because Test mode is on: it gets a
    /// "Testing" tag.
    public func isTesting(_ feature: Feature, on marketplace: String) -> Bool {
        list.testing[marketplace]?.contains(feature.rawValue) == true
    }

    /// Whether the feature shows only because Test mode is on, wherever it shows.
    public func isTestingEverywhere(_ feature: Feature) -> Bool {
        let shownOn = list.shown.filter { $0.value.contains(feature.rawValue) }.map(\.key)
        return !shownOn.isEmpty && shownOn.allSatisfy { isTesting(feature, on: $0) }
    }

    /// The account's Test mode: `unavailable` for every customer's account.
    public var testMode: TestMode {
        list.testMode
    }

    /// Turns Test mode on or off. A change that fails leaves the switch as it was and says why.
    public func setTestMode(_ enabled: Bool) async {
        guard let saveTestMode, list.testMode != .unavailable else { return }
        do {
            list = try await saveTestMode(enabled)
            testModeError = nil
        } catch {
            testModeError = enabled
                ? "Couldn't turn on Test mode. Try again."
                : "Couldn't turn off Test mode. Try again."
        }
    }
}
