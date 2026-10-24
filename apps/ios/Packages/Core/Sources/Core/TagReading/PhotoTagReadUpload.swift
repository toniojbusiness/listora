/// The tag reads of one photo in the API contract's shape: the `ocrLines` and `barcodes` of
/// `PhotoCreate` (`packages/api-contract/openapi.yaml`). Encoding it gives exactly those two JSON
/// fields.
///
/// The contract carries text and confidence only, so bounding boxes and the pass stay on the
/// device. Values are fitted to the contract's limits so the server never rejects the photo for
/// its tag reads: a line is cut to 500 characters, at most 500 lines and 50 barcodes are kept,
/// and a barcode whose payload is longer than 2,048 characters is left out, because a cut
/// payload would be a wrong code.
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
            OcrLine(text: String(line.text.prefix(Limit.lineLength)), confidence: min(max(line.confidence, 0), 1))
        }
        barcodes = reading.barcodes
            .filter { $0.payload.count <= Limit.payloadLength }
            .prefix(Limit.barcodes)
            .map { Barcode(symbology: $0.symbology.rawValue, payload: $0.payload) }
    }
}
