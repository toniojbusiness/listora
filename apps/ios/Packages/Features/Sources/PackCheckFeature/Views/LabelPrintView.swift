import Core
import DesignSystem
import SwiftUI

/// "Print label and stickers" for one order: what prints (the label, and a sticker for each item),
/// then one AirPrint job. A label printed before asks first; a label Listora can't get offers the
/// order's page on the marketplace instead.
struct LabelPrintView: View {
    @Bindable var model: LabelPrintModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    contents
                    status
                    actions
                }
                .padding(Spacing.md)
                .frame(maxWidth: Layout.readableWidth)
                .frame(maxWidth: .infinity)
            }
            .background(Palette.background)
            .navigationTitle("Print label and stickers")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("labelPrint.done")
                }
            }
            .confirmationDialog(
                "Print this label again?",
                isPresented: reprintBinding,
                titleVisibility: .visible,
            ) {
                Button("Print again") { Task { await model.print(confirmed: true) } }
                    .accessibilityIdentifier("labelPrint.again")
                Button("Cancel", role: .cancel) { model.cancelReprint() }
            } message: {
                Text(
                    "\(model.printedBefore ?? "Listora printed it before"). Print it again only if that copy "
                        + "didn't come out: a second copy on another package ships one buyer two packages.",
                )
            }
        }
    }

    /// What the job prints, in order.
    private var contents: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Label {
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text("The shipping label").font(Typography.headline)
                    Text(model.order.labelStatus.label)
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                }
            } icon: {
                Image(systemName: "shippingbox").foregroundStyle(Palette.brand.color)
            }
            ForEach(model.stickers, id: \.sku) { sticker in
                Label {
                    VStack(alignment: .leading, spacing: Spacing.xxs) {
                        Text(sticker.title ?? sticker.sku).font(Typography.headline).lineLimit(2)
                        Text(stickerLine(sticker))
                            .font(Typography.sku)
                            .foregroundStyle(Palette.textSecondary)
                    }
                } icon: {
                    Image(systemName: "qrcode").foregroundStyle(Palette.brand.color)
                }
            }
            Text(
                "One print job on your label printer: the label, then the order's stickers on the same "
                    + "roll. Printing uses AirPrint: your iPhone shows the printers on your Wi-Fi.",
            )
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .cardStyle(.flat)
        // Read as one: what the job prints.
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("labelPrint.contents")
    }

    @ViewBuilder
    private var status: some View {
        if let printed = model.printedBefore, model.stage != .printed {
            Banner(
                printed,
                message: "Printing it again asks first.",
                tone: .actionNeeded,
                identifier: "labelPrint.printedBefore",
            )
        }
        switch model.stage {
        case .ready, .confirmingReprint:
            EmptyView()
        case .downloading, .printing, .recording:
            HStack(spacing: Spacing.sm) {
                ProgressView()
                Text(progressWords).font(Typography.body)
            }
            .frame(maxWidth: .infinity)
            .cardStyle(.flat)
        case .printed:
            Banner(
                "Sent to the printer",
                message: model.printedBefore,
                tone: .success,
                identifier: "labelPrint.printed",
            )
        case let .failed(message):
            Banner("Not printed", message: message, tone: .failed, identifier: "labelPrint.failed")
        case let .notRecorded(message):
            Banner(
                "Printed, but not recorded",
                message: "\(message) Until it is, printing this label again won't warn you.",
                tone: .actionNeeded,
                action: .init("Try again", identifier: "labelPrint.retryRecord") { Task { await model.record() } },
                identifier: "labelPrint.notRecorded",
            )
        }
    }

    private var actions: some View {
        VStack(spacing: Spacing.sm) {
            if model.stage != .printed {
                Button { Task { await model.print() } } label: {
                    Label(
                        model.printedBefore == nil ? "Print label and stickers" : "Print again",
                        systemImage: "printer",
                    )
                }
                .buttonStyle(ListoraButtonStyle(.primary))
                .disabled(model.isWorking || !Printer.isAvailable)
                .accessibilityIdentifier("labelPrint.print")
            }
            if let page = model.labelPage {
                Link(destination: page) {
                    Label("Open the label on \(model.marketplace)", systemImage: "arrow.up.right.square")
                }
                .buttonStyle(ListoraButtonStyle(.tertiary))
                .accessibilityIdentifier("labelPrint.openPage")
            }
        }
    }

    private var progressWords: String {
        switch model.stage {
        case .downloading: "Getting the label from \(model.marketplace)..."
        case .printing: "Printing..."
        default: "Saving..."
        }
    }

    private func stickerLine(_ sticker: StickerRequest) -> String {
        [sticker.sku, sticker.locationCode.map { "Bin \($0)" }].compactMap(\.self).joined(separator: " · ")
    }

    private var reprintBinding: Binding<Bool> {
        Binding(
            get: { model.stage == .confirmingReprint },
            set: { shown in
                if !shown, model.stage == .confirmingReprint {
                    model.cancelReprint()
                }
            },
        )
    }
}
