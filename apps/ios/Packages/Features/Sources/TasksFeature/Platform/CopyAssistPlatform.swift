import Foundation
import Photos
import UIKit

/// Where one-tap copy puts a value. The app uses the system pasteboard; tests record.
public protocol Pasteboard: Sendable {
    @MainActor func copy(_ value: String)
}

public struct SystemPasteboard: Pasteboard {
    public init() {}

    @MainActor public func copy(_ value: String) {
        UIPasteboard.general.string = value
    }
}

/// Why photos could not be saved, worded for the user.
public enum PhotoSaveError: Error, Equatable, Sendable {
    /// The user has not let Listora add photos to their library.
    case notAllowed
    /// A photo could not be downloaded.
    case download
    /// The library refused a photo.
    case save
}

/// Saves photos to the user's camera roll, one after another, so they appear in the order given
/// (the marketplace app's picker shows them in that order). The app uses the photo library;
/// tests record.
public protocol PhotoSaving: Sendable {
    /// Saves every image in order; `progress` gets the number saved so far.
    func save(
        _ urls: [URL],
        progress: @escaping @MainActor @Sendable (Int) -> Void,
    ) async throws(PhotoSaveError)
}

/// ``PhotoSaving`` with `PHPhotoLibrary`, asking only for add-only access.
public struct PhotoLibrarySaver: PhotoSaving {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func save(
        _ urls: [URL],
        progress: @escaping @MainActor @Sendable (Int) -> Void,
    ) async throws(PhotoSaveError) {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { throw .notAllowed }
        // Download everything first, so a failed download saves nothing and a retry starts clean.
        var images: [Data] = []
        for url in urls {
            guard let download = try? await session.data(from: url),
                  (download.1 as? HTTPURLResponse)?.statusCode == 200
            else { throw .download }
            images.append(download.0)
        }
        for (index, data) in images.enumerated() {
            do {
                try await PHPhotoLibrary.shared().performChanges {
                    PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: nil)
                }
            } catch {
                throw .save
            }
            await progress(index + 1)
        }
    }
}
