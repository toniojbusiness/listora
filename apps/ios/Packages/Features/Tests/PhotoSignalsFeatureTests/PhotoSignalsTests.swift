import Core
import Foundation
import Testing
@testable import PhotoSignalsFeature

/// One synthetic haul from `Fixtures/manifest.json` (rendered by `make ios-batch-fixtures`).
struct FixtureSequence: Decodable, CustomTestStringConvertible {
    let sequence: String
    let purpose: String
    let files: [String]
    /// The item each file belongs to, 0 first: the grouping the seller would confirm.
    let items: [Int]

    var testDescription: String {
        sequence
    }

    static let all: [FixtureSequence] = {
        guard let url = Bundle.module.url(forResource: "Fixtures/manifest", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let sequences = try? JSONDecoder().decode([FixtureSequence].self, from: data)
        else { return [] }
        return sequences
    }()

    static func named(_ name: String) throws -> FixtureSequence {
        try #require(all.first { $0.sequence == name }, "no fixture sequence \(name)")
    }

    func data(_ file: String) throws -> Data {
        let url = try #require(Bundle.module.url(forResource: "Fixtures/\(sequence)/\(file)", withExtension: nil))
        return try Data(contentsOf: url)
    }

    /// The grouping the seller would confirm, as file indexes per item.
    var expectedGroups: [[Int]] {
        Dictionary(grouping: items.indices) { items[$0] }.sorted { $0.key < $1.key }.map(\.value)
    }
}

/// The reader on the fixture hauls' photos, and batch grouping on the signals it reads, photo by
/// photo as the capture reads them (docs/features/batch.md). The simulator computes no feature
/// prints, so the grouping of live prints runs on a device; `BatchFixtureGroupingTests` (CoreTests)
/// groups the same hauls' prints recorded on a Mac, anywhere.
@Suite(.timeLimit(.minutes(3)))
struct PhotoSignalsTests {
    private let reader = VisionPhotoSignalReader()

    /// The haul as shot: `withinItem` seconds between an item's photos, `betweenItems` before the
    /// next item's first photo (laying it out).
    private func shots(
        _ sequence: FixtureSequence,
        withinItem: TimeInterval = 4,
        betweenItems: TimeInterval = 9,
    ) async throws -> [BatchShot] {
        var time = Date(timeIntervalSinceReferenceDate: 800_000_000)
        var shots: [BatchShot] = []
        for (index, file) in sequence.files.enumerated() {
            if index > 0 {
                time += sequence.items[index] == sequence.items[index - 1] ? withinItem : betweenItems
            }
            let signals = try await reader.signals(of: sequence.data(file))
            shots.append(BatchShot(id: String(index), capturedAt: time, signals: signals, startsNewItem: false))
        }
        return shots
    }

    private func groups(_ stacks: [ProposedStack]) -> [[Int]] {
        stacks.map { $0.shotIDs.compactMap { Int($0) } }
    }

    @Test
    func `reads tag close-ups as tags and garments as not`() async throws {
        for sequence in FixtureSequence.all {
            for file in sequence.files {
                let signals = try await reader.signals(of: sequence.data(file))
                #expect(signals.looksLikeTag == file.contains("-tag"), "\(sequence.sequence)/\(file)")
                if VisionPhotoSignalReader.readsFeaturePrints {
                    let print = try #require(signals.featurePrint, "\(file) has no feature print")
                    #expect(print.count > 100)
                } else {
                    #expect(signals.featurePrint == nil, "the simulator's prints are not to be trusted")
                }
            }
        }
    }

    @Test(.enabled(if: VisionPhotoSignalReader.readsFeaturePrints, "the simulator computes no feature prints"))
    func `reads the same photo the same way`() async throws {
        let haul = try FixtureSequence.named("haul")
        let first = try await reader.signals(of: haul.data(haul.files[0]))
        let again = try await reader.signals(of: haul.data(haul.files[0]))
        #expect(try #require(ShotSignals.distance(first.featurePrint, again.featurePrint)) < 0.01)
    }

    @Test(
        .enabled(if: VisionPhotoSignalReader.readsFeaturePrints, "the simulator computes no feature prints"),
        arguments: ["haul", "no-tags"],
    )
    func `groups each item of a haul on its own`(_ name: String) async throws {
        let sequence = try FixtureSequence.named(name)
        // Shot at a seller's pace, and as fast as the fake camera's taps.
        for (withinItem, betweenItems) in [(4.0, 9.0), (1.0, 1.0)] {
            let stacks = try await BatchGrouper.group(shots(
                sequence,
                withinItem: withinItem,
                betweenItems: betweenItems,
            ))
            #expect(groups(stacks) == sequence.expectedGroups, "\(name) at \(withinItem) s and \(betweenItems) s")
            #expect(stacks.allSatisfy { !$0.startNeedsReview && $0.uncertainShotIDs.isEmpty }, "\(name)")
        }
    }

    /// The navy tees look as alike as one item's front and back: whatever the grouper decides, the
    /// boundary between them is never merged without asking the seller.
    @Test
    func `never quietly merges look-alike items, with or without feature prints`() async throws {
        let sequence = try FixtureSequence.named("look-alikes")
        let boundaries = sequence.items.indices.dropFirst().filter { sequence.items[$0] != sequence.items[$0 - 1] }
        #expect(!boundaries.isEmpty)
        for (withinItem, betweenItems) in [(4.0, 9.0), (1.0, 1.0)] {
            let stacks = try await BatchGrouper.group(shots(
                sequence,
                withinItem: withinItem,
                betweenItems: betweenItems,
            ))
            for boundary in boundaries {
                let id = String(boundary)
                let split = stacks.first { $0.shotIDs.first == id }
                let flagged = stacks.contains { $0.uncertainShotIDs.contains(id) }
                #expect(split != nil || flagged, "the look-alike starting at photo \(boundary) was merged quietly")
            }
        }
    }

    @Test
    func `scales tag likelihood with the text on the photo`() {
        #expect(VisionPhotoSignalReader.tagLikelihood(characters: 0) == 0)
        #expect(VisionPhotoSignalReader.tagLikelihood(characters: VisionPhotoSignalReader.fewCharacters) == 0)
        #expect(VisionPhotoSignalReader.tagLikelihood(characters: 26) == 0.5)
        #expect(VisionPhotoSignalReader.tagLikelihood(characters: 200) == 1)
    }

    @Test
    func `refuses data that is not an image`() async {
        await #expect(throws: PhotoSignalsError.unreadableImage) {
            try await reader.signals(of: Data("not a photo".utf8))
        }
    }
}
