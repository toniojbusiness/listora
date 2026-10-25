import Foundation
import Testing
@testable import Core

/// The grouping rules on hand-made signal sequences; `PhotoSignalsFeatureTests` runs them on the
/// fixture hauls' real Vision signals.
struct BatchGroupingTests {
    private let start = Date(timeIntervalSinceReferenceDate: 800_000_000)

    /// A garment photo whose feature print is at (`x`, `y`): distances are plain geometry.
    private func garment(_ x: Double, _ y: Double = 0) -> ShotSignals {
        ShotSignals(featurePrint: [Float(x), Float(y), 0], tagLikelihood: 0)
    }

    private let tag = ShotSignals(featurePrint: [9, 9, 9], tagLikelihood: 1)

    /// Shots at `seconds` after the start, with ids "0", "1", ...
    private func shots(
        _ signals: [ShotSignals?],
        seconds: [TimeInterval]? = nil,
        manual: Set<Int> = [],
    ) -> [BatchShot] {
        signals.enumerated().map { index, signals in
            BatchShot(
                id: String(index),
                capturedAt: start.addingTimeInterval(seconds?[index] ?? Double(index) * 5),
                signals: signals,
                startsNewItem: manual.contains(index),
            )
        }
    }

    private func groups(_ stacks: [ProposedStack]) -> [[String]] {
        stacks.map(\.shotIDs)
    }

    @Test
    func `measures the Euclidean distance between prints of one version`() {
        #expect(ShotSignals.distance([0, 3, 0], [4, 0, 0]) == 5)
        #expect(ShotSignals.distance([1, 2], [1, 2, 3]) == nil)
        #expect(ShotSignals.distance(nil, [1]) == nil)
        #expect(ShotSignals.distance([], []) == nil)
    }

    @Test
    func `groups the front, back, and tag of each item`() {
        // Item A at the origin, item B far from it.
        let stacks = BatchGrouper.group(shots([
            garment(0), garment(0.2), tag,
            garment(1.4), garment(1.5), tag,
        ]))
        #expect(groups(stacks) == [["0", "1", "2"], ["3", "4", "5"]])
        #expect(stacks.allSatisfy { !$0.startNeedsReview && $0.uncertainShotIDs.isEmpty })
    }

    @Test
    func `keeps a tag with its item however different it looks`() {
        let decisions = BatchGrouper.decisions(for: shots([garment(0), garment(0.1), tag]))
        #expect(decisions[2] == BoundaryDecision(startsNewItem: false, confidence: 1, reasons: [.tag]))
    }

    @Test
    func `starts an item where the seller tapped Next item`() {
        // The same-looking photo after Next item is a new item all the same.
        let stacks = BatchGrouper.group(shots([garment(0), garment(0.05), garment(0.05)], manual: [2]))
        #expect(groups(stacks) == [["0", "1"], ["2"]])
        #expect(BatchGrouper.decisions(for: shots([garment(0), garment(0)], manual: [1]))[1].reasons == [.manual])
    }

    @Test
    func `splits items without tags by how they look`() {
        let stacks = BatchGrouper.group(shots([
            garment(0), garment(0.2), garment(1.2), garment(1.3), garment(2.4), garment(2.45),
        ]))
        #expect(groups(stacks) == [["0", "1"], ["2", "3"], ["4", "5"]])
    }

    @Test
    func `keeps an item's back with its front even when they differ somewhat`() {
        // A print on the front makes the back look less alike, as a graphic tee does.
        let decisions = BatchGrouper.decisions(for: shots([garment(0), garment(0.58)]))
        #expect(!decisions[1].startsNewItem)
        #expect(!decisions[1].needsReview)
        #expect(decisions[1].reasons == [.looksSimilar, .secondShot])
    }

    @Test
    func `flags a look-alike item instead of merging it quietly`() {
        // A second navy tee: about as far from the first tee's front and back as a graphic tee's
        // front is from its own back.
        let haul = shots([garment(0), garment(0.15), garment(0.075, 0.48)])
        let lookAlike = BatchGrouper.decisions(for: haul)[2]
        #expect(lookAlike.needsReview)
        #expect(lookAlike.reasons.contains(.extraShot))
        let stacks = BatchGrouper.group(haul)
        let flagged = stacks.contains { $0.uncertainShotIDs.contains("2") } ||
            stacks.contains { $0.shotIDs.first == "2" && $0.startNeedsReview }
        #expect(flagged)
    }

    @Test
    func `leans on the photo after a tag and on long pauses`() {
        // Mid-distance: alone it would be a close call.
        let afterTag = BatchGrouper.decisions(for: shots([garment(0), tag, garment(0.62)]))[2]
        #expect(afterTag.startsNewItem)
        #expect(afterTag.reasons.contains(.afterTag))

        let paused = BatchGrouper.decisions(for: shots([garment(0), garment(0.55)], seconds: [0, 30]))[1]
        #expect(paused.startsNewItem)
        #expect(paused.reasons.contains(.timeGap))
        let unhurried = BatchGrouper.decisions(for: shots([garment(0), garment(0.55)], seconds: [0, 8]))[1]
        #expect(!unhurried.startsNewItem)
    }

    @Test
    func `flags a look-alike even when it is shot quickly`() {
        let haul = shots([garment(0), garment(0.15), garment(0.075, 0.48)], seconds: [0, 1, 2])
        #expect(BatchGrouper.decisions(for: haul)[2].needsReview)
    }

    @Test
    func `groups by how the haul was shot, and asks, when there is no feature print`() {
        // As in the simulator: the tag is read, the garments have no print.
        let unseen = ShotSignals(featurePrint: nil, tagLikelihood: 0)
        let haul = shots([unseen, unseen, tag, unseen, unseen, tag])
        let decisions = BatchGrouper.decisions(for: haul)
        #expect(decisions.map(\.startsNewItem) == [true, false, false, true, false, false])
        for index in [1, 3, 4] {
            #expect(decisions[index].needsReview, "photo \(index)")
            #expect(decisions[index].reasons.contains(.noSignals))
        }
        let stacks = BatchGrouper.group(haul)
        #expect(groups(stacks) == [["0", "1", "2"], ["3", "4", "5"]])
        #expect(stacks[1].startNeedsReview)
        #expect(stacks.allSatisfy { !$0.uncertainShotIDs.isEmpty })
        // A photo with no signals at all is unseen too.
        #expect(BatchGrouper.decisions(for: shots([garment(0), nil]))[1].needsReview)
    }

    @Test
    func `keeps the back with its front across a tag shot between them`() {
        let decisions = BatchGrouper.decisions(for: shots([garment(0), tag, garment(0.1)]))
        #expect(!decisions[2].startsNewItem)
        #expect(!decisions[2].needsReview)
    }

    @Test
    func `groups nothing into nothing`() {
        #expect(BatchGrouper.group([]).isEmpty)
        #expect(BatchGrouper.decisions(for: []).isEmpty)
    }
}
