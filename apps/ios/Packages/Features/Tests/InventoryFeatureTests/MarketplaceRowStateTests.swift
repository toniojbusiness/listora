import ListoraAPI
import Testing
@testable import InventoryFeature

@Suite("Marketplace rows")
struct MarketplaceRowStateTests {
    @Test
    func `shows the server's status exactly, with its tone`() {
        for (label, tone, expected) in [
            ("Active (confirmed by eBay)", Schemas.KnownStatusTone.success, MarketplaceRowState.Tone.success),
            ("Delisting... retry 2 of 6", .inProgress, .inProgress),
            ("Delist failed - Retry", .failed, .failed),
            ("Checking...", .checking, .checking),
            ("Action needed - delist on Poshmark", .actionNeeded, .actionNeeded),
            ("Done (you confirmed)", .success, .success),
        ] {
            let row = MarketplaceRowState(
                marketplace: .ebay,
                listing: Fixtures.listing(label: label, tone: tone),
                connection: Fixtures.connection(.ebay, mode: "api"),
            )
            #expect(row.statusLabel == label)
            #expect(row.tone == expected)
        }
    }

    @Test
    func `offers Retry first after a failure, and the listing's other actions`() {
        let failed = Fixtures.operation(status: .failed, label: "Delist failed - Retry", tone: .failed)
        let row = MarketplaceRowState(
            marketplace: .ebay,
            listing: Fixtures.listing(label: "Delist failed - Retry", tone: .failed, latest: failed),
            connection: Fixtures.connection(.ebay, mode: "api"),
        )
        #expect(row.actions == [.retry(operationID: Fixtures.operationID), .changePrice, .end, .check])
        #expect(!row.isWorking)
        #expect(row.priceLabel == "$39.00")
    }

    @Test
    func `offers nothing while a change runs, and says it is working`() {
        let running = Fixtures.operation(status: .verifying, label: "Checking...", tone: .checking)
        let row = MarketplaceRowState(
            marketplace: .ebay,
            listing: Fixtures.listing(label: "Checking...", tone: .checking, actions: [], latest: running),
            connection: Fixtures.connection(.ebay, mode: "api"),
        )
        #expect(row.actions.isEmpty)
        #expect(row.isWorking)
    }

    @Test
    func `lists through an API connection only, and never claims a listing that is not there`() {
        let connected = MarketplaceRowState(
            marketplace: .ebay,
            listing: nil,
            connection: Fixtures.connection(.ebay, mode: "api"),
        )
        #expect(connected.statusLabel == "Not listed")
        #expect(connected.tone == .neutral)
        #expect(connected.actions == [.list])
        #expect(connected.modeLabel == "Through eBay's API")

        let reauth = MarketplaceRowState(
            marketplace: .ebay,
            listing: nil,
            connection: Fixtures.connection(.ebay, mode: "api", status: "reauth_required"),
        )
        #expect(reauth.actions.isEmpty)
        let unconnected = MarketplaceRowState(marketplace: .ebay, listing: nil, connection: nil)
        #expect(unconnected.actions.isEmpty)
        let poshmark = MarketplaceRowState(
            marketplace: .poshmark,
            listing: nil,
            connection: Fixtures.connection(.poshmark, mode: "assisted"),
        )
        #expect(poshmark.actions.isEmpty)
        #expect(poshmark.modeLabel == "Assisted")
    }
}
