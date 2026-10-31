import Core
import DesignSystem
import ListoraAPI
import SwiftUI

/// The item's details and where it is kept. The size can be changed here: marketplaces refuse a
/// clothing or shoe listing without one, so a seller who skipped it can still list the item.
struct DetailsSection: View {
    let item: Item
    /// Puts the item in a bin; nil shows the bin without a way to change it.
    var chooseBin: (() -> Void)?
    let editSize: () -> Void

    var body: some View {
        DetailSection(title: "Details") {
            binRow
            if let brand = item.details.brand {
                LabeledRow("Brand", value: brand)
            }
            Button(action: editSize) {
                HStack(spacing: Spacing.xs) {
                    LabeledRow("Size", value: item.details.sizeLabel ?? "Add size")
                    Image(systemName: "chevron.forward")
                        .font(Typography.smallEmphasis)
                        .foregroundStyle(Palette.textSecondary)
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Size, \(item.details.sizeLabel ?? "not set")")
            .accessibilityHint("Changes the size")
            .accessibilityIdentifier("item.size")
            if let condition = item.details.condition {
                LabeledRow("Condition", value: condition.label)
            }
            if let colors = item.details.colors, !colors.isEmpty {
                LabeledRow("Colors", value: colors.map(VocabularyName.humanize).joined(separator: ", "))
            }
            if let materials = item.details.materials, !materials.isEmpty {
                LabeledRow("Materials", value: materials.map(VocabularyName.humanize).joined(separator: ", "))
            }
            if let description = item.details.description, !description.isEmpty {
                Text(description)
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, Spacing.xxs)
            }
        }
    }
}

extension DetailsSection {
    /// "Bin  B-12 · Garage shelf 3", which opens the bin picker; "Put in a bin" when it is in none.
    @ViewBuilder
    private var binRow: some View {
        let value = item.storageLocation.map { bin in
            bin.label == bin.code ? bin.code : "\(bin.code) · \(bin.label)"
        }
        if let chooseBin {
            Button(action: chooseBin) {
                HStack(spacing: Spacing.xs) {
                    LabeledRow("Bin", value: value ?? "Put in a bin")
                    Image(systemName: "chevron.forward")
                        .font(Typography.smallEmphasis)
                        .foregroundStyle(Palette.textSecondary)
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Bin, \(value ?? "none")")
            .accessibilityHint("Scan a bin sticker or pick a bin")
            .accessibilityIdentifier("item.storage")
        } else {
            LabeledRow("Bin", value: value ?? "None")
                .accessibilityIdentifier("item.storage")
        }
    }
}

extension BinRequest {
    /// Putting this item in a bin, from the bin it is in.
    init(_ item: Item) {
        self.init(
            itemIDs: [item.id],
            current: item.storageLocation.map { BinChoice(id: $0.id, code: $0.code) },
        )
    }
}

extension View {
    /// The bin picker for `request` while it is set; `onDone` runs once the bin changed.
    func binPickerSheet(
        _ request: Binding<BinRequest?>,
        picker: (@MainActor (BinRequest, @escaping @MainActor (BinChoice?) -> Void) -> AnyView)?,
        onDone: @escaping @MainActor () -> Void,
    ) -> some View {
        sheet(item: request) { shown in
            picker?(shown) { _ in
                request.wrappedValue = nil
                onDone()
            }
        }
    }
}
