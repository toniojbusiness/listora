import Core
import DesignSystem
import ListoraAPI
import SwiftUI
import UIKit

/// Printing item stickers through AirPrint: pick the label size, how many, then the system's
/// print sheet picks the printer.
struct StickerPrintView: View {
    let stickers: [StickerRequest]
    @Environment(\.dismiss) private var dismiss
    @AppStorage("packCheck.stickerFormat") private var formatID = StickerFormat.roll225x125.rawValue
    @State private var copies = 1
    @State private var printed = false

    private var format: StickerFormat {
        StickerFormat(rawValue: formatID) ?? .roll225x125
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    if let first = stickers.first {
                        StickerPreview(sticker: first, format: format)
                            .frame(maxWidth: .infinity)
                    }
                    VStack(alignment: .leading, spacing: Spacing.sm) {
                        SectionHeader("Label size")
                        ForEach(StickerFormat.allCases) { option in
                            Button { formatID = option.rawValue } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: Spacing.xxs) {
                                        Text(option.name).font(Typography.body)
                                        Text(option.detail)
                                            .font(Typography.footnote)
                                            .foregroundStyle(Palette.textSecondary)
                                    }
                                    Spacer()
                                    if option == format {
                                        Image(systemName: "checkmark").foregroundStyle(Palette.brand.color)
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(option == format ? .isSelected : [])
                            .accessibilityIdentifier("sticker.format.\(option.rawValue)")
                        }
                        Stepper("Copies: \(copies)", value: $copies, in: 1 ... 30)
                            .font(Typography.body)
                            .accessibilityIdentifier("sticker.copies")
                    }
                    .cardStyle(.flat)
                    Text(
                        "Stick it on the item's bag. When you pack, scanning it with the shipping label "
                            + "makes sure the right item goes in the box. Printing uses AirPrint: your iPhone "
                            + "shows the printers on your Wi-Fi.",
                    )
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    if !Printer.isAvailable {
                        Banner("Printing isn't available", message: "This iPhone can't print right now.", tone: .actionNeeded)
                    }
                    if printed {
                        Banner("Sent to the printer", message: nil, tone: .success)
                    }
                    Button {
                        let all = stickers.flatMap { Array(repeating: $0, count: copies) }
                        Printer.print(StickerSheet.pdf(all, format: format), jobName: "Listora stickers") { done in
                            printed = done
                        }
                    } label: {
                        Label("Print", systemImage: "printer")
                    }
                    .buttonStyle(ListoraButtonStyle(.primary))
                    .disabled(!Printer.isAvailable)
                    .accessibilityIdentifier("sticker.print")
                }
                .padding(Spacing.md)
            }
            .background(Palette.background)
            .navigationTitle(stickers.count == 1 ? "Print sticker" : "Print \(stickers.count) stickers")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("sticker.done")
                }
            }
        }
    }
}

/// The sticker as it prints, drawn by the same code.
private struct StickerPreview: View {
    let sticker: StickerRequest
    let format: StickerFormat

    var body: some View {
        let size = format.stickerSize
        let image = UIGraphicsImageRenderer(size: size).image { _ in
            UIColor.white.setFill()
            UIRectFill(CGRect(origin: .zero, size: size))
            StickerSheet.draw(sticker, in: CGRect(origin: .zero, size: size))
        }
        Image(uiImage: image)
            .resizable()
            .interpolation(.none)
            .aspectRatio(contentMode: .fit)
            .frame(maxWidth: 280)
            .overlay(RoundedRectangle(cornerRadius: Radius.small).stroke(Palette.separator.color))
            .accessibilityLabel("Sticker with a QR code, \(sticker.sku)\(sticker.locationCode.map { ", shelf \($0)" } ?? "")")
            .accessibilityIdentifier("sticker.preview")
    }
}

/// The packing slip for an order: what it shows, then AirPrint.
struct PackingSlipView: View {
    let order: Components.Schemas.PackOrder
    @Environment(\.dismiss) private var dismiss
    @State private var format: PackingSlip.Format = .label4x6
    @State private var isPreparing = false

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Spacing.md) {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Text(order.buyerFirstName.map { "Thank you, \($0)!" } ?? "Thank you for your order!")
                        .font(Typography.title3)
                    Text(orderLine).font(Typography.subheadline).foregroundStyle(Palette.textSecondary)
                    ForEach(order.items, id: \.itemId) { item in
                        HStack(spacing: Spacing.sm) {
                            ItemPhoto(url: item.photoUrl ?? item.thumbnailUrl, side: 56)
                            Text(item.title ?? item.sku).font(Typography.body)
                        }
                    }
                }
                .cardStyle(.flat)
                Picker("Paper", selection: $format) {
                    ForEach(PackingSlip.Format.allCases) { Text($0.name).tag($0) }
                }
                .pickerStyle(.segmented)
                Text("It goes inside the package, so the buyer sees what they ordered.")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                Button {
                    Task { await print() }
                } label: {
                    Label(isPreparing ? "Preparing..." : "Print", systemImage: "printer")
                }
                .buttonStyle(ListoraButtonStyle(.primary))
                .disabled(isPreparing || !Printer.isAvailable)
                .accessibilityIdentifier("slip.print")
                Spacer()
            }
            .padding(Spacing.md)
            .background(Palette.background)
            .navigationTitle("Packing slip")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("slip.done")
                }
            }
        }
    }

    private var orderLine: String {
        let marketplace = MarketplaceName.of(order.marketplace)
        return order.orderNumber.map { "\(marketplace) order \($0)" } ?? "\(marketplace) order"
    }

    private func print() async {
        isPreparing = true
        defer { isPreparing = false }
        var items: [PackingSlip.Item] = []
        for item in order.items {
            var photo: Data?
            if let url = (item.photoUrl ?? item.thumbnailUrl).flatMap(URL.init(string:)) {
                photo = try? await URLSession.shared.data(from: url).0
            }
            items.append(.init(title: item.title ?? item.description, sku: item.sku, photo: photo))
        }
        let slip = PackingSlip(
            buyerFirstName: order.buyerFirstName,
            orderNumber: order.orderNumber,
            marketplace: MarketplaceName.of(order.marketplace),
            items: items,
        )
        Printer.print(slip.pdf(format: format), jobName: "Listora packing slip")
    }
}

/// The package photo: the camera, or the photo library where there is none (the simulator).
/// In UI tests (`scripted`) it "takes" a plain photo at once.
struct PackagePhotoPicker: UIViewControllerRepresentable {
    let scripted: Bool
    let onPhoto: @MainActor (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIViewController {
        if scripted {
            let controller = UIViewController()
            DispatchQueue.main.async {
                let image = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 48)).image { _ in
                    UIColor.brown.setFill()
                    UIRectFill(CGRect(x: 0, y: 0, width: 64, height: 48))
                }
                onPhoto(image)
                dismiss()
            }
            return controller
        }
        let picker = UIImagePickerController()
        picker.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_: UIViewController, context _: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onPhoto: onPhoto, dismiss: { dismiss() })
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onPhoto: @MainActor (UIImage) -> Void
        let dismiss: @MainActor () -> Void

        init(onPhoto: @escaping @MainActor (UIImage) -> Void, dismiss: @escaping @MainActor () -> Void) {
            self.onPhoto = onPhoto
            self.dismiss = dismiss
        }

        func imagePickerController(
            _: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any],
        ) {
            if let image = info[.originalImage] as? UIImage {
                onPhoto(image)
            }
            dismiss()
        }

        func imagePickerControllerDidCancel(_: UIImagePickerController) {
            dismiss()
        }
    }
}
