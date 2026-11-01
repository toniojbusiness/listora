import DesignSystem
import SwiftUI

/// One marketplace's copy in the review: its title and whether the seller edited it.
struct CopyRow: View {
    let copy: MarketplaceCopy

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            IconTile(monogram: String(copy.name.prefix(1)))
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                HStack(spacing: Spacing.xs) {
                    Text(copy.name)
                        .font(Typography.headline)
                        .foregroundStyle(Palette.textPrimary)
                    if copy.edited != nil {
                        Chip("Edited", systemImage: "pencil", prominent: true)
                    }
                }
                Text(copy.hasTitle ? copy.current.title : copy.current.description)
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .lineLimit(2)
                if let problem = copy.problems.first {
                    Label(problem, systemImage: StatusTone.failed.systemImage)
                        .font(Typography.smallEmphasis)
                        .foregroundStyle(Palette.danger)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right")
                .font(Typography.smallEmphasis)
                .foregroundStyle(Palette.textSecondary)
                .frame(minHeight: 36)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, Spacing.sm)
        .frame(minHeight: Layout.minimumTapTarget)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Edits the copy for \(copy.name)")
    }
}
