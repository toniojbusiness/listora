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
    func `shows Listora's own features only once listed, tagging those on for Test mode`() async {
        let hidden = MarketplaceFeatures { MarketplaceFeatures.List(shown: [:]) }
        await hidden.refresh()
        #expect(!hidden.shows(.thriftScan))
        let testing = MarketplaceFeatures {
            MarketplaceFeatures.List(shown: [:], testMode: .enabled, app: ["thrift_scan"], appTesting: ["thrift_scan"])
        }
        await testing.refresh()
        #expect(testing.shows(.thriftScan))
        #expect(testing.isTesting(.thriftScan))
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

    @Test
    func `a customer's list has no Test mode, and turning it on does nothing`() async {
        let features = MarketplaceFeatures(load: { ["depop": ["offers"]] }, saveTestMode: { _ in
            Issue.record("a customer never turns on Test mode")
            return [:]
        })
        await features.refresh()
        #expect(features.testMode == .unavailable)
        await features.setTestMode(true)
        #expect(features.testMode == .unavailable)
        #expect(!features.isTesting(.offers, on: "depop"))
    }

    @Test
    func `in Test mode every built feature shows, the untested ones tagged Testing`() async {
        let all: Set = ["offers", "offer_answers", "listing_refresh", "revise"]
        let features = MarketplaceFeatures(
            load: { MarketplaceFeatures.List(shown: ["depop": ["offers"]], testMode: .off) },
            saveTestMode: { enabled in
                enabled ? MarketplaceFeatures.List(
                    shown: ["depop": all, "poshmark": ["listing_refresh"]],
                    testing: ["depop": ["offer_answers", "listing_refresh", "revise"], "poshmark": ["listing_refresh"]],
                    testMode: .enabled,
                ) : MarketplaceFeatures.List(shown: ["depop": ["offers"]], testMode: .off)
            },
        )
        await features.refresh()
        #expect(features.testMode == .off)
        #expect(!features.shows(.revise, on: "depop"))

        await features.setTestMode(true)
        #expect(features.testMode == .enabled)
        #expect(features.shows(.revise, on: "depop"))
        #expect(features.isTesting(.revise, on: "depop"))
        // A verified feature is no test.
        #expect(features.shows(.offers, on: "depop"))
        #expect(!features.isTesting(.offers, on: "depop"))
        #expect(features.isTestingEverywhere(.listingRefresh))
        #expect(!features.isTestingEverywhere(.offers))

        await features.setTestMode(false)
        #expect(features.testMode == .off)
        #expect(!features.shows(.revise, on: "depop"))
    }

    @Test
    func `a Test mode change that fails leaves the switch and says why`() async {
        let features = MarketplaceFeatures(
            load: { MarketplaceFeatures.List(shown: [:], testMode: .off) },
            saveTestMode: { _ in throw Unreachable() },
        )
        await features.refresh()
        await features.setTestMode(true)
        #expect(features.testMode == .off)
        #expect(features.testModeError == "Couldn't turn on Test mode. Try again.")
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
