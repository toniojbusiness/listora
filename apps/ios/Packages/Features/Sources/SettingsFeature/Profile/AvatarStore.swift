import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Where the seller's profile photo lives: on this iPhone only, one file per person (the photo is
/// never uploaded; docs/features/profile.md). A protocol so the model's tests keep it in memory.
public protocol AvatarStore: Sendable {
    func photo(for email: String) -> Data?
    func save(_ photo: Data, for email: String) throws
    func remove(for email: String)
}

/// ``AvatarStore`` in a directory of the app's data: `<sha256 of the email>.jpg`, so the file
/// name does not show the address. Excluded from backups like the rest of the app's data.
public struct FileAvatarStore: AvatarStore {
    private let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// `Application Support/Profile` in the app's container.
    public static func defaultDirectory() -> URL {
        URL.applicationSupportDirectory.appending(path: "Profile", directoryHint: .isDirectory)
    }

    public func photo(for email: String) -> Data? {
        try? Data(contentsOf: file(for: email))
    }

    public func save(_ photo: Data, for email: String) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var url = file(for: email)
        try photo.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }

    public func remove(for email: String) {
        try? FileManager.default.removeItem(at: file(for: email))
    }

    private func file(for email: String) -> URL {
        let digest = SHA256.hash(data: Data(email.lowercased().utf8))
        let name = digest.map { String(format: "%02x", $0) }.joined()
        return directory.appending(path: "\(name).jpg")
    }
}

/// A picked photo made into the profile photo: at most 512 pixels on its longest side, upright,
/// re-encoded as JPEG without any of the original's metadata (its location among it).
public enum AvatarPhoto {
    public static let maxPixels = 512

    /// Nil when the data is not an image.
    public static func prepared(_ data: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil,
        ) else { return nil }
        CGImageDestinationAddImage(
            destination,
            image,
            [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary,
        )
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }
}
