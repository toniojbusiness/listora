import DesignSystem
import ListoraAPI
import SwiftUI

/// The seller's items and their status on every marketplace, with search and filters. The list
/// is read from the server each time it appears and on pull to refresh, so a newly saved item
/// shows up right away. `header` sits above the list, below the search field: the app's
/// banners (a marketplace connection that needs attention) come from the caller (AppFeature),
/// since a feature never imports another.
public struct InventoryView<Header: View>: View {
    private let environment: InventoryEnvironment
    private let onAddItem: @MainActor () -> Void
    private let header: Header
    @State private var model: InventoryListModel
    @State private var path: [ItemRoute] = []

    public init(
        environment: InventoryEnvironment,
        onAddItem: @escaping @MainActor () -> Void,
        @ViewBuilder header: () -> Header,
    ) {
        self.environment = environment
        self.onAddItem = onAddItem
        self.header = header()
        _model = State(initialValue: environment.makeListModel())
    }

    public var body: some View {
        NavigationStack(path: $path) {
            content
                .safeAreaInset(edge: .top, spacing: 0) { header }
                .background(Palette.background)
                .navigationTitle("Inventory")
                .searchable(text: $model.query.search, prompt: "SKU, title, or brand")
                .toolbar { ToolbarItem(placement: .topBarTrailing) { InventoryFilterMenu(model: model) } }
                .navigationDestination(for: ItemRoute.self) { route in
                    ItemDetailView(environment: environment, itemID: route.itemID)
                }
                // Runs each time the list appears (a tab switch, back from an item) and when the
                // query changes; typing waits a moment so each keystroke is not a request.
                .onAppear {
                    if let status = environment.takeRequestedStatus() {
                        path = []
                        model.query.status = status
                    }
                }
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
            loading
        case .signedOut:
            EmptyStateView(
                systemImage: "person.crop.circle.badge.questionmark",
                title: "Sign in to see your inventory",
                message: "Your items and their status on every marketplace show up here once you sign in. "
                    + "You can take photos for a new item now.",
                action: .init("Add item", systemImage: "camera.fill", handler: onAddItem),
            )
            .accessibilityIdentifier("inventory.signedOut")
        case let .failed(message) where model.items.isEmpty:
            EmptyStateView(
                systemImage: "exclamationmark.triangle",
                tone: .failed,
                title: "Inventory unavailable",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await model.load() } },
            )
        default:
            if model.items.isEmpty {
                empty
            } else {
                list
            }
        }
    }

    private var loading: some View {
        ScrollView {
            VStack(spacing: Spacing.sm) {
                ForEach(0 ..< 5, id: \.self) { _ in
                    SkeletonRow().cardStyle(.outlined)
                }
            }
            .padding(Spacing.md)
        }
        .scrollDisabled(true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading inventory")
    }

    @ViewBuilder
    private var empty: some View {
        if model.isFiltered {
            EmptyStateView(
                systemImage: "line.3.horizontal.decrease.circle",
                title: "No matching items",
                message: "No item matches this search or these filters.",
                action: .init("Clear filters", systemImage: "xmark.circle") { model.clearFilters() },
            )
            .accessibilityIdentifier("inventory.noMatches")
        } else {
            EmptyStateView(
                systemImage: "shippingbox",
                title: "No items yet",
                message: "Create an item once, and see where it's listed and what sold on every marketplace.",
                steps: [
                    "Take photos of the item",
                    "Check the details Listora suggests",
                    "List it on your marketplaces",
                ],
                action: .init("Add item", systemImage: "camera.fill", handler: onAddItem),
            )
            .accessibilityIdentifier("inventory.empty")
        }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Spacing.sm) {
                if model.isFiltered {
                    ActiveFilters(model: model)
                }
                ForEach(model.items, id: \.id) { item in
                    NavigationLink(value: ItemRoute(itemID: item.id)) {
                        InventoryRow(item: item)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("inventory.row.\(item.sku)")
                    .task {
                        if item.id == model.items.last?.id {
                            await model.loadMore()
                        }
                    }
                }
                if model.isLoadingMore {
                    SkeletonRow().cardStyle(.outlined)
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await model.load() }
    }
}

/// An item in the navigation path.
struct ItemRoute: Hashable {
    let itemID: String
}

/// One item: cover photo, title, SKU, status, price, and its status on each marketplace.
struct InventoryRow: View {
    let item: ItemSummary

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            PhotoView(url: item.coverPhoto?.urls?.thumbnail, cornerRadius: Radius.small)
                .frame(width: 72, height: 72)
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                    Text(item.title ?? "Untitled item")
                        .font(Typography.headline)
                        .foregroundStyle(Palette.textPrimary)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let price = item.listPrice {
                        Text(Formatting.money(price))
                            .font(Typography.price)
                            .foregroundStyle(Palette.brand)
                    }
                }
                Text("\(item.sku) · \(item.status.label)")
                    .font(Typography.footnote.monospacedDigit())
                    .foregroundStyle(Palette.textSecondary)
                if !item.listings.isEmpty {
                    FlowLayout(spacing: Spacing.xs, lineSpacing: Spacing.xs) {
                        ForEach(item.listings, id: \.listingId) { listing in
                            MarketplaceBadge(listing: listing)
                        }
                    }
                    .padding(.top, Spacing.xxs)
                }
            }
            Image(systemName: "chevron.right")
                .font(Typography.footnote.weight(.semibold))
                .foregroundStyle(Palette.textSecondary)
                .padding(.top, Spacing.xxs)
                .accessibilityHidden(true)
        }
        .cardStyle(.outlined, padding: Spacing.sm)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// "eBay" and the listing's status pill, exactly as the server words it.
struct MarketplaceBadge: View {
    let listing: Components.Schemas.ListingStatusSummary

    var body: some View {
        HStack(spacing: Spacing.xxs) {
            Text(Formatting.marketplaceName(listing.marketplace.id))
                .font(Typography.label)
                .foregroundStyle(Palette.textPrimary)
            StatusBadge(listing.statusDisplay.label, tone: StatusTone(listing.statusDisplay.tone))
        }
        .accessibilityElement(children: .combine)
    }
}

/// The filters in effect as chips, with a way to clear them.
private struct ActiveFilters: View {
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
        if let status = model.query.status {
            chips.append(status.label)
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

extension InventoryView where Header == EmptyView {
    /// Inventory without a header.
    public init(environment: InventoryEnvironment, onAddItem: @escaping @MainActor () -> Void) {
        self.init(environment: environment, onAddItem: onAddItem) { EmptyView() }
    }
}

#Preview {
    InventoryView(environment: .preview) {}
}
