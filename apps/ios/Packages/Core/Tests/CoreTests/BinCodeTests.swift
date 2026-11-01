import Core
import Testing

struct BinCodeTests {
    @Test
    func `a bin sticker holds its code apart from item stickers`() {
        #expect(BinCode.stickerPayload(" b-12 ") == "LISTORA-BIN:B-12")
        #expect(BinCode.scanned("LISTORA-BIN:B-12") == "B-12")
        #expect(BinCode.scanned("listora-bin:shelf  3") == "SHELF 3")
        #expect(BinCode.scanned("LISTORA:AJ-000184") == nil)
        #expect(BinCode.scanned("LISTORA-BIN:") == nil)
    }

    @Test
    func `a typed code reads as a bin, a shipping label or odd text does not`() {
        #expect(BinCode.scanned(" b-7 ") == "B-7")
        #expect(BinCode.scanned("9400111899223100012345") == "9400111899223100012345")
        #expect(BinCode.scanned("https://example.com/x?y") == nil)
        #expect(BinCode.scanned("--") == nil)
        #expect(BinCode.scanned(String(repeating: "B", count: 33)) == nil)
    }

    @Test
    func `find it names the bin, or each of an order's bins once`() {
        #expect(BinCode.findIt(["B-12"]) == "Find it: bin B-12")
        #expect(BinCode.findIt([nil]) == nil)
        #expect(BinCode.findIt(["B-12", "B-12"]) == "Find them: bin B-12")
        #expect(BinCode.findIt(["B-3", nil, "B-12", "B-3"]) == "Find them: bins B-3, B-12")
    }
}
