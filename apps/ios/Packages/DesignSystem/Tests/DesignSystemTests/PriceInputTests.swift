import Foundation
import Testing
@testable import DesignSystem

struct PriceInputTests {
    @Test(arguments: [
        ("", ""),
        ("48", "48"),
        ("48.5", "48.5"),
        ("48.50", "48.50"),
        ("48.505", "48.50"),
        ("$1,200.00", "1200.00"),
        ("007", "7"),
        (".99", "0.99"),
        ("1.2.3", "1.23"),
        ("12a3", "123"),
        ("12345678", "1234567"),
        ("١٢", ""),
    ])
    func `keeps only a valid price as the seller types`(raw: String, cleaned: String) {
        #expect(PriceInput(raw, decimalSeparator: ".").text == cleaned)
    }

    @Test
    func `accepts the locale's decimal comma`() {
        let input = PriceInput("12,5", decimalSeparator: ",")
        #expect(input.text == "12.5")
        #expect(input.minorUnits == 1250)
    }

    @Test
    func `the amount is exact in minor units`() {
        #expect(PriceInput("0.10").minorUnits == 10)
        #expect(PriceInput("19.99").minorUnits == 1999)
        #expect(PriceInput("1234567.89").minorUnits == 123_456_789)
        #expect(PriceInput("48.").minorUnits == 4800)
        #expect(PriceInput("").minorUnits == nil)
        #expect(PriceInput("").amount == nil)
    }

    @Test
    func `the field shows stored minor units without trailing zero cents`() {
        #expect(PriceField.text(forMinorUnits: 4800) == "48")
        #expect(PriceField.text(forMinorUnits: 4850) == "48.50")
        #expect(PriceField.text(forMinorUnits: 5) == "0.05")
    }
}
