import DesignSystem
import SwiftUI

/// One price to choose: the server's label, the price in large tabular digits so the options
/// line up, and a warning when it is below a marketplace's floor.
struct PriceOption: View {
    let title: String
    let price: String
    let warning: String?
    let isSelected: Bool
    let identifier: String
    let action: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.large, style: .continuous)
        Button(action: action) {
            HStack(alignment: .center, spacing: Spacing.sm) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(Typography.title3)
                    .foregroundStyle(isSelected ? Palette.brand : Palette.textSecondary)
                    .accessibilityHidden(true)
                // Prices stay in one column on the right, so options compare at a glance; at
                // accessibility sizes the price goes under the label instead of breaking.
                let layout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.xxs))
                    : AnyLayout(HStackLayout(alignment: .center, spacing: Spacing.sm))
                layout {
                    labels.frame(maxWidth: .infinity, alignment: .leading)
                    priceText
                }
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.sm)
            .frame(minHeight: Layout.buttonHeight + Spacing.xs)
            .background(isSelected ? Palette.brandSoft : Palette.surface, in: shape)
            .overlay(shape.strokeBorder(isSelected ? Palette.brand : Palette.separator, lineWidth: isSelected ? 2 : 1))
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier(identifier)
        .sensoryFeedback(.selection, trigger: isSelected) { _, selected in selected }
    }

    private var labels: some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            Text(title)
                .font(Typography.body)
                .foregroundStyle(Palette.textPrimary)
            if let warning {
                Label(warning, systemImage: "exclamationmark.triangle.fill")
                    .font(Typography.smallEmphasis)
                    .foregroundStyle(Palette.warning)
            }
        }
    }

    private var priceText: some View {
        Text(price)
            .font(Typography.price)
            .foregroundStyle(Palette.textPrimary)
            .fixedSize()
    }
}

/// One marketplace's floor, marked against the chosen price; tap to see how it adds up.
struct FloorRow: View {
    let floor: PricingPresentation.Floor
    let chosenCents: Int64?
    @State private var isExpanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var isBelow: Bool {
        chosenCents.map { $0 < floor.cents } ?? false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(Motion.animation(Motion.snappy, reduceMotion: reduceMotion)) {
                    isExpanded.toggle()
                }
            } label: {
                // At accessibility sizes the price and chevron go under the name.
                let layout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.xs))
                    : AnyLayout(HStackLayout(spacing: Spacing.sm))
                layout {
                    HStack(spacing: Spacing.sm) {
                        IconTile(monogram: String(floor.name.prefix(1)), tone: isBelow ? .actionNeeded : nil)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(floor.name)
                                .font(Typography.headline)
                                .foregroundStyle(Palette.textPrimary)
                            if isBelow {
                                Text("Your price is below this")
                                    .font(Typography.smallEmphasis)
                                    .foregroundStyle(Palette.warning)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    HStack(spacing: Spacing.sm) {
                        Text(floor.price)
                            .font(Typography.price)
                            .foregroundStyle(Palette.textPrimary)
                            .fixedSize()
                        Image(systemName: "chevron.down")
                            .font(Typography.smallEmphasis)
                            .foregroundStyle(Palette.textSecondary)
                            .rotationEffect(.degrees(isExpanded ? 180 : 0))
                            .accessibilityHidden(true)
                    }
                }
                .padding(.horizontal, Spacing.md)
                .padding(.vertical, Spacing.xs)
                .frame(minHeight: Layout.buttonHeight)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                "\(floor.name), don't sell below \(floor.price)" + (isBelow ? ". Your price is below this" : ""),
            )
            .accessibilityHint(isExpanded ? "Hides how it adds up" : "Shows how it adds up")
            .accessibilityIdentifier("price.floor.\(floor.marketplace)")
            if isExpanded {
                breakdown
                    .transition(.opacity)
            }
        }
    }

    private var breakdown: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            ForEach(floor.breakdown, id: \.label) { line in
                HStack {
                    Text(line.label)
                    Spacer()
                    Text(line.amount).monospacedDigit()
                }
                .font(Typography.subheadline)
                .foregroundStyle(Palette.textSecondary)
                .accessibilityElement(children: .combine)
            }
            Divider().overlay(Palette.separator.color)
            HStack {
                Text("Don't sell below")
                Spacer()
                Text(floor.price).monospacedDigit()
            }
            .font(Typography.emphasis)
            .foregroundStyle(Palette.textPrimary)
            .accessibilityElement(children: .combine)
            Text(floor.feeNote)
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
        }
        .padding(Spacing.sm)
        .background(Palette.surfaceSecondary, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        .padding(.horizontal, Spacing.md)
        .padding(.bottom, Spacing.sm)
    }
}

/// While the prices load: the shape of the price options and floors.
struct PriceSkeleton: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SectionHeader("Choose a price")
                ForEach(0 ..< 3, id: \.self) { _ in
                    HStack(spacing: Spacing.sm) {
                        SkeletonBlock(width: 24, height: 24, cornerRadius: 12)
                        SkeletonBlock(width: 160, height: 16)
                        Spacer()
                        SkeletonBlock(width: 72, height: 20)
                    }
                    .cardStyle(.flat)
                }
                SectionHeader("Don't sell below").padding(.top, Spacing.sm)
                VStack(spacing: Spacing.md) {
                    ForEach(0 ..< 4, id: \.self) { _ in
                        HStack(spacing: Spacing.sm) {
                            SkeletonBlock(width: 36, height: 36, cornerRadius: Radius.small)
                            SkeletonBlock(width: 96, height: 16)
                            Spacer()
                            SkeletonBlock(width: 64, height: 20)
                        }
                    }
                }
                .cardStyle(.flat)
            }
            .padding(Spacing.md)
        }
        .scrollDisabled(true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Working out prices")
        .accessibilityIdentifier("price.loading")
    }
}
