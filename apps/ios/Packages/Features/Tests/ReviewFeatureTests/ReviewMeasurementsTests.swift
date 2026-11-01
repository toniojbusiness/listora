import APIClient
import Core
import Foundation
import ListoraAPI
import Testing
@testable import ReviewFeature

/// Measurements on the review: spoken or typed, saved in the item's `measurements`, and written
/// into the Depop description.
@MainActor
struct ReviewMeasurementsTests {
    let harness = ReviewFlowHarness()

    private static func inches(_ kind: MeasurementKind, _ value: Double) -> ItemMeasurement {
        ItemMeasurement(name: kind.rawValue, value: value, unit: .inches)
    }

    private func changes(_ text: String) -> [VoiceChange] {
        let parse = VoiceCorrectionParser.parse(text)
        #expect(parse.unmatched.isEmpty, "unmatched: \(parse.unmatched)")
        return parse.changes
    }

    // MARK: Spoken

    @Test
    func `hears a measurement by name, in digits or words, with or without its unit`() {
        #expect(changes("pit to pit 21") == [.measurement(Self.inches(.pitToPit, 21))])
        #expect(changes("Pit-to-pit is 21.5 inches") == [.measurement(Self.inches(.pitToPit, 21.5))])
        #expect(changes("p2p twenty two") == [.measurement(Self.inches(.pitToPit, 22))])
        #expect(changes("inseam thirty and a half") == [.measurement(Self.inches(.inseam, 30.5))])
        #expect(changes("rise 11 and a quarter") == [.measurement(Self.inches(.rise, 11.25))])
        #expect(changes("length 27 point 5") == [.measurement(Self.inches(.length, 27.5))])
        #expect(changes("waist 40 cm") == [
            .measurement(ItemMeasurement(name: "waist", value: 40, unit: .centimeters)),
        ])
    }

    @Test
    func `hears several measurements in one breath, alongside other corrections`() {
        #expect(changes("pit to pit 21 length 28") == [
            .measurement(Self.inches(.pitToPit, 21)),
            .measurement(Self.inches(.length, 28)),
        ])
        #expect(changes("size medium, waist 15 and inseam 30, paid $4") == [
            .set(.sizeLabel, .text("M")), .set(.sizeSystem, .text("letter")),
            .measurement(Self.inches(.waist, 15)),
            .measurement(Self.inches(.inseam, 30)),
            .cost(400),
        ])
        #expect(changes("pit to pit 20, no wait, pit to pit 21") == [.measurement(Self.inches(.pitToPit, 21))])
    }

    @Test
    func `leaves a phrase that only mentions a measurement for the text model`() {
        #expect(VoiceCorrectionParser.parse("high rise").changes.isEmpty)
        #expect(VoiceCorrectionParser.parse("length is cropped").unmatched == ["length is cropped"])
        #expect(VoiceCorrectionParser.parse("pit to pit 0").changes.isEmpty, "no garment measures nothing")
    }

    @Test
    func `the chip names the measurement and its value`() {
        let change = VoiceChange.measurement(Self.inches(.pitToPit, 21))
        #expect(change.summary == "Pit to pit: 21\"")
        #expect(change.target == .measurement("pit_to_pit"))
    }

    // MARK: Keypad

    @Test
    func `the keypad types a measurement with up to two decimals`() {
        var entry = MeasurementEntry()
        #expect(entry.value == nil)
        for key: AmountEntry.Key in [.digit(2), .digit(1), .decimalPoint, .digit(2), .digit(5), .digit(9)] {
            entry.press(key)
        }
        #expect(entry.text == "21.25", "a third decimal is ignored")
        #expect(entry.value == 21.25)
        var whole = MeasurementEntry()
        for key: AmountEntry.Key in [.digit(1), .digit(2), .digit(3), .digit(4), .decimalPoint] {
            whole.press(key)
        }
        #expect(whole.text == "123.", "three whole digits at most")
        #expect(whole.value == 123)
        var zero = MeasurementEntry()
        zero.press(.digit(0))
        #expect(zero.value == nil, "zero is no measurement")
        #expect(MeasurementEntry(value: 27.5).text == "27.5")
    }

    // MARK: The review

    @Test
    func `shows only the measurements that fit the category, and any the item already has`() {
        var form = ReviewForm(item: Fixtures.appliedItem(), result: Fixtures.result())
        #expect(form.measurementRows.map(\.kind) == [.pitToPit, .length], "a shirt")
        form.setMeasurement(named: "inseam", to: Self.inches(.inseam, 30))
        form.set(.category, to: .text("bags/totes"))
        #expect(form.measurementRows.map(\.kind) == [.inseam], "a value is never hidden")
        form.setMeasurement(named: "inseam", to: nil)
        #expect(form.measurementRows.isEmpty)
        #expect(form.details.measurements == nil, "no measurements left removes the detail")
    }

    @Test
    func `a typed measurement is saved with Continue and written into the Depop description only`() async throws {
        await harness.scriptHappyPath()
        let model = harness.model()
        await model.start()
        model.setMeasurement(.pitToPit, to: 21)
        model.setMeasurement(.length, to: 28.5)

        let depop = try #require(model.copies.first { $0.marketplace == "depop" })
        #expect(depop.current.description == "Cozy flannel.\n\nPit to pit: 21\"\nLength: 28.5\"")
        #expect(depop.edited == nil, "the measurements are part of Listora's copy, not an edit")
        #expect(model.copies.first { $0.marketplace == "ebay" }?.current.description == "Soft flannel.")

        await model.continueToCost()
        let replacements = await harness.service.replacements
        let saved = try #require(replacements.first?.details.measurements)
        #expect(saved == [
            .init(name: "length", value: 28.5, unit: ._in),
            .init(name: "pit_to_pit", value: 21, unit: ._in),
        ])
        #expect(model.form?.measurementRows.compactMap(\.measurement?.value) == [21, 28.5], "kept after the save")
    }

    @Test
    func `changing or removing a measurement rewrites the seller's own Depop copy`() async {
        await harness.scriptHappyPath()
        let model = harness.model()
        await model.start()
        model.saveCopy(ListingCopy(title: "Red plaid flannel", description: "My words.", hashtags: []), for: "depop")
        model.setMeasurement(.pitToPit, to: 21)
        #expect(model.copies.first { $0.marketplace == "depop" }?.current
            .description == "My words.\n\nPit to pit: 21\"")
        model.setMeasurement(.pitToPit, to: 22)
        #expect(model.copies.first { $0.marketplace == "depop" }?.current
            .description == "My words.\n\nPit to pit: 22\"")
        model.setMeasurement(.pitToPit, to: nil)
        #expect(model.copies.first { $0.marketplace == "depop" }?.current.description == "My words.")
    }

    @Test
    func `a spoken measurement applies as the seller's edit and undoes`() async {
        await harness.scriptHappyPath()
        let model = harness.model()
        await model.start()
        let change = VoiceChange.measurement(Self.inches(.pitToPit, 21))
        #expect(!model.isAlreadySet(change))
        let undo = model.apply(change)
        #expect(model.isAlreadySet(change))
        #expect(model.form?.hasEdits == true)
        #expect(model.copies.first { $0.marketplace == "depop" }?.current.description
            .contains("Pit to pit: 21\"") == true)
        model.undo(undo)
        #expect(model.form?.details.measurements == nil)
        #expect(model.copies.first { $0.marketplace == "depop" }?.current.description == "Cozy flannel.")
    }

    @Test
    func `a failed save keeps the measurement on the review to try again`() async {
        await harness.scriptHappyPath()
        await harness.service.setReplaceAnswers([.failure(.server(503, "unavailable", "Try again.", retryable: true))])
        let model = harness.model()
        await model.start()
        model.setMeasurement(.waist, to: 15)
        await model.continueToCost()
        #expect(!model.showsCost)
        #expect(model.actionError != nil)
        #expect(model.form?.details.measurement(named: "waist")?.value == 15)
        #expect(model.form?.hasEdits == true)
    }
}
