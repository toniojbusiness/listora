import DesignSystem
import ListoraAPI
import SwiftUI

/// The seller's items and their status on every marketplace, with search and filters, as a grid
/// of large photos or as a list (``InventoryLayout``). The items are read from the server each
/// time the screen appears and on pull to refresh, so a newly saved item shows up right away.
/// `header` sits above the list, below the search
/// field: the app's banners (a marketplace connection that needs attention) come from the caller
/// (AppFeature), since a feature never imports another.
public struct InventoryView<Header: View>: View {
    private let environment: InventoryEnvironment
    private let onAddItem: @MainActor () -> Void
    private let header: Header
    @State private var model: InventoryListModel
    @State private var path: [ItemRoute] = []
    @State private var bulk: BulkSheet?
    @AppStorage(InventoryLayout.storageKey) private var layout = InventoryLayout.standard
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
                .safeAreaInset(edge: .top, spacing: 0) {
                    VStack(spacing: 0) {
                        if model.phase != .signedOut {
                            QuickFilters(model: model, attention: environment.attention)
                        }
                        header
                    }
                }
                .background(Palette.background)
                .navigationTitle(model.isSelecting ? selectionTitle : "Inventory")
                .navigationBarTitleDisplayMode(model.isSelecting ? .inline : .automatic)
                // Always shown: the quick filters under it would otherwise collapse it out of sight.
                .searchable(
                    text: $model.query.search,
                    placement: .navigationBarDrawer(displayMode: .always),
                    prompt: "SKU, title, or brand",
                )
                .toolbar { toolbar }
                // While choosing items the selection bar takes the tab bar's place.
                .toolbar(model.isSelecting ? .hidden : .automatic, for: .tabBar)
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if model.isSelecting {
                        SelectionBar(chosen: model.selection.count) { kind in
                            bulk = BulkSheet(
                                kind: kind,
                                model: environment.makeBulkAction(items: model.selectedItems),
                            )
                        }
                        .transition(.move(edge: .bottom))
                    }
                }
                .sheet(item: $bulk, onDismiss: {
                    model.stopSelecting()
                    Task {
                        await model.load()
                        await environment.attention.refresh()
                    }
                }, content: { sheet in
                    BulkActionSheet(model: sheet.model, kind: sheet.kind) { bulk = nil }
                })
                .navigationDestination(for: ItemRoute.self) { route in
                    // A standard push: a zoom transition would close the item on the pull-down
                    // that refreshes it.
                    ItemDetailView(
                        environment: environment,
                        itemID: route.itemID,
                        listsEverywhere: route.listsEverywhere,
                    )
                }
                // Runs each time the list appears (a tab switch, back from an item) and when the
                // query changes; typing waits a moment so each keystroke is not a request.
                .onAppear {
                    if let itemID = environment.takeRequestedItem() {
                        model.stopSelecting()
                        path = [ItemRoute(itemID: itemID, listsEverywhere: true)]
                    }
                    if let filter = environment.takeRequestedFilter() {
                        path = []
                        model.stopSelecting()
                        model.query.filter = filter
                    }
                }
                .task(id: model.query) {
                    if !model.query.search.isEmpty {
                        try? await Task.sleep(for: .milliseconds(300))
                        guard !Task.isCancelled else { return }
                    }
                    await model.load()
                    await environment.attention.refresh()
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
        if model.query == InventoryQuery(filter: .needsYou) {
            EmptyStateView(
                systemImage: "checkmark.circle",
                tone: .success,
                title: "Nothing needs you",
                message: "Every listing is going fine. An item shows up here when a change fails or waits for you.",
                action: .init("Show all items", systemImage: "square.grid.2x2") { model.clearFilters() },
            )
            .accessibilityIdentifier("inventory.nothingNeedsYou")
        } else if model.isFiltered {
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
                if model.hasMenuFilters {
                    ActiveFilters(model: model)
                }
                switch layout {
                case .grid:
                    LazyVGrid(columns: gridColumns, alignment: .leading, spacing: Spacing.lg) {
                        ForEach(model.items, id: \.id) { item in
                            link(to: item) { InventoryGridCell(
                                item: item,
                                isSelecting: model.isSelecting,
                                isSelected: model.selection.contains(item.id),
                            ) }
                        }
                        if model.isLoadingMore {
                            SkeletonPhotoTile()
                        }
                    }
                case .list:
                    LazyVStack(alignment: .leading, spacing: Spacing.sm) {
                        ForEach(model.items, id: \.id) { item in
                            link(to: item) { InventoryRow(
                                item: item,
                                isSelecting: model.isSelecting,
                                isSelected: model.selection.contains(item.id),
                            ) }
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
}

/// Select mode: the toolbar while choosing, and what a tap on an item does.
extension InventoryView {
    private var selectionTitle: String {
        model.selection.isEmpty ? "Select items" : "\(model.selection.count) selected"
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if model.isSelecting {
            ToolbarItem(placement: .topBarLeading) {
                Button(model.allSelected ? "Deselect all" : "Select all") { model.toggleAll() }
                    .accessibilityIdentifier("inventory.selectAll")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") { Motion.perform { model.stopSelecting() } }
                    .accessibilityIdentifier("inventory.selectDone")
            }
        } else {
            // Only with items to lay out, or to choose from.
            if !model.items.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Select") { Motion.perform { model.startSelecting() } }
                        .accessibilityIdentifier("inventory.select")
                }
                ToolbarItem(placement: .topBarTrailing) { layoutButton }
            }
            ToolbarItem(placement: .topBarTrailing) { InventoryFilterMenu(model: model) }
        }
    }

    /// An item's cell or row, opening the item (or, while selecting, choosing it), and loading the
    /// next page when the last one appears. A long press starts selecting with the item.
    private func link(to item: ItemSummary, @ViewBuilder label: () -> some View) -> some View {
        Group {
            if model.isSelecting {
                Button { model.toggle(item.id) } label: { label() }
                    .accessibilityAddTraits(model.selection.contains(item.id) ? .isSelected : [])
                    .sensoryFeedback(.selection, trigger: model.selection.contains(item.id))
            } else {
                NavigationLink(value: ItemRoute(itemID: item.id)) { label() }
                    .contextMenu {
                        Button("Select", systemImage: "checkmark.circle") {
                            Motion.perform { model.startSelecting(with: item.id) }
                        }
                    }
            }
        }
        .buttonStyle(.plain)
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
    /// Opens List everywhere once the item has loaded (List it now, after saving it).
    var listsEverywhere = false
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
