import DesignSystem
import ListoraAPI
import SwiftUI

/// The bulk change on screen, with the kind it was opened for.
struct BulkSheet: Identifiable {
    let kind: BulkActionKind
    let model: BulkActionModel

    var id: ObjectIdentifier {
        model.id
    }
}

/// The list's order, then one tap to the items that need the seller, the drafts, what's not
/// listed yet, listed, sold, or archived. "Needs you" carries how many items need the seller.
struct QuickFilters: View {
    @Bindable var model: InventoryListModel
    let attention: InventoryAttention

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Spacing.xs) {
                SortMenu(selection: $model.query.sort, options: ItemSort.allCases, title: \.title)
                    .accessibilityIdentifier("inventory.sort")
                ForEach(InventoryFilter.allCases) { filter in
                    ChoiceChip(
                        title(of: filter),
                        systemImage: filter.systemImage,
                        isSelected: model.query.filter == filter,
                    ) {
                        Motion.perform { model.query.filter = filter }
                    }
                    .accessibilityIdentifier("inventory.filter.\(filter.rawValue)")
                }
            }
            .padding(.horizontal, Spacing.md)
        }
        .scrollClipDisabled()
        .padding(.bottom, Spacing.xxs)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Show")
    }

    private func title(of filter: InventoryFilter) -> String {
        guard filter == .needsYou, attention.total != 0 else { return filter.title }
        return "\(filter.title) (\(attention.total)\(attention.hasMore ? "+" : ""))"
    }
}

/// The actions for the chosen items, in the tab bar's place.
struct SelectionBar: View {
    let chosen: Int
    let open: (BulkActionKind) -> Void

    var body: some View {
        BottomActionBar {
            // The title counts the chosen items; until there are some, say how to choose them.
            if chosen == 0 {
                Text("Tap items to choose them")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityIdentifier("inventory.selectionHint")
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Spacing.xs) { buttons }
                VStack(spacing: Spacing.xs) { buttons }
            }
        }
    }

    /// One button per kind, written out rather than a ForEach: ViewThatFits builds the rows it
    /// measures on SwiftUI's render thread at times, where a ForEach's main-actor content stops
    /// the app (`ActionButtons.secondary`).
    @ViewBuilder
    private var buttons: some View {
        button(.list)
        button(.changePrice)
        button(.end)
        button(.relist)
        button(.delete)
    }

    private func button(_ kind: BulkActionKind) -> some View {
        Button { open(kind) } label: {
            VStack(spacing: Spacing.xxs) {
                Image(systemName: kind.systemImage)
                    .font(Typography.headline)
                Text(kind.buttonTitle)
                    .font(Typography.smallEmphasis)
                    .lineLimit(1)
            }
            .foregroundStyle(kind == .delete ? Palette.danger : Palette.brand)
            .frame(maxWidth: .infinity, minHeight: Layout.minimumTapTarget)
            .contentShape(Rectangle())
            .opacity(chosen == 0 ? 0.45 : 1)
        }
        .buttonStyle(.plain)
        .disabled(chosen == 0)
        .accessibilityLabel(kind.accessibilityLabel)
        .accessibilityIdentifier("inventory.bulk.\(kind.rawValue)")
    }
}

/// The filters in effect as chips, with a way to clear them.
struct ActiveFilters: View {
    let model: InventoryListModel

    var body: some View {
        HStack(alignment: .center, spacing: Spacing.xs) {
            FlowLayout(spacing: Spacing.xs, lineSpacing: Spacing.xs) {
                ForEach(chips, id: \.self) { chip in
                    Chip(chip, prominent: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button("Clear") { model.clearFilters() }
                .buttonStyle(.listora(.tertiary, size: .compact))
                .fixedSize()
                .accessibilityIdentifier("inventory.clearFilters")
        }
        .accessibilityElement(children: .contain)
    }

    private var chips: [String] {
        var chips: [String] = []
        if !model.query.search.isEmpty {
            chips.append("\"\(model.query.search)\"")
        }
        if let marketplace = model.query.marketplace {
            chips.append("On \(Formatting.marketplaceName(marketplace.rawValue))")
        }
        if let brand = model.query.brand {
            chips.append(brand)
        }
        return chips
    }
}

/// Marketplace and brand filters (the status is in the quick filters above the list).
struct InventoryFilterMenu: View {
    @Bindable var model: InventoryListModel

    var body: some View {
        Menu {
            Picker("Marketplace", selection: $model.query.marketplace) {
                Text("Any marketplace").tag(KnownMarketplace?.none)
                ForEach(KnownMarketplace.allCases, id: \.self) { marketplace in
                    Text("On \(Formatting.marketplaceName(marketplace.rawValue))").tag(Optional(marketplace))
                }
            }
            if !model.brands.isEmpty || model.query.brand != nil {
                Picker("Brand", selection: $model.query.brand) {
                    Text("Any brand").tag(String?.none)
                    ForEach(model.brands, id: \.self) { brand in
                        Text(brand).tag(Optional(brand))
                    }
                }
            }
        } label: {
            Label(
                "Filter",
                systemImage: model.query.marketplace != nil || model.query.brand != nil
                    ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle",
            )
        }
        .accessibilityIdentifier("inventory.filter")
    }
}

extension StatusTone {
    /// The design system's tone for a server tone; an unknown tone looks neutral.
    init(_ tone: Components.Schemas.StatusTone) {
        switch tone.value1 {
        case .success: self = .success
        case .inProgress: self = .inProgress
        case .checking: self = .checking
        case .failed: self = .failed
        case .actionNeeded: self = .actionNeeded
        case .neutral, nil: self = .neutral
        }
    }

    init(_ tone: MarketplaceRowState.Tone) {
        switch tone {
        case .success: self = .success
        case .inProgress: self = .inProgress
        case .checking: self = .checking
        case .failed: self = .failed
        case .actionNeeded: self = .actionNeeded
        case .neutral: self = .neutral
        }
    }
}
