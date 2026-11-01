import AVFoundation
import DesignSystem
import SwiftUI
import UIKit
import VisionKit

/// Where scanned codes come from: the camera, or in UI tests the codes they script
/// (`LISTORA_SCANNED_CODES`), handed out one per tap of Scan, since the simulator has no camera.
public enum ScanSource: Sendable {
    case camera
    case scripted(ScriptedScans)
}

/// The codes a UI test "scans", in order.
public final class ScriptedScans: @unchecked Sendable {
    private let lock = NSLock()
    private var codes: [String]

    public init(_ codes: [String]) {
        self.codes = codes
    }

    func next() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return codes.isEmpty ? nil : codes.removeFirst()
    }
}

/// What the scanner is looking at, in the seller's words.
enum ScanTarget {
    case label
    case sticker
    /// A bin's sticker (docs/features/storage-bins.md), to put an item in the bin.
    case bin

    var title: String {
        switch self {
        case .label: "Scan the shipping label"
        case .sticker: "Scan the item sticker"
        case .bin: "Scan the bin sticker"
        }
    }

    var hint: String {
        switch self {
        case .label: "Point the camera at the long barcode on the label."
        case .sticker: "Point the camera at the QR code on the item's sticker."
        case .bin: "Point the camera at the QR code on the bin's sticker."
        }
    }
}

/// The camera reading one barcode, with a typed number as the fallback (no camera, the camera
/// turned off, or a barcode that won't read). Asks for the camera with plain words first.
struct CodeScannerView: View {
    let target: ScanTarget
    let source: ScanSource
    let onCode: @MainActor (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var access: CameraAccess = .unknown
    @State private var typed = ""
    @State private var isTyping = false

    var body: some View {
        NavigationStack {
            VStack(spacing: Spacing.md) {
                scanner
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Palette.mediaBackground)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.large))
                Text(target.hint)
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                    .multilineTextAlignment(.center)
                if target == .label {
                    typeNumber
                }
            }
            .padding(Spacing.md)
            .background(Palette.background)
            .navigationTitle(target.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task { access = CameraAccess.current }
        }
    }

    @ViewBuilder
    private var scanner: some View {
        switch source {
        case let .scripted(scans):
            VStack(spacing: Spacing.md) {
                Image(systemName: "barcode.viewfinder")
                    .font(.system(size: 64))
                    .foregroundStyle(Palette.onMedia)
                    .accessibilityHidden(true)
                Button("Scan") {
                    if let code = scans.next() {
                        deliver(code)
                    }
                }
                .buttonStyle(ListoraButtonStyle(.primary, size: .compact))
                .accessibilityIdentifier("scanner.scan")
            }
        case .camera:
            switch access {
            case .unknown:
                askFirst
            case .granted where DataScannerViewController.isSupported && DataScannerViewController.isAvailable:
                DataScanner(onCode: deliver)
                    .accessibilityLabel("Camera, looking for a barcode")
            case .granted:
                unavailable("This iPhone can't scan barcodes here. Type the number below.")
            case .denied:
                unavailable("The camera is off for Listora. Turn it on in Settings, or type the number below.")
            }
        }
    }

    /// The plain words before iOS asks for the camera.
    private var askFirst: some View {
        VStack(spacing: Spacing.md) {
            Image(systemName: "camera.viewfinder")
                .font(.system(size: 48))
                .foregroundStyle(Palette.onMedia)
                .accessibilityHidden(true)
            Text("Listora reads the barcode with your camera. It doesn't take or keep a picture.")
                .font(Typography.body)
                .foregroundStyle(Palette.onMedia)
                .multilineTextAlignment(.center)
            Button("Use the camera") {
                Task { access = await CameraAccess.request() }
            }
            .buttonStyle(ListoraButtonStyle(.primary, size: .compact))
            .accessibilityIdentifier("scanner.allowCamera")
        }
        .padding(Spacing.lg)
    }

    private func unavailable(_ message: String) -> some View {
        VStack(spacing: Spacing.sm) {
            Image(systemName: "camera.badge.ellipsis")
                .font(.system(size: 40))
                .foregroundStyle(Palette.onMedia)
                .accessibilityHidden(true)
            Text(message)
                .font(Typography.body)
                .foregroundStyle(Palette.onMedia)
                .multilineTextAlignment(.center)
            if access == .denied, let settings = URL(string: UIApplication.openSettingsURLString) {
                Link("Open Settings", destination: settings)
                    .font(Typography.headline)
                    .foregroundStyle(Palette.onMedia)
            }
        }
        .padding(Spacing.lg)
    }

    private var typeNumber: some View {
        HStack(spacing: Spacing.xs) {
            TextField("Or type the tracking number", text: $typed)
                .textFieldStyle(.roundedBorder)
                .font(Typography.code)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .onSubmit(submitTyped)
                .accessibilityIdentifier("scanner.typed")
            Button("Use") { submitTyped() }
                .buttonStyle(ListoraButtonStyle(.secondary, size: .compact))
                .disabled(typed.trimmingCharacters(in: .whitespaces).count < 10)
                .accessibilityIdentifier("scanner.useTyped")
        }
    }

    private func submitTyped() {
        let number = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard number.count >= 10 else { return }
        deliver(number)
    }

    private func deliver(_ code: String) {
        onCode(code)
        dismiss()
    }
}

/// Whether Listora may use the camera.
enum CameraAccess: Equatable {
    case unknown
    case granted
    case denied

    static var current: CameraAccess {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: .granted
        case .notDetermined: .unknown
        default: .denied
        }
    }

    static func request() async -> CameraAccess {
        await AVCaptureDevice.requestAccess(for: .video) ? .granted : .denied
    }
}

/// VisionKit's live barcode scanner; the first barcode it reads is the scan.
private struct DataScanner: UIViewControllerRepresentable {
    let onCode: @MainActor (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.code128, .qr, .dataMatrix, .pdf417, .code39, .ean13])],
            qualityLevel: .accurate,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isHighlightingEnabled: true,
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_: DataScannerViewController, context _: Context) {}

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator _: Coordinator) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onCode: onCode)
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        private let onCode: @MainActor (String) -> Void
        private var delivered = false

        init(onCode: @escaping @MainActor (String) -> Void) {
            self.onCode = onCode
        }

        func dataScanner(_: DataScannerViewController, didAdd items: [RecognizedItem], allItems _: [RecognizedItem]) {
            guard !delivered else { return }
            for item in items {
                if case let .barcode(barcode) = item, let payload = barcode.payloadStringValue, !payload.isEmpty {
                    delivered = true
                    onCode(payload)
                    return
                }
            }
        }
    }
}
