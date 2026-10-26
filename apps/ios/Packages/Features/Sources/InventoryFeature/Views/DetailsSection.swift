import Core
import DesignSystem
import ListoraAPI
import SwiftUI

/// The item's details and where it is kept. The size can be changed here: marketplaces refuse a
/// clothing or shoe listing without one, so a seller who skipped it can still list the item.
struct DetailsSection: View {
    let item: Item
    let editSize: () -> Void

    var body: some View {
        DetailSection(title: "Details") {
            LabeledRow(
                "Storage location",
                value: item.storageLocation.map { "\($0.label) (\($0.code))" } ?? "Not set",
            )
            .accessibilityIdentifier("item.storage")
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
