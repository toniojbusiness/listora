import Foundation
import ListoraAPI
import Testing
@testable import InventoryFeature

@Suite("List on the others")
struct ListOnTheOthersTests {
    @Test
    func `offers List on the others for an item live on one marketplace, even for one more`() {
        let depop = MarketplaceRowState(
            marketplace: .depop,
            listing: Fixtures.listing(label: "Active (confirmed by Depop)", tone: .success),
            connection: Fixtures.connection(.depop, mode: "api"),
        )
        let poshmark = MarketplaceRowState(
            marketplace: .poshmark,
            listing: nil,
            connection: Fixtures.connection(.poshmark, mode: "assisted"),
        )
        let mercari = MarketplaceRowState(marketplace: .mercari, listing: nil, connection: nil)
        #expect(depop.actions.contains(.end))
        #expect(AllMarketplacesActions.showsListAll([depop, poshmark]))
        #expect(AllMarketplacesActions.listTitle(listable: 2, listedSomewhere: true) == "List on the others (2)")
        #expect(AllMarketplacesActions.showsListAll([depop, poshmark, mercari]))
        // An item on no marketplace yet keeps List everywhere, from two marketplaces on.
        #expect(!AllMarketplacesActions.showsListAll([poshmark]))
        #expect(AllMarketplacesActions.showsListAll([poshmark, mercari]))
        #expect(AllMarketplacesActions.listTitle(listable: 2, listedSomewhere: false) == "List everywhere (2)")
    }
}
