import DesignSystem
import ListoraAPI
import SwiftUI

/// The seller's items and their status on every marketplace, with search and filters. The list
/// is read from the server each time it appears and on pull to refresh, so a newly saved item
/// shows up right away.
public struct InventoryView: View {
    private let environment: InventoryEnvironment
    private let onAddItem: @MainActor () -> Void
    @State private var model: InventoryListModel
    @State private var path: [ItemRoute] = []

    public init(environment: InventoryEnvironment, onAddItem: @escaping @MainActor () -> Void) {
        self.environment = environment
        self.onAddItem = onAddItem
        _model = State(initialValue: environment.makeListModel())
    }

    public var body: some View {
        NavigationStack(path: $path) {
            content
                .background(Palette.background)
                .navigationTitle("Inventory")
                .searchable(text: $model.query.search, prompt: "SKU, title, or brand")
                .toolbar { ToolbarItem(placement: .topBarTrailing) { InventoryFilterMenu(model: model) } }
                .navigationDestination(for: ItemRoute.self) { route in
                    ItemDetailView(environment: environment, itemID: route.itemID)
                }
                // Runs each time the list appears (a tab switch, back from an item) and when the
                // query changes; typing waits a moment so each keystroke is not a request.
                .task(id: model.query) {
                    if !model.query.search.isEmpty {
                        try? await Task.sleep(for: .milliseconds(300))
                        guard !Task.isCancelled else { return }
                    }
                    await model.load()
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading where model.items.isEmpty:
            ProgressView("Loading inventory")
                .foregroundStyle(Palette.textSecondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .signedOut:
            EmptyStateView(
                systemImage: "person.crop.circle.badge.questionmark",
                title: "Sign in to see your inventory",
                message: "Your items and their status on every marketplace show up here once you sign in. "
                    + "You can take photos for a new item now.",
                action: .init("Add item", handler: onAddItem),
            )
            .accessibilityIdentifier("inventory.signedOut")
        case let .failed(message) where model.items.isEmpty:
            EmptyStateView(
                systemImage: "exclamationmark.triangle",
                title: "Inventory unavailable",
                message: message,
                action: .init("Try again") { Task { await model.load() } },
            )
        default:
            if model.items.isEmpty {
                empty
            } else {
                list
            }
        }
    }

    @ViewBuilder
    private var empty: some View {
        if model.isFiltered {
            EmptyStateView(
                systemImage: "line.3.horizontal.decrease.circle",
                title: "No matching items",
                message: "No item matches this search or these filters.",
                action: .init("Clear filters") { model.clearFilters() },
            )
            .accessibilityIdentifier("inventory.noMatches")
        } else {
            EmptyStateView(
                systemImage: "shippingbox",
                title: "No items yet",
                message: "Take photos once and create the item once. "
                    + "It shows up here with its status on every marketplace.",
                action: .init("Add item", handler: onAddItem),
            )
            .accessibilityIdentifier("inventory.empty")
        }
    }

    private var list: some View {
        List {
            if model.isFiltered {
                ActiveFiltersRow(model: model)
                    .listRowBackground(Palette.background.color)
            }
            ForEach(model.items, id: \.id) { item in
                NavigationLink(value: ItemRoute(itemID: item.id)) {
                    InventoryRow(item: item)
                }
                .accessibilityIdentifier("inventory.row.\(item.sku)")
                .listRowBackground(Palette.surface.color)
                .task {
                    if item.id == model.items.last?.id {
                        await model.loadMore()
                    }
                }
            }
            if model.isLoadingMore {
                ProgressView().frame(maxWidth: .infinity)
                    .listRowBackground(Palette.background.color)
            }
        }
        .scrollContentBackground(.hidden)
        .refreshable { await model.load() }
    }
}

/// An item in the navigation path.
struct ItemRoute: Hashable {
    let itemID: String
}

/// One item: cover photo, title, SKU, price, status, and its status on each marketplace.
struct InventoryRow: View {
    let item: ItemSummary

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            PhotoView(url: item.coverPhoto?.urls?.thumbnail, cornerRadius: Radius.small)
                .frame(width: 64, height: 64)
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(item.title ?? "Untitled item")
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                    .lineLimit(2)
                HStack(spacing: Spacing.xs) {
                    Text(item.sku)
                        .font(Typography.caption.monospacedDigit())
                        .foregroundStyle(Palette.textSecondary)
                    Text(item.status.label)
                        .font(Typography.caption.weight(.semibold))
                        .foregroundStyle(Palette.textSecondary)
                        .accessibilityIdentifier("inventory.row.status")
                    Spacer(minLength: 0)
                    if let price = item.listPrice {
                        Text(Formatting.money(price))
                            .font(Typography.callout.weight(.semibold).monospacedDigit())
                            .foregroundStyle(Palette.brand)
                    }
                }
                ForEach(item.listings, id: \.listingId) { listing in
                    MarketplaceBadge(listing: listing)
                }
            }
        }
        .padding(.vertical, Spacing.xxs)
        .accessibilityElement(children: .combine)
    }
}

/// "eBay: Active (confirmed by eBay)", in the status's tone.
struct MarketplaceBadge: View {
    let listing: Components.Schemas.ListingStatusSummary

    var body: some View {
        let tone = StatusLabel.Tone(listing.statusDisplay.tone)
        HStack(spacing: Spacing.xxs) {
            Text(Formatting.marketplaceName(listing.marketplace.id))
                .font(Typography.caption.weight(.semibold))
                .foregroundStyle(Palette.textPrimary)
            StatusLabel(listing.statusDisplay.label, tone: tone)
                .font(Typography.caption)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The filters in effect, each with a way to clear it.
private struct ActiveFiltersRow: View {
    let model: InventoryListModel

    var body: some View {
        HStack(spacing: Spacing.xs) {
            Image(systemName: "line.3.horizontal.decrease.circle.fill")
                .foregroundStyle(Palette.brand)
                .accessibilityHidden(true)
            Text(summary)
                .font(Typography.callout)
                .foregroundStyle(Palette.textSecondary)
                .lineLimit(2)
            Spacer(minLength: 0)
            Button("Clear") { model.clearFilters() }
                .font(Typography.callout.weight(.semibold))
                .foregroundStyle(Palette.brand)
                .buttonStyle(.borderless)
                .accessibilityIdentifier("inventory.clearFilters")
        }
    }

    private var summary: String {
        var parts: [String] = []
        if !model.query.search.isEmpty {
            parts.append("\"\(model.query.search)\"")
        }
        if let status = model.query.status {
            parts.append(status.label)
        }
        if let marketplace = model.query
            .marketplace
        {
            parts.append("On \(Formatting.marketplaceName(marketplace.rawValue))")
        }
        if let brand = model.query.brand {
            parts.append(brand)
        }
        return parts.joined(separator: " · ")
    }
}

/// Status, marketplace, and brand filters.
struct InventoryFilterMenu: View {
    @Bindable var model: InventoryListModel

    var body: some View {
        Menu {
            Picker("Status", selection: $model.query.status) {
                Text("Any status").tag(Components.Schemas.KnownItemStatus?.none)
                ForEach(Components.Schemas.KnownItemStatus.allCases, id: \.self) { status in
                    Text(status.label).tag(Optional(status))
                }
            }
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
                systemImage: model.isFiltered && model.query.search.isEmpty
                    ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle",
            )
        }
        .accessibilityIdentifier("inventory.filter")
    }
}

extension StatusLabel.Tone {
    /// The design system's style for a server tone; an unknown tone looks neutral.
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
}

#Preview {
    InventoryView(environment: .preview) {}
}
