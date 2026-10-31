import DesignSystem
import Foundation
import ListoraAPI
import Testing
@testable import InventoryFeature

/// The item's string to each marketplace follows the listing's confirmed state only: a knot is
/// tied when the marketplace confirms the listing, and the string is cut when it confirms the
/// listing ended, so the screen never shows a marketplace action as done before it is.
@Suite("The item's marketplace string")
@MainActor
struct MarketplaceStringTests {
    private func row(_ status: Schemas.KnownListingStatus?) -> MarketplaceRowState {
        MarketplaceRowState(
            marketplace: .poshmark,
            listing: status.map { Fixtures.listing(status: $0) },
            connection: Fixtures.connection(.poshmark, mode: "automation"),
        )
    }

    @Test
    func `a marketplace the item is not on yet hangs on a loose string`() {
        #expect(MarketplacesSection.string(to: row(nil)) == .loose)
    }

    @Test(arguments: [Schemas.KnownListingStatus.active, .ending, .sold])
    func `the knot is tied once the marketplace confirms the listing`(status: Schemas.KnownListingStatus) {
        #expect(MarketplacesSection.string(to: row(status)) == .taut)
    }

    @Test(arguments: [
        Schemas.KnownListingStatus.draft, .queued, .publishing, .error, .unknown, .needsUserAction,
    ])
    func `work that is running, failed, or unconfirmed leaves the string loose`(status: Schemas.KnownListingStatus) {
        #expect(MarketplacesSection.string(to: row(status)) == .loose)
    }

    @Test
    func `the string is cut only once the marketplace confirms the listing ended`() {
        #expect(MarketplacesSection.string(to: row(.ended)) == .cut)
        #expect(MarketplacesSection.string(to: row(.ending)) != .cut, "ending is not ended yet")
    }

    @Test
    func `an item wears the sold stamp from the sale on, while its delists run too`() {
        var item = Fixtures.item()
        for (status, sold) in [
            (Schemas.KnownItemStatus.soldPendingDelist, true), (.sold, true), (.shipped, true),
            (.listed, false), (.ready, false), (.draft, false), (.archived, false),
        ] {
            item.status = .init(value1: status, value2: status.rawValue)
            #expect(item.isSold == sold, "\(status)")
        }
    }
}
