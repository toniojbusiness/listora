import Foundation

/// What on-device tag reading found on one tag or label photo: the raw text lines and barcodes,
/// plus how long each pass took.
///
/// The app reads photos whose role is `tag` (see `PhotoRole` in the API contract) and uploads
/// ``upload`` with the photo, as the `ocrLines` and `barcodes` of `PhotoCreate`. The server parses
/// these raw reads (`@listora/tag-parse`); the device never interprets them.
public struct TagReading: Equatable, Sendable, Codable {
    /// Recognized lines: the whole-photo pass in reading order, then the size-tab pass top to bottom.
    public let lines: [TagTextLine]
    public let barcodes: [TagBarcode]
    public let timing: TagReadingTiming

    public init(lines: [TagTextLine], barcodes: [TagBarcode], timing: TagReadingTiming) {
        self.lines = lines
        self.barcodes = barcodes
        self.timing = timing
    }

    /// The reads in the shape the API contract accepts with a photo.
    public var upload: PhotoTagReadUpload {
        PhotoTagReadUpload(reading: self)
    }
}

/// One recognized line of text.
public struct TagTextLine: Equatable, Sendable, Codable {
    public let text: String
    /// Recognizer confidence in [0, 1].
    public let confidence: Double
    /// Where the line is on the upright photo.
    public let boundingBox: PhotoRect
    public let pass: TagReadingPass

    public init(text: String, confidence: Double, boundingBox: PhotoRect, pass: TagReadingPass) {
        self.text = text
        self.confidence = confidence
        self.boundingBox = boundingBox
        self.pass = pass
    }
}

/// Which recognition pass found a line.
public enum TagReadingPass: String, Sendable, Codable {
    /// Text recognition over the whole photo.
    case fullImage
    /// The dedicated pass for small isolated size tabs ("M", "8", "XS") that the whole-photo
    /// pass skips.
    case sizeTab
}

/// One detected barcode.
public struct TagBarcode: Equatable, Sendable, Codable {
    public let symbology: Symbology
    /// The decoded payload, exactly as the barcode encodes it.
    public let payload: String
    public let boundingBox: PhotoRect

    public init(symbology: Symbology, payload: String, boundingBox: PhotoRect) {
        self.symbology = symbology
        self.payload = payload
        self.boundingBox = boundingBox
    }

    /// The barcode symbologies tag reading detects. Raw values are the API contract's `symbology`
    /// names.
    public enum Symbology: String, Sendable, Codable, CaseIterable {
        /// EAN-13. Vision has no separate UPC-A symbology: a UPC-A arrives as the 13-digit EAN-13 with
        /// a leading 0, which the server reads back as the UPC-A.
        case ean13
        case ean8
        case upce
        case code128
        case qr
    }
}

/// A rectangle in normalized coordinates of the upright photo: the origin is the top-left corner
/// and 1 is the full width or height, so it maps onto any displayed size of the photo.
public struct PhotoRect: Equatable, Sendable, Codable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var minX: Double {
        x
    }

    public var minY: Double {
        y
    }

    public var maxX: Double {
        x + width
    }

    public var maxY: Double {
        y + height
    }

    public var area: Double {
        width * height
    }

    /// The overlapping part of the two rectangles, or nil when they do not overlap.
    public func intersection(_ other: PhotoRect) -> PhotoRect? {
        let left = max(minX, other.minX)
        let top = max(minY, other.minY)
        let right = min(maxX, other.maxX)
        let bottom = min(maxY, other.maxY)
        guard right > left, bottom > top else { return nil }
        return PhotoRect(x: left, y: top, width: right - left, height: bottom - top)
    }
}

/// How long tag reading took. The text and barcode passes run at the same time, so `total` is
/// less than their sum.
public struct TagReadingTiming: Equatable, Sendable, Codable {
    /// Decoding the image file into an upright bitmap.
    public let decode: Duration
    public let textRecognition: Duration
    public let barcodeDetection: Duration
    public let sizeTabPass: Duration
    public let total: Duration

    public init(
        decode: Duration,
        textRecognition: Duration,
        barcodeDetection: Duration,
        sizeTabPass: Duration,
        total: Duration,
    ) {
        self.decode = decode
        self.textRecognition = textRecognition
        self.barcodeDetection = barcodeDetection
        self.sizeTabPass = sizeTabPass
        self.total = total
    }
}
