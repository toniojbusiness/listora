import Core
import Foundation
import Testing

struct DelistClockTests {
    private let sold = Date(timeIntervalSince1970: 1_800_000_000)

    @Test
    func `counts up from the sale while the delists run, with how many are done`() {
        let text = DelistClock.text(
            startedAt: sold, completedAt: nil, done: 1, total: 3, now: sold.addingTimeInterval(23.7),
        )
        #expect(text == "Sold 23 s ago · 1 of 3 delisted")
    }

    @Test
    func `says how long the delist everywhere took once every listing is done`() {
        let text = DelistClock.text(
            startedAt: sold, completedAt: sold.addingTimeInterval(41.2), done: 3, total: 3,
            now: sold.addingTimeInterval(500),
        )
        #expect(text == "Delisted everywhere in 41 s")
        // A completion time with a listing still open (a stale read) is not "everywhere".
        #expect(
            DelistClock.text(
                startedAt: sold, completedAt: sold.addingTimeInterval(41), done: 2, total: 3,
                now: sold.addingTimeInterval(65),
            ) == "Sold 1 min 5 s ago · 2 of 3 delisted",
        )
    }

    @Test
    func `says nothing when there was nothing to delist`() {
        #expect(DelistClock.text(startedAt: sold, completedAt: sold, done: 0, total: 0, now: sold) == nil)
    }

    @Test
    func `reads durations in seconds, minutes, and hours`() {
        #expect(DelistClock.duration(-3) == "0 s")
        #expect(DelistClock.duration(59.9) == "59 s")
        #expect(DelistClock.duration(120) == "2 min")
        #expect(DelistClock.duration(125) == "2 min 5 s")
        #expect(DelistClock.duration(3900) == "1 h 5 min")
        #expect(DelistClock.duration(7200) == "2 h")
    }
}
