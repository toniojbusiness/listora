import Core
import Foundation
import Testing

@MainActor
struct InteractionMeterTests {
    /// A clock the test moves by hand.
    final class Clock {
        var now = Date(timeIntervalSince1970: 1_800_000_000)

        func advance(_ seconds: TimeInterval) {
            now = now.addingTimeInterval(seconds)
        }
    }

    let clock = Clock()
    let storage = InMemoryInteractionStorage()

    func meter() -> InteractionMeter {
        let clock = clock
        return InteractionMeter(storage: storage, now: { clock.now })
    }

    @Test
    func `counts time and taps only while a screen of the session shows`() {
        let meter = meter()
        meter.begin("draft")
        meter.recordTap()
        clock.advance(5)
        #expect(meter.session("draft")?.onScreen == 0, "nothing shows yet")

        meter.enter("draft")
        clock.advance(4)
        meter.recordTap()
        meter.recordTap()
        // The next screen of the same flow is pushed: the clock keeps running.
        meter.enter("draft")
        meter.leave("draft")
        clock.advance(6)
        meter.leave("draft")
        clock.advance(100)
        meter.recordTap()

        let session = meter.session("draft")
        #expect(session?.onScreen == 10)
        #expect(session?.active == 10)
        #expect(session?.taps == 2)
    }

    @Test
    func `separates waiting on Listora from the seller's active time`() {
        let meter = meter()
        meter.begin("draft")
        meter.enter("draft")
        clock.advance(3)
        meter.setWaiting(true, for: "draft")
        clock.advance(8)
        meter.setWaiting(false, for: "draft")
        clock.advance(2)

        let session = meter.session("draft")
        #expect(session?.onScreen == 13)
        #expect(session?.waiting == 8)
        #expect(session?.active == 5)
    }

    @Test
    func `pauses while the app is in the background`() {
        let meter = meter()
        meter.begin("draft")
        meter.enter("draft")
        clock.advance(2)
        meter.setAppActive(false)
        clock.advance(60)
        meter.recordTap()
        meter.setAppActive(true)
        clock.advance(1)

        #expect(meter.session("draft")?.onScreen == 3)
        #expect(meter.session("draft")?.taps == 0)
    }

    @Test
    func `keeps what a session measured when it takes its draft's id`() {
        let meter = meter()
        meter.begin("pending")
        meter.enter("pending")
        meter.setWaiting(true, for: "pending")
        clock.advance(2)
        meter.rename("pending", to: "draft")
        meter.setWaiting(false, for: "draft")
        meter.recordTap()
        clock.advance(1)
        meter.leave("draft")

        #expect(meter.session("pending") == nil)
        let session = meter.session("draft")
        #expect(session?.onScreen == 3)
        #expect(session?.waiting == 2)
        #expect(session?.taps == 1)
    }

    @Test
    func `finishes with a summary, keeps it, and survives a relaunch`() throws {
        var meter = meter()
        meter.begin("draft")
        meter.enter("draft")
        clock.advance(12)
        meter.recordTap()
        meter.leave("draft")

        // A relaunch resumes the session from storage.
        meter = self.meter()
        meter.enter("draft")
        clock.advance(8)
        meter.recordTap()
        let summary = try #require(meter.finish("draft", itemID: "item", sku: "AJ-000184"))

        #expect(summary.active == 20)
        #expect(summary.taps == 2)
        #expect(summary.sku == "AJ-000184")
        #expect(summary.meetsGoal)
        #expect(meter.session("draft") == nil)
        #expect(self.meter().recentSummaries == [summary])
        #expect(meter.finish("draft", itemID: "item", sku: "AJ-000184") == nil, "a session finishes once")
    }

    @Test
    func `misses the goal above 30 seconds of active time`() throws {
        let meter = meter()
        meter.begin("draft")
        meter.enter("draft")
        clock.advance(31)
        #expect(try #require(meter.finish("draft", itemID: "item", sku: "AJ-000001")).meetsGoal == false)
    }

    @Test
    func `discards deleted drafts and drops abandoned sessions`() {
        var meter = meter()
        meter.begin("deleted")
        meter.discard("deleted")
        #expect(meter.session("deleted") == nil)

        meter.begin("abandoned")
        clock.advance(InteractionMeter.abandonedAfter + 1)
        meter = self.meter()
        #expect(meter.session("abandoned") == nil)
    }
}
