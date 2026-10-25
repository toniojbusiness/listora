import DesignSystem
import SwiftUI
import UIKit

/// Where the guided capture gets its photos: the back camera on a device, or (debug builds) a
/// folder of photos that stands in for the camera in the simulator.
@MainActor
protocol CameraSource: AnyObject {
    func start() async throws
    func stop()
    /// Takes one photo; returns its encoded data.
    func capture() async throws -> Data
    /// The live image, filling its frame.
    func preview() -> AnyView
}

/// The device's back camera.
@MainActor
final class DeviceCamera: CameraSource {
    private let session = CameraSession()

    func start() async throws {
        try await session.start()
    }

    func stop() {
        session.stop()
    }

    func capture() async throws -> Data {
        try await session.capture()
    }

    func preview() -> AnyView {
        AnyView(CameraPreview(session: session.session))
    }
}

#if DEBUG
    /// Debug builds only (`LISTORA_FAKE_CAMERA=<folder>`): "takes" the folder's JPEGs in name order,
    /// one per shot, and shows the next one as the live image, so the guided capture can be seen and
    /// UI tested in the simulator, which has no camera.
    @MainActor
    @Observable
    final class FixtureCamera: CameraSource {
        private let photos: [URL]
        private var next = 0

        init(directory: URL) {
            let files = (
                try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil),
            ) ??
                []
            photos = files
                .filter { $0.pathExtension.lowercased() == "jpg" }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
        }

        func start() async throws {
            guard !photos.isEmpty else { throw CameraError.unavailable }
        }

        func stop() {}

        func capture() async throws -> Data {
            guard !photos.isEmpty else { throw CameraError.unavailable }
            let data = try Data(contentsOf: photos[next % photos.count])
            next += 1
            return data
        }

        func preview() -> AnyView {
            AnyView(FixturePreview(camera: self))
        }

        fileprivate var currentPhoto: URL? {
            photos.isEmpty ? nil : photos[next % photos.count]
        }
    }

    private struct FixturePreview: View {
        let camera: FixtureCamera

        var body: some View {
            GeometryReader { geometry in
                if let url = camera.currentPhoto, let image = UIImage(contentsOfFile: url.path(percentEncoded: false)) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: geometry.size.width, height: geometry.size.height)
                        .clipped()
                }
            }
        }
    }
#endif
