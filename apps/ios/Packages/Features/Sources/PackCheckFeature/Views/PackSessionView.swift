import DesignSystem
import ListoraAPI
import SwiftUI
import UIKit

/// Packing at the table, one order at a time: the item to put in the box (its photo large), then
/// the label's scan and what it means, in big clear words: green when it's this order's label, a
/// red stop when it's another's or was already used. After the last order, the ones still not
/// packed are named.
struct PackSessionView: View {
    @Bindable var model: PackSessionModel
    let scanSource: ScanSource
    let onClose: @MainActor () -> Void
    @State private var scanning: ScanTarget?
    @State private var takingPhoto = false
    @State private var printingSlip = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    if model.stage == .finished {
                        summary
                    } else if let order = model.current {
                        OrderHeader(order: order, sticker: model.sticker)
                        if let error = model.error {
                            Banner("Something went wrong", message: error, tone: .failed)
                        }
                        stage(order)
                    }
                }
                .padding(Spacing.md)
                .frame(maxWidth: Layout.readableWidth)
                .frame(maxWidth: .infinity)
            }
            .background(Palette.background)
            .navigationTitle(model.progress ?? "Pack order")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(model.stage == .finished ? "Close" : "End") {
                        if model.stage == .finished { onClose() } else { model.finish() }
                    }
                    .accessibilityIdentifier("pack.end")
                }
            }
            .sheet(item: $scanning) { target in
                CodeScannerView(target: target, source: scanSource) { code in
                    Task {
                        switch target {
                        case .label: await model.scannedLabel(code)
                        case .sticker: await model.scannedSticker(code)
                        }
                    }
                }
            }
            .sheet(isPresented: $takingPhoto) {
                PackagePhotoPicker(scripted: scanSource.isScripted) { image in
                    Task { await model.savePhoto(image) }
                }
            }
            .sheet(isPresented: $printingSlip) {
                if let order = model.current {
                    PackingSlipView(order: order)
                }
            }
        }
    }

    @ViewBuilder
    private func stage(_ order: PackOrder) -> some View {
        switch model.stage {
        case .scanLabel:
            VStack(spacing: Spacing.sm) {
                Button { scanning = .label } label: {
                    Label("Scan the label", systemImage: "barcode.viewfinder")
                }
                .buttonStyle(ListoraButtonStyle(.primary))
                .accessibilityIdentifier("pack.scanLabel")
                if model.sticker == nil {
                    Button { scanning = .sticker } label: {
                        Label("Scan the item sticker first", systemImage: "qrcode.viewfinder")
                    }
                    .buttonStyle(ListoraButtonStyle(.secondary))
                    .accessibilityIdentifier("pack.scanSticker")
                }
                Button("Skip this order for now") { model.skip() }
                    .buttonStyle(ListoraButtonStyle(.tertiary))
                    .accessibilityIdentifier("pack.skip")
            }
        case .checking, .packing:
            HStack(spacing: Spacing.sm) {
                ProgressView()
                Text(model.stage == .checking ? "Checking the label..." : "Packing...")
                    .font(Typography.body)
            }
            .frame(maxWidth: .infinity)
            .cardStyle(.flat)
        case let .verdict(scan, _):
            VerdictPanel(scan: scan)
            verdictActions(scan)
        case .packed:
            packed(order)
        case .finished:
            EmptyView()
        }
    }

    @ViewBuilder
    private func verdictActions(_ scan: PackScan) -> some View {
        VStack(spacing: Spacing.sm) {
            if scan.canPack {
                Button { Task { await model.pack() } } label: {
                    Label("Packed", systemImage: "checkmark.seal.fill")
                }
                .buttonStyle(ListoraButtonStyle(.primary))
                .accessibilityIdentifier("pack.packed")
                if model.sticker == nil {
                    Button { scanning = .sticker } label: {
                        Label("Scan the item sticker too", systemImage: "qrcode.viewfinder")
                    }
                    .buttonStyle(ListoraButtonStyle(.secondary))
                    .accessibilityIdentifier("pack.scanStickerToo")
                }
            } else if scan.canPhotoCheck {
                Button { Task { await model.pack(photoCheck: true) } } label: {
                    Label("It's this order", systemImage: "photo.badge.checkmark")
                }
                .buttonStyle(ListoraButtonStyle(.primary))
                .accessibilityIdentifier("pack.photoCheck")
            }
            Button(scan.canPack ? "Scan a different label" : "Scan another label") {
                model.scanAgain()
                scanning = .label
            }
            .buttonStyle(ListoraButtonStyle(scan.canPack ? .tertiary : .secondary))
            .accessibilityIdentifier("pack.scanAgain")
        }
    }

    private func packed(_ order: PackOrder) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Banner(
                "Packed",
                message: order.packStatus.label,
                tone: StatusTone(order.packStatus.tone),
            )
            .accessibilityIdentifier("pack.packedBanner")
            if let photo = order.pack?.photoUrl {
                HStack(spacing: Spacing.sm) {
                    ItemPhoto(url: photo, side: 72)
                    Text("Package photo kept for a claim")
                        .font(Typography.subheadline)
                    Spacer()
                    Button("Remove") { Task { await model.removePhoto() } }
                        .buttonStyle(ListoraButtonStyle(.destructiveText, size: .compact))
                }
                .cardStyle(.flat)
            } else {
                Button { takingPhoto = true } label: {
                    Label(model.isSavingPhoto ? "Saving the photo..." : "Add a package photo", systemImage: "camera")
                }
                .buttonStyle(ListoraButtonStyle(.secondary))
                .disabled(model.isSavingPhoto)
                .accessibilityIdentifier("pack.addPhoto")
                Text("Optional: a photo of the open package with the label showing, kept with the order for a claim.")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let error = model.photoError {
                Banner("Photo not saved", message: error, tone: .failed)
            }
            Button { printingSlip = true } label: {
                Label("Print a packing slip", systemImage: "printer")
            }
            .buttonStyle(ListoraButtonStyle(.secondary))
            .accessibilityIdentifier("pack.printSlip")
            Button(model.unpacked.isEmpty ? "Done" : "Next order") { model.next() }
                .buttonStyle(ListoraButtonStyle(.primary))
                .accessibilityIdentifier("pack.next")
            Button("Unpack this order") { Task { await model.unpack() } }
                .buttonStyle(ListoraButtonStyle(.destructiveText))
                .accessibilityIdentifier("pack.unpack")
        }
    }

    /// The end of a session: what is still not packed, so nothing is forgotten.
    private var summary: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            let left = model.unpacked
            if left.isEmpty {
                EmptyStateView(
                    systemImage: "checkmark.seal",
                    tone: .success,
                    title: model.orders.count == 1 ? "Packed" : "All \(model.orders.count) orders packed",
                    message: "Every label was checked against its order.",
                )
                .accessibilityIdentifier("pack.summary.done")
            } else {
                Banner(
                    left.count == 1 ? "1 order is not packed" : "\(left.count) orders are not packed",
                    message: "Pack them before you ship, so no buyer is missed.",
                    tone: .actionNeeded,
                )
                .accessibilityIdentifier("pack.summary.unpacked")
                ForEach(left, id: \.saleId) { order in
                    PackOrderCard(order: order)
                }
            }
            Button("Close") { onClose() }
                .buttonStyle(ListoraButtonStyle(left.isEmpty ? .primary : .secondary))
                .accessibilityIdentifier("pack.close")
        }
    }
}

/// The order on the table: the item's photo large, what to pull from the shelf, who it goes to.
private struct OrderHeader: View {
    let order: PackOrder
    let sticker: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            ItemPhoto(url: order.items.first?.photoUrl ?? order.items.first?.thumbnailUrl, side: 220)
                .frame(maxWidth: .infinity)
            Text(order.description.prefix(1).uppercased() + order.description.dropFirst())
                .font(Typography.title)
                .foregroundStyle(Palette.textPrimary)
                .accessibilityIdentifier("pack.current")
            ForEach(order.items, id: \.itemId) { item in
                Text([item.sku, item.location.map { "Shelf \($0.code)" }].compactMap(\.self).joined(separator: " · "))
                    .font(Typography.metadata)
                    .foregroundStyle(Palette.textSecondary)
            }
            Text(order.buyerFirstName.map { "For \($0) on \(MarketplaceName.of(order.marketplace))" }
                ?? "Sold on \(MarketplaceName.of(order.marketplace))")
                .font(Typography.subheadline)
            StatusBadge(order.labelStatus.label, tone: StatusTone(order.labelStatus.tone))
            if let sticker {
                StatusBadge("Sticker \(sticker.replacingOccurrences(of: "LISTORA:", with: ""))", tone: .neutral)
            }
        }
        .cardStyle(.flat)
    }
}

/// What the scan means, big and in color: green, a red stop, or a warning, with the photo of
/// the item the label is for when that's another order.
private struct VerdictPanel: View {
    let scan: PackScan

    var body: some View {
        let tone = StatusTone(scan.tone)
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(spacing: Spacing.sm) {
                Image(systemName: icon)
                    .font(.system(size: 36, weight: .bold))
                    .foregroundStyle(tone.color.color)
                    .accessibilityHidden(true)
                Text(title)
                    .font(Typography.title)
                    .foregroundStyle(tone.color.color)
            }
            Text(scan.headline)
                .font(Typography.title3)
                .foregroundStyle(Palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("pack.verdict.headline")
            Text(scan.detail)
                .font(Typography.body)
                .foregroundStyle(Palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("pack.verdict.detail")
            if let other = scan.order ?? scan.packedOrder, scan.verdict.value1 != .match {
                HStack(spacing: Spacing.sm) {
                    ItemPhoto(url: other.items.first?.photoUrl ?? other.items.first?.thumbnailUrl, side: 96)
                    Text("This label's item")
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Spacing.md)
        .background(tone.softColor.color)
        .clipShape(RoundedRectangle(cornerRadius: Radius.large))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("pack.verdict.\(scan.verdict.value1?.rawValue ?? "unknown")")
    }

    private var title: String {
        switch scan.verdict.value1 {
        case .match: "Right label"
        case .wrongOrder, .alreadyPacked, .stickerMismatch: "Stop"
        case .found: "Found it"
        default: "Check this"
        }
    }

    private var icon: String {
        switch StatusTone(scan.tone) {
        case .success: "checkmark.seal.fill"
        case .failed: "xmark.octagon.fill"
        case .actionNeeded: "exclamationmark.triangle.fill"
        default: "barcode"
        }
    }
}

extension ScanTarget: Identifiable {
    var id: Self {
        self
    }
}

extension ScanSource {
    var isScripted: Bool {
        if case .scripted = self { return true }
        return false
    }
}
