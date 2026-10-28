import DesignSystem
import SwiftUI

/// One thing that needs the seller, as a tag on the day's string: the item's photo (or the card's
/// mark stamped on the tag), how urgent it is as a stamp, the server's words for it, its facts as
/// labels, and one action that opens the right screen.
struct TodayCardView: View {
    let card: TodayCardContent
    let onAction: @MainActor (TodayDestination) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .top, spacing: Spacing.sm) {
                leading
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    if card.urgency != nil || card.status != nil {
                        FlowLayout(spacing: Spacing.xs, lineSpacing: Spacing.xxs) {
                            if let urgency = card.urgency {
                                Stamp(urgency.label, tone: urgency.tone)
                            }
                            if let status = card.status {
                                StatusBadge(status.label, tone: status.tone)
                            }
                        }
                        .padding(.bottom, Spacing.xxs)
                    }
                    Text(card.title)
                        .font(Typography.headline)
                        .foregroundStyle(Palette.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail = card.detail {
                        Text(detail)
                            .font(Typography.subheadline)
                            .foregroundStyle(Palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .combine)
            if !card.facts.isEmpty {
                FlowLayout(spacing: Spacing.xs, lineSpacing: Spacing.xs) {
                    ForEach(card.facts, id: \.self) { fact in
                        if let tone = fact.tone {
                            StatusBadge(fact.text, tone: tone)
                        } else {
                            Chip(fact.text, systemImage: fact.systemImage)
                        }
                    }
                }
                .accessibilityElement(children: .combine)
            }
            if let action = card.action {
                Button(action.label) { onAction(action.destination) }
                    .buttonStyle(ListoraButtonStyle(card.urgency?.tone == .actionNeeded ? .primary : .secondary))
                    .accessibilityIdentifier("today.action.\(card.id)")
            }
        }
        .tagStyle()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("today.card.\(card.id)")
    }

    @ViewBuilder
    private var leading: some View {
        if let url = card.thumbnailURL {
            RemoteImage(url: url) {
                Image(systemName: card.systemImage)
                    .font(Typography.title3)
                    .foregroundStyle(Palette.textSecondary)
            }
            .frame(width: StampMark.side, height: StampMark.side)
            .background(Palette.surfaceSecondary.color)
            .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .accessibilityHidden(true)
        } else {
            StampMark(systemImage: card.systemImage, tone: card.iconTone)
        }
    }
}
