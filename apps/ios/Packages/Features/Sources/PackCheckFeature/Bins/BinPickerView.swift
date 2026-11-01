import Core
import DesignSystem
import SwiftUI

/// Putting items in a bin: Scan bin sticker first (one hand, the phone over the bin), the bins
/// to tap, a new bin, or taking the item out of its bin. Closes once Listora has the choice.
struct BinPickerView: View {
    let environment: PackCheckEnvironment
    @State private var model: BinPickerModel
    @State private var scanning = false
    @State private var form: BinFormModel?
    @Environment(\.dismiss) private var dismiss

    init(
        environment: PackCheckEnvironment,
        request: BinRequest,
        onDone: @escaping @MainActor (BinChoice?) -> Void,
    ) {
        self.environment = environment
        _model = State(initialValue: BinPickerModel(request: request, service: environment.bins, onDone: onDone))
    }

    var body: some View {
        NavigationStack {
            content
                .background(Palette.background)
                .navigationTitle(model.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }.disabled(model.isWorking)
                    }
                }
        }
        .sheet(isPresented: $scanning) {
            CodeScannerView(target: .bin, source: environment.scanSource) { code in
                Task { await model.scanned(code) }
            }
        }
        .sheet(item: $form) { BinFormView(model: $0) }
        .task { await model.load() }
        .interactiveDismissDisabled(model.isWorking)
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            SkeletonList(count: 3, label: "Loading your bins")
        case let .failed(message):
            EmptyStateView(
                systemImage: "archivebox",
                tone: .failed,
                title: "Bins unavailable",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await model.load() } },
            )
        case .loaded:
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    Button("Scan bin sticker", systemImage: "qrcode.viewfinder") { scanning = true }
                        .buttonStyle(.listoraPrimary)
                        .disabled(model.isWorking)
                        .accessibilityIdentifier("binPicker.scan")
                    if let code = model.unknownCode {
                        Banner(
                            "No bin \(code) yet",
                            message: "Make it, and the item goes in it.",
                            tone: .actionNeeded,
                            systemImage: "archivebox",
                            action: .init("Make bin \(code)", identifier: "binPicker.makeScanned") {
                                form = model.makeForm()
                            },
                            identifier: "binPicker.unknown",
                        )
                    }
                    if let failure = model.failure {
                        Banner("Not saved", message: failure, tone: .failed, identifier: "binPicker.failure")
                    }
                    if model.isWorking {
                        ProgressView("Saving")
                            .frame(maxWidth: .infinity)
                    }
                    if !model.bins.isEmpty {
                        VStack(alignment: .leading, spacing: Spacing.xs) {
                            SectionHeader("Your bins")
                            VStack(spacing: 0) {
                                ForEach(Array(model.bins.enumerated()), id: \.element.id) { index, bin in
                                    if index > 0 {
                                        Divider().overlay(Palette.separator.color)
                                    }
                                    Button { Task { await model.put(in: bin) } } label: {
                                        BinRow(bin: bin, isCurrent: model.request.current?.id == bin.id)
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(model.isWorking)
                                    .accessibilityIdentifier("binPicker.bin.\(bin.code)")
                                }
                            }
                            .cardStyle(.flat, padding: 0)
                        }
                    }
                    Button("New bin \(model.nextCode)", systemImage: "plus") { form = model.makeForm() }
                        .buttonStyle(.listoraSecondary)
                        .disabled(model.isWorking)
                        .accessibilityIdentifier("binPicker.new")
                    if let current = model.request.current {
                        Button("Take out of bin \(current.code)") { Task { await model.takeOut() } }
                            .buttonStyle(.listora(.tertiary, size: .compact))
                            .disabled(model.isWorking)
                            .accessibilityIdentifier("binPicker.takeOut")
                    }
                }
                .padding(Spacing.md)
                .frame(maxWidth: Layout.readableWidth)
                .frame(maxWidth: .infinity)
            }
        }
    }
}
