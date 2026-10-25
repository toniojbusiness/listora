import Core
import DesignSystem
import ListoraAPI
import SwiftUI

/// One item: photos, details, cost and profit, storage location, and its marketplaces, each with
/// the listing's status exactly as the server words it, its actions, and its history. While a
/// change runs the screen keeps reading the server, so the status follows the operation engine.
struct ItemDetailView: View {
    private let environment: InventoryEnvironment
    @State private var model: ItemDetailModel
    @State private var listingFlow: ListingFlowModel?
    @State private var priceChange: PriceChange?
    @State private var ending: MarketplaceRowState?
    @State private var markingSold: MarkSoldRequest?
    @State private var openSale: SaleLink?
    @State private var openTask: OpenTask?

    /// The assisted step whose task is open.
    private struct OpenTask: Identifiable {
        let operationID: String

        var id: String {
            operationID
        }
    }

    init(environment: InventoryEnvironment, itemID: String) {
        self.environment = environment
        _model = State(initialValue: environment.makeDetailModel(itemID: itemID))
    }

    var body: some View {
        content
            .background(Palette.background)
            .navigationTitle(model.item?.sku ?? "Item")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                await model.load()
                await model.followChanges()
            }
            .refreshable { await model.load() }
            .sheet(
                item: $listingFlow,
                onDismiss: { Task { await model.refresh() } },
                content: { flow in ListingFlowView(model: flow) { listingFlow = nil } },
            )
            .sheet(
                item: $markingSold,
                onDismiss: { Task { await model.refresh() } },
                content: { request in
                    environment.saleScreens?.markSold(request) { saleID in openSale = SaleLink(id: saleID) }
                },
            )
            .navigationDestination(item: $openSale) { link in
                environment.saleScreens?.sale(link.id)
                    .onDisappear { Task { await model.refresh() } }
            }
            .sheet(item: $openTask, onDismiss: { Task { await model.refresh() } }, content: { task in
                if let destination = environment.taskDestination {
                    destination(model.itemID, task.operationID) { openTask = nil }
                }
            })
            .sheet(item: $priceChange) { change in
                PriceChangeView(change: change) { price in
                    priceChange = nil
                    Task {
                        await model.perform(
                            .changePrice(listingID: change.listingID, price: price),
                            marketplace: change.marketplace,
                        )
                    }
                }
            }
            .confirmationDialog(
                "End the \(ending?.name ?? "") listing?",
                isPresented: Binding(get: { ending != nil }, set: {
                    if !$0 {
                        ending = nil
                    }
                }),
                titleVisibility: .visible,
                presenting: ending,
            ) { row in
                ForEach(EndReason.allCases) { reason in
                    Button(reason.title, role: .destructive) { end(row, reason: reason) }
                        .accessibilityIdentifier("end.\(reason.rawValue)")
                }
                Button("Keep it listed", role: .cancel) {}
            } message: { row in
                if row.listing?.mode.value1 == .api || row.listing?.mode.value1 == .automation {
                    Text("Listora ends it on \(row.name) and shows it as delisted once \(row.name) confirms.")
                } else {
                    Text("You end it in the \(row.name) app: Listora adds a task with a link to the listing.")
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading where model.item == nil:
            loading
        case let .failed(message) where model.item == nil:
            EmptyStateView(
                systemImage: "exclamationmark.triangle",
                tone: .failed,
                title: "Item unavailable",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await model.load() } },
            )
        default:
            if let item = model.item {
                details(of: item)
            }
        }
    }

    private var loading: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.md) {
                SkeletonBlock(height: 240, cornerRadius: Radius.large)
                SkeletonBlock(width: 220, height: 22)
                SkeletonRow().cardStyle()
                SkeletonRow().cardStyle()
            }
            .padding(Spacing.md)
        }
        .scrollDisabled(true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading item")
    }

    private func details(of item: Item) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    PhotoCarousel(photos: item.photos)
                    ItemHeader(item: item)
                }
                if let notice = model.notice {
                    Banner(
                        "That didn't go through",
                        message: notice,
                        tone: .failed,
                        onDismiss: { model.notice = nil },
                        identifier: "item.notice",
                    )
                    .transition(.rise)
                }
                saleBanners(of: item)
                MarketplacesSection(
                    rows: model.rows,
                    histories: model.histories,
                    events: model.events,
                    busyMarketplace: model.busyMarketplace,
                    perform: perform,
                    loadEvents: { id in await model.loadEvents(operationID: id) },
                )
                MoneySection(item: item)
                markSoldButton(for: item)
                DetailsSection(item: item)
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
            .motion(value: model.notice)
            .motion(value: model.rows)
        }
    }

    /// After a cancel or return, the relist question; once sold, the sale and its delist.
    @ViewBuilder
    private func saleBanners(of item: Item) -> some View {
        if let prompt = item.relistPrompt, environment.saleScreens != nil {
            Banner(
                "The sale was \(prompt.saleStatus.value1 == .returned ? "returned" : "canceled"). Relist it?",
                message: "Listora relists only where you choose.",
                tone: .actionNeeded,
                action: .init("Choose", identifier: "item.relistPrompt.open") {
                    openSale = SaleLink(id: prompt.saleId)
                },
                identifier: "item.relistPrompt",
            )
        }
        if let summary = item.saleSummary {
            SoldSection(summary: summary, run: item.delistRun) {
                if environment.saleScreens != nil {
                    openSale = SaleLink(id: summary.saleId)
                }
            }
        }
    }

    /// "Mark as sold", for an item that is not sold yet.
    @ViewBuilder
    private func markSoldButton(for item: Item) -> some View {
        if environment.saleScreens != nil, item.canBeMarkedSold {
            Button("Mark as sold", systemImage: "dollarsign.circle") {
                markingSold = MarkSoldRequest(
                    itemID: item.id,
                    sku: item.sku,
                    title: item.details.title,
                    listPriceCents: item.details.listPrice?.amountCents,
                    listedOn: item.listings
                        .filter { $0.status.value1 == .active }
                        .compactMap { $0.marketplace.value1?.rawValue },
                )
            }
            .buttonStyle(.listoraSecondary)
            .accessibilityIdentifier("item.markSold")
        }
    }

    private func perform(_ action: MarketplaceRowState.Action, on row: MarketplaceRowState) {
        switch action {
        case .list:
            guard let item = model.item else { return }
            listingFlow = environment.makeListingFlow(item: item, marketplace: row.id)
        case .changePrice:
            guard let listing = row.listing else { return }
            priceChange = PriceChange(
                listingID: listing.id,
                marketplace: row.id,
                name: row.name,
                current: listing.variant?.price,
            )
        case .end:
            ending = row
        case .relist, .check:
            guard let listing = row.listing else { return }
            let request: ListingRequest = action == .relist
                ? .relist(listingID: listing.id)
                : .verify(listingID: listing.id)
            Task { await model.perform(request, marketplace: row.id) }
        case let .retry(operationID):
            Task { await model.retry(operationID: operationID, marketplace: row.id) }
        case let .openTask(operationID):
            openTask = OpenTask(operationID: operationID)
        }
    }

    private func end(_ row: MarketplaceRowState, reason: EndReason) {
        ending = nil
        guard let listing = row.listing else { return }
        Task { await model.perform(.end(listingID: listing.id, reason: reason.contract), marketplace: row.id) }
    }
}

/// Title, SKU, status, and list price.
private struct ItemHeader: View {
    let item: Item

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                Text(item.details.title ?? "Untitled item")
                    .font(Typography.title)
                    .foregroundStyle(Palette.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("item.title")
                if let price = item.details.listPrice {
                    Text(Formatting.money(price))
                        .font(Typography.price)
                        .foregroundStyle(Palette.brand)
                        .accessibilityLabel("List price \(Formatting.money(price))")
                }
            }
            HStack(spacing: Spacing.xs) {
                Text(item.sku)
                    .font(Typography.subheadline.monospacedDigit())
                    .foregroundStyle(Palette.textSecondary)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("item.sku")
                Chip(item.status.label)
                    .accessibilityIdentifier("item.status")
            }
        }
    }
}

/// List price, cost, and profit: the sale's profit once sold, before that an estimate before
/// marketplace fees, labeled as such.
private struct MoneySection: View {
    let item: Item

    var body: some View {
        DetailSection(title: "Cost and profit") {
            LabeledRow("List price", value: item.details.listPrice.map(Formatting.money) ?? "Not set")
            LabeledRow("Cost", value: item.details.cost.map(Formatting.money) ?? "Not set")
                .accessibilityIdentifier("item.cost")
            if let profit = item.saleSummary?.profit {
                LabeledRow(
                    "Profit",
                    value: Formatting.money(profit),
                    note: item.saleSummary?.feesEstimated == true ? "With estimated fees" : nil,
                )
                .accessibilityIdentifier("item.profit")
            } else if let price = item.details.listPrice, let cost = item.details.cost {
                LabeledRow(
                    "Profit at list price",
                    value: Formatting.money(cents: price.amountCents - cost.amountCents),
                    note: "Before marketplace fees and shipping",
                )
                .accessibilityIdentifier("item.profit")
            }
            if let source = item.details.purchaseSource {
                LabeledRow("Bought at", value: source)
            }
        }
    }
}

/// The item's details and where it is kept.
private struct DetailsSection: View {
    let item: Item

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
            if let size = item.details.sizeLabel {
                LabeledRow("Size", value: size)
            }
            if let condition = item.details.condition {
                LabeledRow("Condition", value: condition.label)
            }
            if let colors = item.details.colors, !colors.isEmpty {
                LabeledRow("Colors", value: colors.map(\.capitalized).joined(separator: ", "))
            }
            if let materials = item.details.materials, !materials.isEmpty {
                LabeledRow("Materials", value: materials.joined(separator: ", "))
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

extension Components.Schemas.ItemCondition {
    var label: String {
        switch self {
        case .newWithTags: "New with tags"
        case .newWithoutTags: "New without tags"
        case .newWithDefects: "New with defects"
        case .preOwnedExcellent: "Pre-owned, excellent"
        case .preOwnedGood: "Pre-owned, good"
        case .preOwnedFair: "Pre-owned, fair"
        }
    }
}

/// The item's photos, swipeable, cover first.
private struct PhotoCarousel: View {
    let photos: [Components.Schemas.Photo]

    var body: some View {
        if photos.isEmpty {
            PhotoView(url: nil, cornerRadius: Radius.large)
                .frame(height: 200)
        } else {
            TabView {
                ForEach(photos, id: \.id) { photo in
                    PhotoView(url: photo.urls?.listing ?? photo.urls?.thumbnail, cornerRadius: Radius.large)
                        .accessibilityLabel("Photo \(photo.position + 1) of \(photos.count)")
                }
            }
            .tabViewStyle(.page(indexDisplayMode: photos.count > 1 ? .automatic : .never))
            .frame(height: 240)
        }
    }
}
