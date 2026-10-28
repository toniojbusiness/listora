import Core
import Foundation
import Testing

@MainActor
struct MarketplaceFeaturesTests {
    private struct Unreachable: Error {}

    @Test
    func `shows nothing gated until Listora's list loads`() {
        let features = MarketplaceFeatures { ["depop": ["offers"]] }
        #expect(!features.shows(.offers, on: "depop"))
        #expect(!features.showsAnywhere(.listingRefresh))
    }

    @Test
    func `shows only the features Listora lists for each marketplace`() async {
        let features = MarketplaceFeatures {
            ["depop": ["offers", "sale_checks", "a_feature_from_later"], "poshmark": []]
        }
        await features.refresh()
        #expect(features.shows(.offers, on: "depop"))
        #expect(features.shows(.saleChecks, on: "depop"))
        #expect(!features.shows(.offerAnswers, on: "depop"))
        #expect(!features.shows(.offers, on: "poshmark"))
        #expect(!features.shows(.offers, on: "mercari"))
        #expect(features.showsAnywhere(.offers))
        #expect(!features.showsAnywhere(.listingRefresh))
    }

    @Test
    func `a list that can't be read keeps what showed before`() async {
        let fails = LockedFlag()
        let features = MarketplaceFeatures {
            if fails.value {
                throw Unreachable()
            }
            return ["mercari": ["listing_import"]]
        }
        await features.refresh()
        fails.value = true
        await features.refresh()
        #expect(features.shows(.listingImport, on: "mercari"))
    }
}

/// A flag the loader closure reads.
private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = false
    var value: Bool {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}
