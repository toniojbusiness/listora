import DesignSystem
import ListoraAPI
import SwiftUI

/// The seller's items and their status on every marketplace, with search and filters, as a grid
/// of large photos or as a list (``InventoryLayout``). The items are read from the server each
/// time the screen appears and on pull to refresh, so a newly saved item shows up right away.
/// An item opens with a zoom from its photo. `header` sits above the list, below the search
/// field: the app's banners (a marketplace connection that needs attention) come from the caller
/// (AppFeature), since a feature never imports another.
public struct InventoryView<Header: View>: View {
    private let environment: InventoryEnvironment
    private let onAddItem: @MainActor () -> Void
    private let header: Header
    @State private var model: InventoryListModel
    @State private var path: [ItemRoute] = []
    @AppStorage(InventoryLayout.storageKey) private var layout = InventoryLayout.standard
    @Namespace private var itemTransition
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

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
                .toolbar {
                    // Only with items to lay out.
                    if !model.items.isEmpty {
                        ToolbarItem(placement: .topBarTrailing) { layoutButton }
                    }
                    ToolbarItem(placement: .topBarTrailing) { InventoryFilterMenu(model: model) }
                }
                .navigationDestination(for: ItemRoute.self) { route in
                    ItemDetailView(environment: environment, itemID: route.itemID)
                        .navigationTransition(.zoom(sourceID: route.itemID, in: itemTransition))
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

    private var layoutButton: some View {
        Button {
            Motion.perform { layout = layout.other }
        } label: {
            Label(layout.switchTitle, systemImage: layout.switchSystemImage)
        }
        .sensoryFeedback(.selection, trigger: layout)
        .accessibilityIdentifier("inventory.layout")
    }

    /// One column at accessibility sizes, so titles and statuses keep their full width; otherwise
    /// as many columns of at least 150 points as fit (two on every iPhone).
    private var gridColumns: [GridItem] {
        if dynamicTypeSize.isAccessibilitySize {
            [GridItem(.flexible())]
        } else {
            [GridItem(.adaptive(minimum: 150), spacing: Spacing.md, alignment: .top)]
        }
    }

    private var content: some View {
        phaseContent
            .motion(value: model.phase)
            .motion(value: layout)
    }

    @ViewBuilder
    private var phaseContent: some View {
        switch model.phase {
        case .loading where model.items.isEmpty:
            loading
        case .signedOut:
            EmptyStateView(
                systemImage: "person.crop.circle.badge.questionmark",
                title: "Sign in to see your inventory",
                message: "Your items and their status on every marketplace show up here once you sign in.",
                action: .init("Sign in", systemImage: "person.crop.circle", handler: environment.onSignIn),
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

    @ViewBuilder
    private var loading: some View {
        switch layout {
        case .grid:
            ScrollView {
                LazyVGrid(columns: gridColumns, spacing: Spacing.lg) {
                    ForEach(0 ..< 6, id: \.self) { _ in
                        SkeletonPhotoTile()
                    }
                }
                .padding(Spacing.md)
            }
            .scrollDisabled(true)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Loading inventory")
        case .list:
            SkeletonList(label: "Loading inventory")
        }
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
            VStack(alignment: .leading, spacing: Spacing.md) {
                if model.isFiltered {
                    ActiveFilters(model: model)
                }
                switch layout {
                case .grid:
                    LazyVGrid(columns: gridColumns, alignment: .leading, spacing: Spacing.lg) {
                        ForEach(model.items, id: \.id) { item in
                            link(to: item) { InventoryGridCell(item: item) }
                        }
                        if model.isLoadingMore {
                            SkeletonPhotoTile()
                        }
                    }
                case .list:
                    LazyVStack(alignment: .leading, spacing: Spacing.sm) {
                        ForEach(model.items, id: \.id) { item in
                            link(to: item) { InventoryRow(item: item) }
                        }
                        if model.isLoadingMore {
                            SkeletonRow().cardStyle(.flat)
                        }
                    }
                    .frame(maxWidth: Layout.readableWidth)
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(Spacing.md)
        }
        .refreshable { await model.load() }
    }

    /// An item's cell or row, opening the item with a zoom from it, and loading the next page when
    /// the last one appears.
    private func link(to item: ItemSummary, @ViewBuilder label: () -> some View) -> some View {
        NavigationLink(value: ItemRoute(itemID: item.id)) {
            label()
        }
        .buttonStyle(.plain)
        .matchedTransitionSource(id: item.id, in: itemTransition)
        .accessibilityIdentifier("inventory.row.\(item.sku)")
        .task {
            if item.id == model.items.last?.id {
                await model.loadMore()
            }
        }
    }
}

/// An item in the navigation path.
struct ItemRoute: Hashable {
    let itemID: String
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
