/// The tag reads of one photo in the API contract's shape: the `ocrLines` and `barcodes` of
/// `PhotoCreate` (`packages/api-contract/openapi.yaml`). Encoding it gives exactly those two JSON
/// fields.
///
/// The contract carries text and confidence only, so bounding boxes and the pass stay on the
/// device. Values are fitted to the contract's limits so the server never rejects the photo for
/// its tag reads: a line is cut at whole Unicode scalars to 500 UTF-16 code units, at most 500
/// lines and 50 barcodes are kept, and a barcode whose payload is longer than 2,048 UTF-16 code
/// units is left out, because a cut payload would be a wrong code. Lengths are measured in UTF-16
/// code units because the server counts either those or code points, and a string never has
/// fewer UTF-16 code units than code points.
public struct PhotoTagReadUpload: Equatable, Sendable, Codable {
    public enum Limit {
        public static let lines = 500
        public static let lineLength = 500
        public static let barcodes = 50
        public static let payloadLength = 2048
    }

    /// `OcrLine` in the contract.
    public struct OcrLine: Equatable, Sendable, Codable {
        public let text: String
        public let confidence: Double

        public init(text: String, confidence: Double) {
            self.text = text
            self.confidence = confidence
        }
    }

    /// `Barcode` in the contract.
    public struct Barcode: Equatable, Sendable, Codable {
        public let symbology: String
        public let payload: String

        public init(symbology: String, payload: String) {
            self.symbology = symbology
            self.payload = payload
        }
    }

    public let ocrLines: [OcrLine]
    public let barcodes: [Barcode]

    public init(reading: TagReading) {
        ocrLines = reading.lines.prefix(Limit.lines).map { line in
            OcrLine(
                text: Self.cut(line.text, toUTF16Length: Limit.lineLength),
                confidence: min(max(line.confidence, 0), 1),
            )
        }
        barcodes = reading.barcodes
            .filter { $0.payload.utf16.count <= Limit.payloadLength }
            .prefix(Limit.barcodes)
            .map { Barcode(symbology: $0.symbology.rawValue, payload: $0.payload) }
    }

    private static func cut(_ text: String, toUTF16Length limit: Int) -> String {
        guard text.utf16.count > limit else { return text }
        var length = 0
        var scalars = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            length += scalar.utf16.count
            guard length <= limit else { break }
            scalars.append(scalar)
        }
        return String(scalars)
    }
}
