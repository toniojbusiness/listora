import AVFoundation
import SwiftUI
import Synchronization
import UIKit

enum CameraError: Error, Equatable {
    case unavailable
    case accessDenied
    case captureFailed
}

/// The back camera for photo capture. The capture session is configured, started, and stopped on
/// its own serial queue, as AVFoundation requires; only that queue touches it after creation.
final class CameraSession: NSObject, @unchecked Sendable {
    let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private let queue = DispatchQueue(label: "com.listora.app.camera")
    private var isConfigured = false
    private let pending = Mutex<[Int64: CheckedContinuation<Data, any Error>]>([:])

    /// Asks for camera access when the user has not decided yet.
    static func requestAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: true
        case .notDetermined: await AVCaptureDevice.requestAccess(for: .video)
        default: false
        }
    }

    func start() async throws {
        guard await Self.requestAccess() else { throw CameraError.accessDenied }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            queue.async { [self] in
                do {
                    try configureIfNeeded()
                    if !session.isRunning {
                        session.startRunning()
                    }
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func stop() {
        queue.async { [self] in
            if session.isRunning {
                session.stopRunning()
            }
        }
    }

    /// Takes one photo; returns its encoded data with EXIF orientation.
    func capture() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { [self] in
                let settings = AVCapturePhotoSettings()
                settings.photoQualityPrioritization = .balanced
                if output.supportedFlashModes.contains(.auto) {
                    settings.flashMode = .auto
                }
                pending.withLock { $0[settings.uniqueID] = continuation }
                output.capturePhoto(with: settings, delegate: self)
            }
        }
    }

    private func configureIfNeeded() throws {
        guard !isConfigured else { return }
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw CameraError.unavailable
        }
        let input = try AVCaptureDeviceInput(device: device)
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .photo
        guard session.canAddInput(input), session.canAddOutput(output) else { throw CameraError.unavailable }
        session.addInput(input)
        session.addOutput(output)
        output.maxPhotoQualityPrioritization = .balanced
        // The app runs in portrait, so photos come out upright.
        if let connection = output.connection(with: .video), connection.isVideoRotationAngleSupported(90) {
            connection.videoRotationAngle = 90
        }
        isConfigured = true
    }
}

extension CameraSession: AVCapturePhotoCaptureDelegate {
    func photoOutput(_: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: (any Error)?) {
        let continuation = pending.withLock { $0.removeValue(forKey: photo.resolvedSettings.uniqueID) }
        if let error {
            continuation?.resume(throwing: error)
        } else if let data = photo.fileDataRepresentation() {
            continuation?.resume(returning: data)
        } else {
            continuation?.resume(throwing: CameraError.captureFailed)
        }
    }
}

/// The live camera image, filling its frame.
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context _: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        if let connection = view.previewLayer.connection, connection.isVideoRotationAngleSupported(90) {
            connection.videoRotationAngle = 90
        }
        return view
    }

    func updateUIView(_: PreviewView, context _: Context) {}

    final class PreviewView: UIView {
        override static var layerClass: AnyClass {
            AVCaptureVideoPreviewLayer.self
        }

        var previewLayer: AVCaptureVideoPreviewLayer {
            // The layer class above guarantees the type.
            // swiftlint:disable:next force_cast
            layer as! AVCaptureVideoPreviewLayer
        }
    }
}
