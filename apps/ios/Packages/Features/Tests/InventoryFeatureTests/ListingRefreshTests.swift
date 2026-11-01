import APIClient
import Foundation
import ListoraAPI
import Testing
@testable import InventoryFeature

/// A ``ListingRefreshService`` that keeps what was saved and can fail.
actor FakeListingRefreshService: ListingRefreshService {
    var stored = Components.Schemas.ListingRefreshSettings(cadence: .init(value1: .every72Hours))
    var item = Components.Schemas.ItemRefresh(accountCadence: .init(value1: .every72Hours))
    private(set) var saved: [Components.Schemas.ListingRefreshSettingsReplace] = []
    private(set) var savedItem: [Components.Schemas.ItemRefreshReplace] = []
    var failure: APIFailure?

    func fail(with failure: APIFailure?) {
        self.failure = failure
    }

    func setItem(_ item: Components.Schemas.ItemRefresh) {
        self.item = item
    }

    func settings() async throws(APIFailure) -> Components.Schemas.ListingRefreshSettings {
        if let failure {
            throw failure
        }
        return stored
    }

    func saveSettings(
        _ replace: Components.Schemas.ListingRefreshSettingsReplace,
    ) async throws(APIFailure) -> Components.Schemas.ListingRefreshSettings {
        if let failure {
            throw failure
        }
        saved.append(replace)
        stored = .init(
            cadence: .init(value1: replace.cadence),
            customHours: replace.customHours,
            quietWindow: replace.quietWindow,
            timeZone: replace.timeZone,
        )
        return stored
    }

    func itemRefresh(itemID _: String) async throws(APIFailure) -> Components.Schemas.ItemRefresh {
        if let failure {
            throw failure
        }
        return item
    }

    func saveItemRefresh(
        itemID _: String,
        _ replace: Components.Schemas.ItemRefreshReplace,
    ) async throws(APIFailure) -> Components.Schemas.ItemRefresh {
        if let failure {
            throw failure
        }
        savedItem.append(replace)
        item = .init(
            cadence: replace.cadence.map { .init(value1: $0) },
            accountCadence: item.accountCadence,
        )
        return item
    }
}

@Suite("Listing refresh")
@MainActor
struct ListingRefreshTests {
    private let now = Date(timeIntervalSince1970: 1_793_000_000)

    private func refresh(
        _ state: Components.Schemas.KnownListingRefreshState,
        next: Date? = nil,
        last: Date? = nil,
    ) -> Components.Schemas.ListingRefresh {
        .init(state: .init(value1: state), nextAt: next, lastAt: last)
    }

    @Test
    func `names each cadence, a custom one in hours or whole days`() {
        #expect(RefreshWords.name(.every72Hours) == "Every 72 hours")
        #expect(RefreshWords.name(.everyFewDays) == "Every 5 days")
        #expect(RefreshWords.name(.off) == "Off")
        #expect(RefreshWords.name(.custom, customHours: 36) == "Every 36 hours")
        #expect(RefreshWords.name(.custom, customHours: 96) == "Every 4 days")
        #expect(RefreshWords.name(.init(value2: "monthly"), customHours: nil) == "monthly")
    }

    @Test
    func `shows a live listing's next and last refresh, and nothing where there is none`() throws {
        let scheduled = try #require(RefreshWords.line(
            refresh(.scheduled, next: now.addingTimeInterval(2 * 86400), last: now.addingTimeInterval(-86400)),
            now: now,
        ))
        #expect(scheduled.hasPrefix("Next refresh "))
        #expect(scheduled.contains(" · Last refreshed "))
        #expect(RefreshWords
            .line(refresh(.scheduled, next: now.addingTimeInterval(-60)), now: now) == "Refreshing soon")
        #expect(RefreshWords.line(refresh(.off), now: now) == "Refresh off")
        #expect(RefreshWords.line(refresh(.unavailable), now: now) == nil)
        #expect(RefreshWords.line(nil, now: now) == nil)
    }

    @Test
    func `puts the refresh line on the marketplace row`() {
        var listing = Fixtures.listing()
        listing.refresh = refresh(.off)
        let row = MarketplaceRowState(
            marketplace: .ebay,
            listing: listing,
            connection: Fixtures.connection(.ebay, mode: "api"),
            now: now,
        )
        #expect(row.refreshLine == "Refresh off")
        let plain = MarketplaceRowState(
            marketplace: .ebay,
            listing: Fixtures.listing(),
            connection: Fixtures.connection(.ebay, mode: "api"),
            now: now,
        )
        #expect(plain.refreshLine == nil)
    }

    @Test
    func `loads and saves the setting in this device's time zone, with quiet hours`() async throws {
        let service = FakeListingRefreshService()
        let chicago = try #require(TimeZone(identifier: "America/Chicago"))
        let model = ListingRefreshSettingsModel(service: service) { chicago }
        await model.load()
        #expect(model.phase == .loaded)
        #expect(model.cadence == .every72Hours)
        #expect(!model.hasQuietHours)

        model.cadence = .custom
        model.customHours = 36
        model.hasQuietHours = true
        #expect(await model.save())
        let saved = await service.saved
        #expect(saved == [.init(
            cadence: .custom,
            customHours: 36,
            quietWindow: .init(start: "22:00", end: "07:00"),
            timeZone: "America/Chicago",
        )])
        #expect(model.hasQuietHours)

        // A named cadence sends no hours.
        model.cadence = .weekly
        #expect(await model.save())
        #expect(await service.saved.last?.customHours == nil)
    }

    @Test
    func `refuses an empty quiet window, and keeps a failed save's message`() async {
        let service = FakeListingRefreshService()
        let model = ListingRefreshSettingsModel(service: service)
        await model.load()
        model.hasQuietHours = true
        model.quietEnd = model.quietStart
        #expect(model.quietHoursAreEmpty)

        model.quietEnd = DateComponents(hour: 6, minute: 0)
        await service.fail(with: APIFailure(
            statusCode: 500,
            code: "internal_error",
            message: "Listora is down.",
            retryable: true,
        ))
        #expect(await !(model.save()))
        #expect(model.saveError == "Listora is down.")
    }

    @Test
    func `gives an item its own cadence, and back to the account's`() async {
        let service = FakeListingRefreshService()
        let model = ItemRefreshModel(itemID: Fixtures.itemID, service: service)
        await model.load()
        #expect(model.label == "My setting (every 72 hours)")
        await model.choose(.off)
        #expect(model.label == "Off")
        await model.choose(nil)
        #expect(model.label == "My setting (every 72 hours)")
        #expect(await service.savedItem == [.init(cadence: .off), .init()])
    }

    @Test
    func `checks the item's chip in use, and none before it loads`() async {
        let service = FakeListingRefreshService()
        let model = ItemRefreshModel(itemID: Fixtures.itemID, service: service)
        #expect(!model.isChosen(nil))
        #expect(model.accountLabel == "My setting")
        await model.load()
        #expect(model.isChosen(nil))
        #expect(!model.isChosen(.every72Hours))
        #expect(model.accountLabel == "My setting (every 72 hours)")
        await model.choose(.daily)
        #expect(model.isChosen(.daily))
        #expect(!model.isChosen(nil))
        #expect(!model.isChosen(.weekly))
        #expect(model.hint == "Tap one to change how often.")
    }

    @Test
    func `a failed item save keeps the chip in use and shows why`() async {
        let service = FakeListingRefreshService()
        let model = ItemRefreshModel(itemID: Fixtures.itemID, service: service)
        await model.load()
        await service.fail(with: APIFailure(
            statusCode: 500,
            code: "internal_error",
            message: "Listora is down.",
            retryable: true,
        ))
        await model.choose(.weekly)
        #expect(model.isChosen(nil))
        #expect(!model.isChosen(.weekly))
        #expect(model.saveError == "Listora is down.")
    }

    @Test
    func `an item's own custom time is named in the hint, with no chip checked`() async {
        let service = FakeListingRefreshService()
        await service.setItem(.init(
            cadence: .init(value1: .custom),
            customHours: 36,
            accountCadence: .init(value1: .every72Hours),
        ))
        let model = ItemRefreshModel(itemID: Fixtures.itemID, service: service)
        await model.load()
        #expect(RefreshWords.itemCadences.allSatisfy { !model.isChosen($0) })
        #expect(!model.isChosen(nil))
        #expect(model.hint == "Every 36 hours. Tap one to change how often.")
    }

    @Test
    func `offers every choice in order, the item screen all but custom`() {
        #expect(RefreshWords.cadences == [.off, .every72Hours, .daily, .everyFewDays, .weekly, .custom])
        #expect(RefreshWords.itemCadences == [.off, .every72Hours, .daily, .everyFewDays, .weekly])
    }
}
