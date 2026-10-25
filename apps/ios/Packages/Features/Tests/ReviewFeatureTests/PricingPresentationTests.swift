import ListoraAPI
import Testing
@testable import ReviewFeature

struct PricingPresentationTests {
    @Test
    func `shows every source label exactly as the server sent it`() throws {
        let presentation = PricingPresentation(Fixtures.pricing())
        #expect(presentation.tiers.map(\.label) == [
            "Quick sale (AI estimate)",
            "Recommended (AI estimate)",
            "Higher profit (AI estimate)",
        ])
        #expect(presentation.tiers.map(\.price) == ["$18.00", "$26.00", "$38.00"])
        let estimate = try #require(presentation.estimate)
        #expect(estimate.label == "AI estimate - not based on sold listings")
        #expect(estimate.confidence == "Confidence 55%")
        #expect(estimate.range == "$18.00 to $38.00")
        #expect(presentation.noSoldDataMessage == "No sold data available for this item")
        #expect(presentation.soldData.isEmpty)
        #expect(presentation.defaultTier?.tier == .recommended)
    }

    @Test
    func `never writes its own words about sold data`() {
        // The words "sold" and "comps" appear only next to real sold data (the label guard).
        let presentation = PricingPresentation(Fixtures.pricing())
        let ownWords = presentation.tiers.map(\.label) + presentation.floors.flatMap { $0.breakdown.map(\.label) }
            + presentation.floors.map(\.feeNote)
        for text in ownWords {
            #expect(!text.localizedCaseInsensitiveContains("sold"), "\(text)")
            #expect(!text.localizedCaseInsensitiveContains("comps"), "\(text)")
        }
    }

    @Test
    func `shows the floor per marketplace and warns below the highest`() throws {
        let presentation = PricingPresentation(Fixtures.pricing())
        #expect(presentation.floors.map(\.name) == ["eBay", "Depop"])
        #expect(presentation.floors.map(\.price) == ["$16.11", "$14.97"])
        let ebay = try #require(presentation.floors.first)
        #expect(ebay.breakdown.map(\.label) == ["Cost", "Estimated fees", "Shipping", "Minimum profit"])
        #expect(ebay.breakdown.map(\.amount) == ["$12.00", "$4.11", "$0.00", "$0.00"])
        #expect(ebay.feeNote == "Fees from ebay-2026-10")
        #expect(presentation.highestFloor?.marketplace == "ebay")

        #expect(presentation.warning(for: 1800) == nil)
        #expect(presentation.warning(for: 1500)
            == "Below your floor on eBay, so you would make less than your minimum after fees.")
        #expect(presentation.warning(for: 1000)
            == "Below your floor on eBay and Depop, so you would make less than your minimum after fees.")
        #expect(presentation.shortWarning(for: 1800) == nil)
        #expect(presentation.shortWarning(for: 1500) == "Below your floor on eBay")
        #expect(presentation.shortWarning(for: 1000) == "Below your floor on eBay and Depop")
        #expect(presentation.floorsAbove(1000).map(\.marketplace) == ["ebay", "depop"])
    }

    @Test
    func `has no floors without a cost`() {
        let presentation = PricingPresentation(Fixtures.pricing(floors: []))
        #expect(presentation.floors.isEmpty)
        #expect(presentation.highestFloor == nil)
        #expect(presentation.warning(for: 1) == nil)
        #expect(presentation.shortWarning(for: 1) == nil)
    }

    @Test
    func `shows sold data with its label, but marketplace-bound data only in that marketplace's listing`() {
        let depop = Schemas.SoldComparables(
            source: .init(value1: .depopInspiration, value2: "depop_inspiration"),
            marketplace: .init(value1: .depop, value2: "depop"),
            label: "Sold on Depop (last 90 days)",
            sampleSize: 9,
            low: Fixtures.usd(2000),
            median: Fixtures.usd(2700),
            high: Fixtures.usd(3900),
            fetchedAt: Fixtures.date,
        )
        let own = Schemas.SoldComparables(
            source: .init(value1: .ownHistory, value2: "own_history"),
            label: "Your sales of similar items",
            sampleSize: 3,
            low: Fixtures.usd(2200),
            median: Fixtures.usd(2500),
            high: Fixtures.usd(3000),
            fetchedAt: Fixtures.date,
        )
        let presentation = PricingPresentation(Fixtures.pricing(soldComparables: [depop, own]))
        #expect(presentation.noSoldDataMessage == nil)
        #expect(presentation.soldData.map(\.label) == ["Your sales of similar items"])
        #expect(presentation.soldData.first?.summary == "3 sold, $22.00 to $30.00, median $25.00")
    }

    @Test
    func `opens research links as given`() {
        let presentation = PricingPresentation(Fixtures.pricing())
        #expect(presentation.researchLinks.map(\.label) == ["Search eBay sold listings"])
        #expect(presentation.researchLinks.first?.url.host() == "www.ebay.com")
    }

    @Test
    func `says what Identify harder uses from the plan`() {
        #expect(QuotaPresentation.premiumLine(Fixtures.usage(premiumUsed: 2, limit: 10))
            == "Uses 1 premium identification. 2 of 10 used this month, 8 left.")
        #expect(QuotaPresentation.premiumLine(Fixtures.usage(premiumUsed: 3, limit: nil))
            == "Uses 1 premium identification. 3 used this month.")
        #expect(QuotaPresentation.premiumLine(nil) == "Uses 1 premium identification.")
        #expect(QuotaPresentation.premiumLine(Fixtures.usage(premiumUsed: 10, limit: 10))
            == "All 10 premium identifications in your plan are used this month.")
        #expect(QuotaPresentation.isUsedUp(Fixtures.usage(premiumUsed: 10, limit: 10)))
        #expect(!QuotaPresentation.isUsedUp(Fixtures.usage(premiumUsed: 10, limit: nil)))
    }
}

struct AmountEntryTests {
    func typed(_ keys: [AmountEntry.Key]) -> AmountEntry {
        var entry = AmountEntry()
        for key in keys {
            entry.press(key)
        }
        return entry
    }

    @Test
    func `reads whole dollars and cents in integer cents`() {
        #expect(typed([.digit(1), .digit(2)]).cents == 1200)
        #expect(typed([.digit(1), .digit(2), .decimalPoint, .digit(5)]).cents == 1250)
        #expect(typed([.digit(1), .digit(2), .decimalPoint, .digit(5)]).display == "$12.5")
        #expect(typed([.decimalPoint, .digit(9), .digit(9)]).cents == 99)
        #expect(AmountEntry().cents == nil)
        #expect(AmountEntry().display == "$0")
        #expect(AmountEntry(cents: 9_999_999).display == "$99,999.99")
        #expect(AmountEntry(cents: 125_000).display == "$1,250")
    }

    @Test
    func `ignores keys that would make an invalid amount`() {
        #expect(typed([.digit(1), .decimalPoint, .decimalPoint, .digit(2), .digit(3), .digit(4)]).text == "1.23")
        #expect(typed([.digit(0), .digit(0), .digit(7)]).text == "7")
        #expect(typed(Array(repeating: .digit(9), count: 8)).text == "99999")
        #expect(typed([.digit(4), .delete, .delete]).isEmpty)
    }

    @Test
    func `starts from an amount the item already has`() {
        #expect(AmountEntry(cents: 1200).text == "12")
        #expect(AmountEntry(cents: 1205).text == "12.05")
        #expect(AmountEntry(cents: 1205).cents == 1205)
    }
}
