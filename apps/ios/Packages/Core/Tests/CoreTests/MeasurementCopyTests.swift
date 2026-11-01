import Core
import Testing

/// Invented listings only: never a real shop's text.
struct MeasurementCopyTests {
    private static let pitToPit = ItemMeasurement(name: "pit_to_pit", value: 21, unit: .inches)
    private static let length = ItemMeasurement(name: "length", value: 27.5, unit: .inches)

    private static let defaultStyle = """
    Such a cute vintage flannel! Soft cotton with a relaxed fit.

    • Brand: Acme Outfitters
    • Size: Medium
    • Color: Red plaid

    Please review photos for overall condition and normal signs of wear.
    """

    @Test
    func `writes each measurement as a spec line after the description's bullets, with its bullet`() {
        let written = MeasurementCopy.written([Self.pitToPit, Self.length], into: Self.defaultStyle)
        #expect(written == """
        Such a cute vintage flannel! Soft cotton with a relaxed fit.

        • Brand: Acme Outfitters
        • Size: Medium
        • Color: Red plaid
        • Pit to pit: 21"
        • Length: 27.5"

        Please review photos for overall condition and normal signs of wear.
        """)
    }

    @Test
    func `writing again replaces the lines it wrote, and no measurements removes them`() {
        let first = MeasurementCopy.written([Self.pitToPit, Self.length], into: Self.defaultStyle)
        let changed = ItemMeasurement(name: "pit_to_pit", value: 22.25, unit: .inches)
        let second = MeasurementCopy.written([changed], into: first)
        #expect(second.contains("• Pit to pit: 22.25\""))
        #expect(!second.contains("21\""), "the old value is gone")
        #expect(!second.contains("Length:"), "a cleared measurement's line is gone")
        #expect(second.components(separatedBy: "Pit to pit").count == 2, "written once")
        #expect(MeasurementCopy.written([], into: first) == Self.defaultStyle)
    }

    @Test
    func `follows a seller's own bullet, and adds its own lines to a description without bullets`() {
        let dashes = "Great jeans.\n- Brand: Acme\n- Size: 32"
        #expect(MeasurementCopy.written([Self.pitToPit], into: dashes) == dashes + "\n- Pit to pit: 21\"")
        let plain = "Great jeans, barely worn.\n\n"
        #expect(MeasurementCopy
            .written([Self.pitToPit], into: plain) == "Great jeans, barely worn.\n\nPit to pit: 21\"")
        #expect(MeasurementCopy.written([Self.pitToPit], into: "") == "Pit to pit: 21\"")
    }

    @Test
    func `replaces a measurement the seller typed in, and keeps other details that share a word`() {
        let typed = "Nice.\n• Waist: about 30 inches flat\n• Rise: High rise"
        let waist = ItemMeasurement(name: "waist", value: 15, unit: .inches)
        #expect(MeasurementCopy.written([waist], into: typed) == "Nice.\n• Rise: High rise\n• Waist: 15\"")
    }

    @Test
    func `leaves a description without measurements exactly as it is`() {
        let untouched = "  Spacing kept.\n\n\n• Brand: Acme  "
        #expect(MeasurementCopy.written([], into: untouched) == untouched)
    }

    @Test
    func `writes only Depop's copy, in centimeters when measured in them`() {
        let copy = ListingCopy(title: "Flannel", description: "Cozy.", hashtags: ["flannel"])
        let centimeters = ItemMeasurement(name: "pit_to_pit", value: 53, unit: .centimeters)
        let depop = MeasurementCopy.applying([centimeters], to: copy, marketplace: "depop")
        #expect(depop.description == "Cozy.\n\nPit to pit: 53 cm")
        #expect(depop.hashtags == ["flannel"])
        #expect(MeasurementCopy.applying([centimeters], to: copy, marketplace: "ebay") == copy)
    }

    @Test
    func `asks only for the measurements that fit the category`() {
        #expect(MeasurementKind.fitting(category: "clothing/tops/t_shirts") == [.pitToPit, .length])
        #expect(MeasurementKind.fitting(category: "clothing/bottoms/jeans") == [.waist, .inseam, .rise, .length])
        #expect(MeasurementKind.fitting(category: "clothing/bottoms/skirts") == [.waist, .length])
        #expect(MeasurementKind.fitting(category: "clothing/dresses/dresses") == [.pitToPit, .waist, .length])
        #expect(MeasurementKind.fitting(category: "clothing/outerwear") == [.pitToPit, .length])
        #expect(MeasurementKind.fitting(category: "shoes/sneakers").isEmpty)
        #expect(MeasurementKind.fitting(category: "bags/totes").isEmpty)
        #expect(MeasurementKind.fitting(category: "clothing/intimates/bras").isEmpty)
        #expect(MeasurementKind.fitting(category: nil).isEmpty)
    }

    @Test
    func `orders measurements as a buyer reads them for the category, others last`() {
        let waist = ItemMeasurement(name: "waist", value: 15, unit: .inches)
        let other = ItemMeasurement(name: "sleeve", value: 24, unit: .inches)
        let ordered = ItemMeasurement.ordered([Self.length, other, waist], category: "clothing/bottoms/jeans")
        #expect(ordered == [waist, Self.length, other])
        #expect(other.title == "Sleeve")
    }

    @Test
    func `writes numbers without trailing zeros`() {
        #expect(ItemMeasurement.number(21) == "21")
        #expect(ItemMeasurement.number(21.5) == "21.5")
        #expect(ItemMeasurement.number(21.25) == "21.25")
        #expect(ItemMeasurement.number(9.05) == "9.05")
    }
}
