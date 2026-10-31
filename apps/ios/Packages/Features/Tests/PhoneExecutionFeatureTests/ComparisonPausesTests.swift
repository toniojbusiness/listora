import Foundation
import Testing
@testable import PhoneExecutionFeature

@MainActor
struct ComparisonPausesTests {
    private final class Clock {
        var now = Date(timeIntervalSince1970: 1_793_400_000)
    }

    private func pauses(_ clock: Clock) -> ComparisonPauses {
        let defaults = UserDefaults(suiteName: "comparison-pauses-\(UUID().uuidString)") ?? .standard
        return ComparisonPauses(defaults: defaults) { clock.now }
    }

    @Test
    func `a check pauses only its marketplace, for 24 hours`() {
        let clock = Clock()
        let pauses = pauses(clock)
        #expect(!pauses.isPaused("depop"))
        pauses.pause("depop")
        #expect(pauses.isPaused("depop"))
        #expect(!pauses.isPaused("ebay"))
        clock.now += 23 * 60 * 60
        #expect(pauses.isPaused("depop"))
        clock.now += 2 * 60 * 60
        #expect(!pauses.isPaused("depop"))
    }

    @Test
    func `a request to slow down pauses it for the time given`() {
        let clock = Clock()
        let pauses = pauses(clock)
        pauses.pause("depop", for: .seconds(60 * 60))
        clock.now += 59 * 60
        #expect(pauses.isPaused("depop"))
        clock.now += 2 * 60
        #expect(!pauses.isPaused("depop"))
    }

    @Test
    func `the comparison pages block images, fonts, and media`() throws {
        let rules = try #require(
            JSONSerialization.jsonObject(with: Data(WebMarketComparisons.blockedMedia.utf8)) as? [[String: Any]],
        )
        let trigger = try #require(rules.first?["trigger"] as? [String: Any])
        #expect(trigger["resource-type"] as? [String] == ["image", "font", "media"])
        #expect((rules.first?["action"] as? [String: Any])?["type"] as? String == "block")
    }
}
