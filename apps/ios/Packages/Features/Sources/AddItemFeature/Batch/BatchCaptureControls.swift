import DesignSystem
import SwiftUI

/// Batch capture's prompt: the item being shot, how many photos it has, and what to shoot next
/// (or the last shot's problem, or that Listora started a new item).
struct BatchCapturePrompt: View {
    let model: BatchCaptureModel
    /// A one-off problem with the last shot, shown instead of the instruction.
    let notice: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            Text("Batch")
                .font(Typography.label)
                .textCase(.uppercase)
                .foregroundStyle(Palette.brand)
            Text(itemTitle)
                .font(Typography.title)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("batchCamera.item")
            Text(notice ?? instruction)
                .font(Typography.callout)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("batchCamera.instruction")
        }
        .foregroundStyle(Palette.onMedia)
        .padding(Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Palette.scrim.color.opacity(0.55),
            in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous),
        )
        .accessibilityElement(children: .combine)
    }

    private var itemTitle: String {
        let photos = model.photosInItem
        return photos == 0
            ? "Item \(model.itemNumber)"
            : "Item \(model.itemNumber) · \(photos == 1 ? "1 photo" : "\(photos) photos")"
    }

    private var instruction: String {
        if model.detectedNewItemAt != nil, model.detectedNewItemAt == model.lastShot?.id {
            return "New item. Listora started item \(model.itemNumber) for this photo."
        }
        return switch model.photosInItem {
        case 0: "Lay the item flat and shoot the front."
        case 1: "Now the back."
        case 2: "Then the tag, up close. Listora starts the next item on its own."
        default: "Next item when you're ready, or keep shooting details."
        }
    }
}

/// The last photo of a batch capture, with a button that removes it.
struct BatchLastShot: View {
    let shot: BatchCaptureModel.Shot?
    let onRemove: () -> Void

    var body: some View {
        if let shot {
            let shape = RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
            PhotoThumbnail(url: shot.fileURL, pointSize: 56)
                .frame(width: 56, height: 56)
                .clipShape(shape)
                .overlay(shape.strokeBorder(Palette.onMedia, lineWidth: 2))
                .overlay(alignment: .topTrailing) {
                    Button(action: onRemove) {
                        Image(systemName: "xmark.circle.fill")
                            .font(Typography.title3)
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(Palette.onMedia, Palette.scrim.color.opacity(0.8))
                            .frame(width: Layout.minimumTapTarget, height: Layout.minimumTapTarget)
                            .contentShape(Rectangle())
                    }
                    .offset(x: Spacing.md, y: -Spacing.md)
                    .accessibilityLabel("Remove last photo")
                    .accessibilityIdentifier("batchCamera.removeLast")
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Last photo")
        } else {
            Color.clear
        }
    }
}
