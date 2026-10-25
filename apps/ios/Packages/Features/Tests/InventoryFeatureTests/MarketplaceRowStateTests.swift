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
    func `lists eBay through its API, the others assisted, and never claims a listing that is not there`() {
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
        #expect(poshmark.actions == [.list])
        #expect(poshmark.modeLabel == "Assisted - you finish each step in the Poshmark app")
        let mercari = MarketplaceRowState(marketplace: .mercari, listing: nil, connection: nil)
        #expect(mercari.actions == [.list])
    }

    @Test
    func `opens the task of a step that waits on the user, and never offers a check on it`() {
        let waiting = Fixtures.operation(
            kind: .create,
            status: .needsUserAction,
            label: "Action needed - list on Poshmark",
            tone: .actionNeeded,
        )
        let row = MarketplaceRowState(
            marketplace: .poshmark,
            listing: Fixtures.listing(
                status: .draft,
                label: "Action needed - list on Poshmark",
                tone: .actionNeeded,
                actions: [],
                latest: waiting,
            ),
            connection: nil,
        )
        #expect(row.actions == [.openTask(operationID: Fixtures.operationID)])
        #expect(row.tone == .actionNeeded)
        #expect(!row.isWorking)
    }

    @Test
    func `reads typed amounts as cents`() {
        #expect(Formatting.cents(from: "39") == 3900)
        #expect(Formatting.cents(from: "$39.5") == 3950)
        #expect(Formatting.cents(from: "1,250.05") == 125_005)
        #expect(Formatting.cents(from: "39.999") == nil)
        #expect(Formatting.cents(from: "abc") == nil)
        #expect(Formatting.editableAmount(cents: 3950) == "39.50")
    }
}
