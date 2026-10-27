import Foundation
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
    func `says the last settled change and when, the link to share, and nothing a status already says`() {
        let row = { (operation: Schemas.Operation?) in
            var listing = Fixtures.listing(latest: operation)
            listing.externalUrl = "https://www.ebay.com/itm/123"
            return MarketplaceRowState(
                marketplace: .ebay,
                listing: listing,
                connection: Fixtures.connection(.ebay, mode: "api"),
            )
        }
        let when = Formatting.timestamp(Fixtures.date)
        let price = Fixtures.operation(
            kind: .price,
            status: .succeeded,
            label: "Price changed (confirmed by eBay)",
            tone: .success,
        )
        #expect(row(price).lastChange == "Last change: Price changed (confirmed by eBay), \(when)")
        #expect(row(price).externalURL?.absoluteString == "https://www.ebay.com/itm/123")
        let published = Fixtures.operation(
            kind: .create,
            status: .succeeded,
            label: "Published (confirmed by eBay)",
            tone: .success,
        )
        #expect(row(published).lastChange == nil, "the status says it went live")
        let failed = Fixtures.operation(status: .failed, label: "Delist failed - Retry", tone: .failed)
        #expect(row(failed).lastChange == "Since \(when)")
        let running = Fixtures.operation(status: .running, label: "Delisting...", tone: .inProgress)
        #expect(row(running).lastChange == nil)
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
    func `offers Try now on a change waiting to try again, and says when it will`() throws {
        let now = Fixtures.date
        let calendar = Calendar.current
        let later = try #require(calendar.date(byAdding: .minute, value: 10, to: now))
        var retrying = Fixtures.operation(status: .retrying, label: "Delisting... retry 1 of 5", tone: .inProgress)
        retrying.nextAttemptAt = later
        let row = MarketplaceRowState(
            marketplace: .ebay,
            listing: Fixtures.listing(
                label: "Delisting... retry 1 of 5",
                tone: .inProgress,
                actions: [],
                latest: retrying,
            ),
            connection: Fixtures.connection(.ebay, mode: "api"),
            now: now,
        )
        #expect(row.actions == [.tryNow(operationID: Fixtures.operationID)])
        let time = later.formatted(
            date: calendar.isDate(later, inSameDayAs: now) ? .omitted : .abbreviated,
            time: .shortened,
        )
        #expect(row.scheduleLabel == "Waiting to retry at \(time)")

        var checking = Fixtures.operation(status: .verifying, label: "Checking...", tone: .checking)
        checking.nextAttemptAt = later
        let check = MarketplaceRowState(
            marketplace: .ebay,
            listing: Fixtures.listing(label: "Checking...", tone: .checking, actions: [], latest: checking),
            connection: Fixtures.connection(.ebay, mode: "api"),
            now: now,
        )
        #expect(check.scheduleLabel == "Checking again at \(time)")
        #expect(check.actions == [.tryNow(operationID: Fixtures.operationID)])

        // Once the attempt is due it runs (or waits on this iPhone): nothing to try now.
        let due = MarketplaceRowState(
            marketplace: .ebay,
            listing: Fixtures.listing(
                label: "Delisting... retry 1 of 5",
                tone: .inProgress,
                actions: [],
                latest: retrying,
            ),
            connection: Fixtures.connection(.ebay, mode: "api"),
            now: later.addingTimeInterval(1),
        )
        #expect(due.actions.isEmpty)
        #expect(due.scheduleLabel == nil)
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
        #expect(connected.modeLabel == "Listora does it for you through eBay")

        let reauth = MarketplaceRowState(
            marketplace: .ebay,
            listing: nil,
            connection: Fixtures.connection(.ebay, mode: "api", status: "reauth_required"),
        )
        #expect(reauth.actions.isEmpty)
        #expect(reauth.statusDetail == "Reconnect eBay in Settings > Marketplaces to list it here.")
        let unconnected = MarketplaceRowState(marketplace: .ebay, listing: nil, connection: nil)
        #expect(unconnected.actions.isEmpty)
        #expect(
            unconnected.statusDetail == "Connect your eBay account in Settings > Marketplaces to list it here.",
            "a card without an action says how to list there",
        )
        #expect(connected.statusDetail == nil)
        let poshmark = MarketplaceRowState(
            marketplace: .poshmark,
            listing: nil,
            connection: Fixtures.connection(.poshmark, mode: "assisted"),
        )
        #expect(poshmark.actions == [.list])
        #expect(poshmark.modeLabel == "You finish each step in the Poshmark app")
        let mercari = MarketplaceRowState(marketplace: .mercari, listing: nil, connection: nil)
        #expect(mercari.actions == [.list])
    }

    @Test
    func `lists through a working automation session, and assisted once the session stops working`() {
        let automated = Fixtures.connection(.poshmark, mode: "automation")
        let row = MarketplaceRowState(marketplace: .poshmark, listing: nil, connection: automated)
        #expect(row.actions == [.list])
        #expect(row.modeLabel == "Listora does it for you in your linked Poshmark account")
        #expect(!MarketplaceRowState.isAssisted(marketplace: .poshmark, connection: automated))

        let expired = Fixtures.connection(.poshmark, mode: "automation", status: "reauth_required")
        #expect(MarketplaceRowState.isAssisted(marketplace: .poshmark, connection: expired))
        #expect(MarketplaceRowState.canList(marketplace: .poshmark, connection: expired))
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
}
