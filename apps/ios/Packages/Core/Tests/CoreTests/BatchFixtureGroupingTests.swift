import Foundation
import Testing
@testable import Core

/// One synthetic haul with the Vision signals recorded for its photos on a Mac
/// (`Fixtures/batch-signals.json`, `make ios-batch-fixtures`), so the grouping of real feature
/// prints is tested anywhere, the simulator included, which cannot compute them.
struct RecordedHaul: Decodable, CustomTestStringConvertible {
    struct Shot: Decodable {
        let file: String
        let featurePrint: String
        let tagLikelihood: Double
    }

    let sequence: String
    let purpose: String
    /// The item each photo belongs to, 0 first: the grouping a seller would confirm.
    let items: [Int]
    let shots: [Shot]

    var testDescription: String {
        sequence
    }

    static let all: [RecordedHaul] = {
        guard let url = Bundle.module.url(forResource: "Fixtures/batch-signals", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let hauls = try? JSONDecoder().decode([RecordedHaul].self, from: data)
        else { return [] }
        return hauls
    }()

    static func named(_ name: String) throws -> RecordedHaul {
        try #require(all.first { $0.sequence == name }, "no recorded haul \(name)")
    }

    /// The haul as shot: `withinItem` seconds between an item's photos, `betweenItems` before the
    /// next item's first photo.
    func shots(withinItem: TimeInterval = 4, betweenItems: TimeInterval = 9) -> [BatchShot] {
        var time = Date(timeIntervalSinceReferenceDate: 800_000_000)
        return shots.enumerated().map { index, shot in
            if index > 0 {
                time += items[index] == items[index - 1] ? withinItem : betweenItems
            }
            let bytes = Data(base64Encoded: shot.featurePrint) ?? Data()
            let print = bytes.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
            return BatchShot(
                id: String(index),
                capturedAt: time,
                signals: ShotSignals(featurePrint: print, tagLikelihood: shot.tagLikelihood),
                startsNewItem: false,
            )
        }
    }

    var expectedGroups: [[String]] {
        Dictionary(grouping: items.indices) { items[$0] }.sorted { $0.key < $1.key }.map { $0.value.map(String.init) }
    }

    /// Indexes of the photos that start a new item.
    var boundaries: [Int] {
        items.indices.dropFirst().filter { items[$0] != items[$0 - 1] }
    }
}

struct BatchFixtureGroupingTests {
    @Test
    func `every fixture haul has its recorded signals`() {
        #expect(RecordedHaul.all.map(\.sequence) == ["haul", "no-tags", "look-alikes"])
        for haul in RecordedHaul.all {
            #expect(haul.shots.count == haul.items.count)
            #expect(haul.shots(withinItem: 1, betweenItems: 1).allSatisfy { $0.signals?.featurePrint?.count == 768 })
        }
    }

    @Test(arguments: ["haul", "no-tags"])
    func `groups each item of a fixture haul on its own, at a seller's pace and at the fake camera's`(
        _ name: String,
    ) throws {
        let haul = try RecordedHaul.named(name)
        for (withinItem, betweenItems) in [(4.0, 9.0), (1.0, 1.0)] {
            let stacks = BatchGrouper.group(haul.shots(withinItem: withinItem, betweenItems: betweenItems))
            #expect(stacks.map(\.shotIDs) == haul.expectedGroups, "\(name) at \(withinItem) s, \(betweenItems) s")
            #expect(stacks.allSatisfy { !$0.startNeedsReview && $0.uncertainShotIDs.isEmpty }, "\(name)")
        }
    }

    /// The navy tees look as alike as one item's front and back: whatever the grouper decides, the
    /// boundary between them is never merged without asking the seller.
    @Test
    func `never quietly merges the look-alike items of a fixture haul`() throws {
        let haul = try RecordedHaul.named("look-alikes")
        #expect(!haul.boundaries.isEmpty)
        for (withinItem, betweenItems) in [(4.0, 9.0), (1.0, 1.0)] {
            let stacks = BatchGrouper.group(haul.shots(withinItem: withinItem, betweenItems: betweenItems))
            for boundary in haul.boundaries {
                let id = String(boundary)
                let split = stacks.contains { $0.shotIDs.first == id }
                let flagged = stacks.contains { $0.uncertainShotIDs.contains(id) }
                #expect(split || flagged, "the look-alike starting at photo \(boundary) was merged quietly")
            }
        }
    }

    @Test
    func `reads the tag close-ups of the fixture hauls as tags`() {
        for haul in RecordedHaul.all {
            for shot in haul.shots {
                let signals = ShotSignals(featurePrint: nil, tagLikelihood: shot.tagLikelihood)
                #expect(signals.looksLikeTag == shot.file.contains("-tag"), "\(haul.sequence)/\(shot.file)")
            }
        }
    }
}
