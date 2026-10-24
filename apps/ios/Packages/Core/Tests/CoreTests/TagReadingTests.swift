import Core
import Foundation
import Testing

struct PhotoTagReadUploadTests {
    @Test
    func `encodes exactly the contract's ocrLines and barcodes fields`() throws {
        let reading = TagReading(
            lines: [line("RN 12345", 1), line("M", 0.5, pass: .sizeTab)],
            barcodes: [barcode(.ean13, "0036000291452")],
            timing: timing,
        )
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(reading.upload)) as? [String: Any]
        let object = try #require(json)
        #expect(Set(object.keys) == ["ocrLines", "barcodes"])
        let lines = try #require(object["ocrLines"] as? [[String: Any]])
        #expect(lines.map { Set($0.keys) } == [["text", "confidence"], ["text", "confidence"]])
        #expect(lines.map { $0["text"] as? String } == ["RN 12345", "M"])
        #expect(lines.map { $0["confidence"] as? Double } == [1, 0.5])
        let barcodes = try #require(object["barcodes"] as? [[String: String]])
        #expect(barcodes == [["symbology": "ean13", "payload": "0036000291452"]])
    }

    @Test
    func `symbology names are the contract's`() {
        #expect(TagBarcode.Symbology.allCases.map(\.rawValue) == ["ean13", "ean8", "upce", "code128", "qr"])
    }

    @Test
    func `fits the reads to the contract's limits`() {
        let long = String(repeating: "A", count: 600)
        let reading = TagReading(
            lines: [line(long, 1)] + (0 ..< 600).map { line("L\($0)", 2) },
            barcodes: [barcode(.qr, String(repeating: "x", count: 2049))]
                + (0 ..< 60).map { barcode(.code128, "C\($0)") },
            timing: timing,
        )
        let upload = reading.upload
        #expect(upload.ocrLines.count == PhotoTagReadUpload.Limit.lines)
        #expect(upload.ocrLines[0].text.count == PhotoTagReadUpload.Limit.lineLength)
        #expect(upload.ocrLines.allSatisfy { (0 ... 1).contains($0.confidence) })
        // An over-long payload is left out, never cut into a different code.
        #expect(upload.barcodes.count == PhotoTagReadUpload.Limit.barcodes)
        #expect(upload.barcodes.first?.payload == "C0")
    }

    @Test
    func `measures the limits in UTF-16 code units`() {
        let crlfPayload = String(repeating: "x", count: 2028) + String(repeating: "\r\n", count: 20)
        let fittingPayload = String(repeating: "x", count: 2046) + "\r\n"
        let emojiPayload = String(repeating: "x", count: 2047) + "😀"
        let reading = TagReading(
            lines: [
                line(String(repeating: "A", count: 499) + "😀", 1),
                line(String(repeating: "😀", count: 300), 1),
                line(String(repeating: "e\u{301}", count: 300), 1),
                line(String(repeating: "\r\n", count: 300), 1),
            ],
            barcodes: [barcode(.qr, crlfPayload), barcode(.qr, emojiPayload), barcode(.qr, fittingPayload)],
            timing: timing,
        )
        #expect(crlfPayload.count == 2048 && crlfPayload.utf16.count == 2068)
        let upload = reading.upload
        let texts = upload.ocrLines.map(\.text)
        #expect(texts[0] == String(repeating: "A", count: 499))
        #expect(texts[1] == String(repeating: "😀", count: 250))
        #expect(texts[2] == String(repeating: "e\u{301}", count: 250))
        #expect(texts[3] == String(repeating: "\r\n", count: 250))
        #expect(texts.allSatisfy { $0.utf16.count <= PhotoTagReadUpload.Limit.lineLength })
        #expect(upload.barcodes.map(\.payload) == [fittingPayload])
    }

    @Test
    func `a reading survives a round trip through JSON for the draft store`() throws {
        let reading = TagReading(lines: [line("CA 54321", 0.9)], barcodes: [barcode(.ean8, "96385074")], timing: timing)
        let decoded = try JSONDecoder().decode(TagReading.self, from: JSONEncoder().encode(reading))
        #expect(decoded == reading)
    }

    private let timing = TagReadingTiming(
        decode: .milliseconds(5), textRecognition: .milliseconds(200), barcodeDetection: .milliseconds(50),
        sizeTabPass: .milliseconds(400), total: .milliseconds(610),
    )

    private func line(_ text: String, _ confidence: Double, pass: TagReadingPass = .fullImage) -> TagTextLine {
        TagTextLine(text: text, confidence: confidence, boundingBox: box, pass: pass)
    }

    private func barcode(_ symbology: TagBarcode.Symbology, _ payload: String) -> TagBarcode {
        TagBarcode(symbology: symbology, payload: payload, boundingBox: box)
    }

    private let box = PhotoRect(x: 0.1, y: 0.2, width: 0.3, height: 0.05)
}

struct PhotoRectTests {
    @Test
    func `intersects overlapping rectangles and nothing else`() throws {
        let quarter = PhotoRect(x: 0, y: 0, width: 0.5, height: 0.5)
        let overlap = try #require(quarter.intersection(PhotoRect(x: 0.25, y: 0.25, width: 0.5, height: 0.5)))
        #expect(overlap == PhotoRect(x: 0.25, y: 0.25, width: 0.25, height: 0.25))
        #expect(quarter.intersection(PhotoRect(x: 0.5, y: 0, width: 0.5, height: 0.5)) == nil)
        #expect(quarter.intersection(PhotoRect(x: 0.6, y: 0.6, width: 0.1, height: 0.1)) == nil)
    }
}
