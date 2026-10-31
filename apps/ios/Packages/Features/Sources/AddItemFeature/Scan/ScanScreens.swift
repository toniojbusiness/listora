import DesignSystem
import SwiftUI

/// Scan mode's actions in Add Item's bottom bar: start or go back to the run, and end it.
struct ScanActions: View {
    let model: AddItemModel
    let onScan: () -> Void

    var body: some View {
        Button(action: onScan) {
            Label(model.scanRun == nil ? "Start scanning" : "Keep scanning", systemImage: "camera.viewfinder")
        }
        .buttonStyle(.listoraPrimary)
        .accessibilityIdentifier("addItem.startScan")
        if model.scanRun != nil {
            Button("End run") {
                Task { await model.endScanRun() }
            }
            .buttonStyle(.listora(.tertiary, size: .large))
            .accessibilityIdentifier("addItem.endScan")
        }
    }
}

/// The run going on, above the drafts it kept.
struct ScanRunRow: View {
    let run: ScanRunModel

    var body: some View {
        ListRow(
            "This run",
            subtitle: run.keptCount == 1
                ? "\(run.entries.count) scanned, 1 kept"
                : "\(run.entries.count) scanned, \(run.keptCount) kept",
            systemImage: "cart",
        )
        .accessibilityIdentifier("addItem.scanRun")
    }
}

/// The scan camera of the run, as Add Item presents it.
struct ScanCamera: View {
    let run: ScanRunModel
    let model: AddItemModel
    let environment: AddItemEnvironment
    let onClose: @MainActor () -> Void

    var body: some View {
        ScanCaptureView(
            camera: environment.makeCamera(),
            run: run,
            voice: ScanVoice(transcriber: environment.transcriber),
            showsMeasurements: environment.features?.isTesting(.thriftScan) == true,
            meter: model.meter,
            onDone: onClose,
            onEnd: {
                onClose()
                await model.endScanRun()
            },
        )
    }
}
