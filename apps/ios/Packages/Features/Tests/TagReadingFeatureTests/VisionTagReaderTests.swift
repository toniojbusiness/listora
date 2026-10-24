import Core
import Foundation
import Synchronization
import Testing
@testable import TagReadingFeature

/// Runs the real Vision reader on the synthetic tag photos in the simulator.
struct VisionTagReaderFixtureTests {
    @Test
    func `the fixture manifest lists every photo`() {
        #expect(Fixture.all.count == 11)
    }

    @Test(arguments: Fixture.all)
    func `reads the expected text and barcodes`(fixture: Fixture) async throws {
        let reading = try await VisionTagReader().read(imageData: fixture.data())
        let texts = reading.lines.map(\.text)
        for line in fixture.lines {
            #expect(texts.contains(line), "missing line \"\(line)\" in \(texts)")
        }
        for tab in fixture.sizeTabs {
            #expect(texts.contains(tab), "missing size tab \"\(tab)\" in \(texts)")
        }
        let barcodes = reading.barcodes.map { Fixture.Barcode(symbology: $0.symbology.rawValue, payload: $0.payload) }
        #expect(barcodes == fixture.barcodes)
        for line in reading.lines {
            #expect((0 ... 1).contains(line.confidence))
            #expect(line.boundingBox.minX >= -0.01 && line.boundingBox.maxX <= 1.01)
            #expect(line.boundingBox.minY >= -0.01 && line.boundingBox.maxY <= 1.01)
        }
    }

    @Test(arguments: Fixture.all.filter { !$0.sizeTabs.isEmpty })
    func `size tabs come from the size-tab pass because the whole-photo pass skips them`(
        fixture: Fixture,
    ) async throws {
        var withoutPass = VisionTagReader()
        withoutPass.runsSizeTabPass = false
        let fullImageOnly = try await withoutPass.read(imageData: fixture.data()).lines.map(\.text)
        // If Vision ever reads these tabs on its own, the fixture no longer exercises the pass:
        // make its tab smaller in the generator.
        for tab in fixture.sizeTabs {
            #expect(!fullImageOnly.contains(tab), "the whole-photo pass read \"\(tab)\"; shrink the fixture's tab")
        }

        let reading = try await VisionTagReader().read(imageData: fixture.data())
        let tabs = reading.lines.filter { $0.pass == .sizeTab }
        #expect(tabs.map(\.text) == fixture.sizeTabs)
        // Lines the whole-photo pass read are not read again from the tiles.
        #expect(reading.lines.filter { $0.pass == .fullImage }.map(\.text) == fullImageOnly)
    }

    @Test
    func `folds Cyrillic look-alikes Vision returns for Latin capitals`() async throws {
        let reading = try await VisionTagReader().read(imageData: Fixture.named("care-label").data())
        let brand = try #require(reading.lines.first { $0.text.hasSuffix("OUTFITTERS") })
        #expect(brand.text == "ACME OUTFITTERS")
        let isASCII = brand.text.unicodeScalars.allSatisfy(\.isASCII)
        #expect(isASCII)
    }

    @Test
    func `applies the EXIF orientation so boxes match the upright photo`() async throws {
        let upright = try await VisionTagReader().read(imageData: Fixture.named("care-label").data())
        let sideways = try await VisionTagReader().read(imageData: Fixture.named("care-label-exif-right").data())
        #expect(sideways.lines.map(\.text) == upright.lines.map(\.text))
        let brand = try #require(sideways.lines.first { $0.text == "ACME OUTFITTERS" })
        let care = try #require(sideways.lines.first { $0.text == "MACHINE WASH COLD" })
        // The brand is printed at the top and starts at the left edge of the upright label.
        #expect(brand.boundingBox.minY < 0.25)
        #expect(brand.boundingBox.minX < 0.15)
        #expect(brand.boundingBox.maxY < care.boundingBox.minY)
    }

    @Test
    func `a photo without text or barcodes reads as empty`() async throws {
        let reading = try await VisionTagReader().read(imageData: Fixture.named("blank-fabric").data())
        #expect(reading.lines.isEmpty)
        #expect(reading.barcodes.isEmpty)
        #expect(reading.upload == PhotoTagReadUpload(reading: reading))
        #expect(reading.upload.ocrLines.isEmpty && reading.upload.barcodes.isEmpty)
    }

    @Test
    func `measures every pass`() async throws {
        let reading = try await VisionTagReader().read(imageData: Fixture.named("neck-label-size-tab-m").data())
        let timing = reading.timing
        for pass in [timing.decode, timing.textRecognition, timing.barcodeDetection, timing.sizeTabPass] {
            #expect(pass > .zero)
            #expect(pass <= timing.total)
        }
        #expect(timing.decode + timing.sizeTabPass <= timing.total)
    }

    @Test
    func `skipping the size-tab pass records no time for it`() async throws {
        var reader = VisionTagReader()
        reader.runsSizeTabPass = false
        let reading = try await reader.read(imageData: Fixture.named("hang-tag-ean-8").data())
        #expect(reading.timing.sizeTabPass == .zero)
        #expect(reading.lines.allSatisfy { $0.pass == .fullImage })
    }
}

struct VisionTagReaderFailureTests {
    @Test(arguments: [Data(), Data("not an image".utf8), Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00])])
    func `data that is not an image fails as unreadable`(data: Data) async {
        await #expect(throws: TagReadingError.unreadableImage) {
            try await VisionTagReader().read(imageData: data)
        }
    }

    @Test
    func `a task cancelled before reading throws without reading`() async throws {
        let data = try Fixture.named("care-label").data()
        let stages = Mutex<[VisionTagReader.Stage]>([])
        var reader = VisionTagReader()
        reader.onStage = { stage in stages.withLock { $0.append(stage) } }
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await reader.read(imageData: data)
        }
        await #expect(throws: CancellationError.self) { try await task.value }
        #expect(stages.withLock { $0 }.isEmpty)
    }

    @Test
    func `cancelling during a read stops before the next pass`() async throws {
        let data = try Fixture.named("neck-label-size-tab-m").data()
        let stages = Mutex<[VisionTagReader.Stage]>([])
        let task = Mutex<Task<TagReading, any Error>?>(nil)
        var reader = VisionTagReader()
        reader.onStage = { stage in
            stages.withLock { $0.append(stage) }
            if stage == .fullImagePassesFinished {
                task.withLock { $0?.cancel() }
            }
        }
        // Created under the lock, so the stage callback waits until the task is stored.
        let started = task.withLock { [reader] stored in
            let started = Task { [reader] in try await reader.read(imageData: data) }
            stored = started
            return started
        }
        await #expect(throws: CancellationError.self) { try await started.value }
        #expect(stages.withLock { $0 } == [.decoded, .fullImagePassesFinished])
    }

    @Test
    @MainActor
    func `reading from the main actor runs off the main thread`() async throws {
        // `read` asserts it is off the main queue; reaching the result proves it.
        let reading = try await VisionTagReader().read(imageData: Fixture.named("hang-tag-qr").data())
        #expect(reading.barcodes.map(\.symbology) == [.qr])
    }
}
