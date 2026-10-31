import DesignSystem
import SwiftUI

/// Scan mode's actions in Add Item's bottom bar: start or go back to the run, check it out at
/// the register, or end it without buying.
struct ScanActions: View {
    let model: AddItemModel
    @Binding var camera: OpenCamera?
    @Binding var sheet: ScanSheet?

    var body: some View {
        Button {
            if let run = model.scanRun {
                camera = .scan(run)
            } else {
                sheet = .start
            }
        } label: {
            Label(model.scanRun == nil ? "Start scanning" : "Keep scanning", systemImage: "camera.viewfinder")
        }
        .buttonStyle(.listoraPrimary)
        .accessibilityIdentifier("addItem.startScan")
        if let run = model.scanRun {
            if !run.entries.isEmpty {
                Button("Check out") { sheet = .checkout(run) }
                    .buttonStyle(.listora(.secondary, size: .large))
                    .accessibilityIdentifier("addItem.checkoutScan")
            }
            Button("End run") {
                Task { await model.endScanRun() }
            }
            .buttonStyle(.listora(.tertiary, size: .large))
            .accessibilityIdentifier("addItem.endScan")
        }
    }
}

/// Scan mode's section above the drafts: the run going on, or the last run's summary once it
/// was checked out.
struct ScanRunSection: View {
    let model: AddItemModel

    var body: some View {
        if let run = model.scanRun, !run.entries.isEmpty {
            Section {
                ScanRunRow(run: run)
            }
            .listRowBackground(Palette.surface.color)
        } else if model.scanRun == nil, let summary = model.lastRunSummary {
            Section {
                ScanRunSummaryView(card: RunSummaryCard(summary))
                    .listRowInsets(EdgeInsets(top: Spacing.xs, leading: 0, bottom: Spacing.xs, trailing: 0))
            }
            .listRowBackground(Color.clear)
        }
    }
}

/// The run going on, above the drafts it kept.
struct ScanRunRow: View {
    let run: ScanRunModel

    var body: some View {
        ListRow(
            "This run",
            subtitle: [
                run.place,
                run.keptCount == 1
                    ? "\(run.entries.count) scanned, 1 kept"
                    : "\(run.entries.count) scanned, \(run.keptCount) kept",
            ].compactMap(\.self).joined(separator: " · "),
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
    /// The register's checkout, over the camera; the camera closes once it went through.
    @State private var isCheckingOut = false

    var body: some View {
        ScanCaptureView(
            camera: environment.makeCamera(),
            run: run,
            voice: ScanVoice(transcriber: environment.transcriber),
            showsMeasurements: environment.features?.isTesting(.thriftScan) == true,
            meter: model.meter,
            onDone: onClose,
            onCheckout: { isCheckingOut = true },
            onEnd: {
                onClose()
                await model.endScanRun()
            },
        )
        .sheet(
            isPresented: $isCheckingOut,
            onDismiss: {
                if run.isEnded {
                    onClose()
                }
            },
            content: {
                ScanCheckoutView(
                    checkout: model.scanCheckout(for: run, in: environment),
                    onCheckout: { await model.checkOut($0, totalCents: $1, itemCount: $2, miles: $3) },
                    onDone: { isCheckingOut = false },
                )
            },
        )
    }
}

/// Scan mode's sheets over Add Item: starting a run, which then opens the camera, and the
/// checkout of the run going on.
struct ScanSheets: ViewModifier {
    @Binding var sheet: ScanSheet?
    @Binding var camera: OpenCamera?
    let model: AddItemModel
    let environment: AddItemEnvironment
    /// The camera to open once the start sheet is gone: one presentation at a time.
    @State private var cameraAfterSheet: OpenCamera?

    func body(content: Content) -> some View {
        content.sheet(
            item: $sheet,
            onDismiss: {
                camera = cameraAfterSheet
                cameraAfterSheet = nil
            },
            content: presented,
        )
    }

    @ViewBuilder
    private func presented(_ sheet: ScanSheet) -> some View {
        switch sheet {
        case .start:
            ScanStartView(
                recentPlaces: model.recentPlaces.sources,
                onStart: { place in
                    cameraAfterSheet = .scan(model.scanRun(in: environment, place: place))
                    self.sheet = nil
                },
                onCancel: { self.sheet = nil },
            )
        case let .checkout(run):
            ScanCheckoutView(
                checkout: model.scanCheckout(for: run, in: environment),
                onCheckout: { await model.checkOut($0, totalCents: $1, itemCount: $2, miles: $3) },
                onDone: { self.sheet = nil },
            )
        }
    }
}

/// A sheet of Scan mode: starting a run, or its checkout.
enum ScanSheet: Identifiable {
    case start
    case checkout(ScanRunModel)

    var id: String {
        switch self {
        case .start: "start"
        case let .checkout(run): "checkout-\(run.id)"
        }
    }
}
