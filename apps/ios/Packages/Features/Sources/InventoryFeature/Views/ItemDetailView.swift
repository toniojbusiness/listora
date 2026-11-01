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
    @State private var revision: ListingRevision?
    @State private var markingSold: MarkSoldRequest?
    @State private var openSale: SaleLink?
    @State private var openTask: OpenTask?
    @State private var editingSize = false
    @State private var reviewing = false
    @State private var showsActivity = false
    @State private var listEverywhere: BulkActionModel?
    @State private var printingSticker: StickerRequest?
    /// Just listed with Pack check on: the screen offers the item's sticker.
    @State private var offersSticker = false
    /// The item sold while this screen was open, so the sold stamp is pressed onto its tag.
    @State private var soldWhileOpen = false

    /// The assisted step whose task is open.
    private struct OpenTask: Identifiable {
        let operationID: String

        var id: String {
            operationID
        }
    }

    /// `listsEverywhere`: List everywhere opens once the item has loaded.
    private let listsEverywhere: Bool

    init(environment: InventoryEnvironment, itemID: String, listsEverywhere: Bool = false) {
        self.environment = environment
        self.listsEverywhere = listsEverywhere
        _model = State(initialValue: environment.makeDetailModel(itemID: itemID))
    }

    var body: some View {
        content
            .background(Palette.background)
            .navigationTitle(model.item?.sku ?? "Item")
            .navigationBarTitleDisplayMode(.inline)
            .onChange(of: model.item?.isSold) { old, new in
                if old == false, new == true {
                    soldWhileOpen = true
                }
            }
            .task {
                await model.load()
                if listsEverywhere, !model.hasLoadedOnce {
                    openListEverywhere()
                }
                model.hasLoadedOnce = true
                await model.followChanges()
            }
            .refreshable { await model.load() }
            // A change the server refused (the notice) is felt as well as shown.
            .sensoryFeedback(trigger: model.notice) { _, notice in notice == nil ? nil : .error }
            .sheet(
                item: $listingFlow,
                onDismiss: {
                    offersSticker = environment.stickerScreen != nil && environment.isPackCheckOn()
                    Task { await model.refresh() }
                },
                content: { flow in ListingFlowView(model: flow) { listingFlow = nil } },
            )
            .sheet(item: $printingSticker) { request in
                environment.stickerScreen?(request)
            }
            .sheet(
                item: $markingSold,
                onDismiss: { Task { await model.refresh() } },
                content: { request in
                    environment.saleScreens?
                        .markSold(request) { saleID in openSale = SaleLink(id: saleID, isNew: true) }
                },
            )
            .navigationDestination(isPresented: $reviewing) {
                if let item = model.item, let review = environment.reviewScreen {
                    review(ItemReviewRequest(sessionID: item.id, itemID: item.id, sku: item.sku)) { outcome in
                        reviewing = false
                        Task {
                            await model.load()
                            if case .saved(_, listNow: true) = outcome {
                                openListEverywhere()
                            }
                        }
                    }
                }
            }
            .navigationDestination(isPresented: $showsActivity) {
                ItemActivityView(model: environment.makeActivityModel(itemID: model.itemID))
            }
            .navigationDestination(item: $openSale) { link in
                environment.saleScreens?.sale(link.id)
                    .celebration(trigger: link.isNew ? link.id : nil)
                    .onDisappear { Task { await model.refresh() } }
            }
            .sheet(item: $openTask, onDismiss: { Task { await model.refresh() } }, content: { task in
                if let destination = environment.taskDestination {
                    destination(model.itemID, task.operationID) { openTask = nil }
                }
            })
            .sheet(
                item: $listEverywhere,
                onDismiss: { Task { await model.refresh() } },
                content: { bulk in BulkActionSheet(model: bulk, kind: .list) { listEverywhere = nil } },
            )
            .sheet(isPresented: $editingSize) {
                SizeEditorView(current: model.item?.details.sizeLabel) { size in
                    await model.saveSize(size)
                }
            }
            .sheet(item: $revision) { revision in
                ReviseListingView(revision: revision) { variant in
                    Haptics.play(.tap)
                    self.revision = nil
                    Task {
                        await model.perform(
                            .revise(listingID: revision.listingID, variant: variant),
                            marketplace: revision.marketplace,
                        )
                    }
                }
            }
            .sheet(item: $priceChange) { change in
                PriceChangeView(change: change) {
                    await model.floor(on: change.marketplace)
                } save: { price in
                    Haptics.play(.tap)
                    priceChange = nil
                    Task {
                        await model.perform(
                            .changePrice(listingID: change.listingID, price: price),
                            marketplace: change.marketplace,
                        )
                    }
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
                    ItemTag(item: item, soldWhileOpen: soldWhileOpen)
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
                if item.status.value1 == .draft, environment.reviewScreen != nil {
                    // A draft from another device or an earlier install has no draft on this
                    // iPhone's Add Item tab: it is reviewed from here.
                    Banner(
                        "Review it before listing",
                        message: "Check its details and price, and it's ready to list everywhere.",
                        tone: .actionNeeded,
                        action: .init("Review item", identifier: "item.review") { reviewing = true },
                        identifier: "item.draft",
                    )
                }
                if stickerOnTop {
                    // Pack check is on: the sticker for the item's bag is the first thing to do.
                    stickerSection(for: item)
                }
                marketplaces(of: item)
                MoneySection(item: item)
                itemActions(for: item)
                DetailsSection(item: item) { editingSize = true }
                ActivityLink { showsActivity = true }
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

    /// "Mark as sold", and the item's sticker while Pack check is off.
    @ViewBuilder
    private func itemActions(for item: Item) -> some View {
        if environment.saleScreens != nil {
            MarkSoldButton(item: item, request: $markingSold)
        }
        if !stickerOnTop {
            stickerSection(for: item)
        }
    }

    /// Whether "Print sticker" shows near the top of the screen: while Pack check is on.
    private var stickerOnTop: Bool {
        environment.stickerScreen != nil && environment.isPackCheckOn()
    }

    @ViewBuilder
    private func stickerSection(for item: Item) -> some View {
        if environment.stickerScreen != nil {
            ItemStickerSection(offers: $offersSticker) { printingSticker = StickerRequest(item) }
        }
    }
}

/// What the item screen's buttons do.
extension ItemDetailView {
    /// The List sheet for this item, where it can still be listed.
    private func openListEverywhere() {
        guard let item = model.item, model.rows.contains(where: { $0.actions.contains(.list) }) else { return }
        listEverywhere = environment.makeBulkAction(items: [ItemSummary(item)])
    }

    private func perform(_ action: MarketplaceRowState.Action, on row: MarketplaceRowState) {
        switch action {
        case .list:
            guard let item = model.item else { return }
            listingFlow = environment.makeListingFlow(item: item, marketplace: row.id)
        case .changePrice, .revise:
            openChange(action, of: row)
        case .end:
            // The End button confirms on its card first, then calls `end(_:reason:)`.
            break
        case .relist, .check:
            guard let listing = row.listing else { return }
            let request: ListingRequest = action == .relist
                ? .relist(listingID: listing.id)
                : .verify(listingID: listing.id)
            Task { await model.perform(request, marketplace: row.id) }
        case let .retry(operationID):
            Task { await model.retry(operationID: operationID, marketplace: row.id) }
        case let .tryNow(operationID):
            Task { await model.tryNow(operationID: operationID, marketplace: row.id) }
        case let .openTask(operationID):
            openTask = OpenTask(operationID: operationID)
        }
    }

    /// Change price, or Edit listing (tagged Testing in the owner's Test mode), for the row's live
    /// listing.
    private func openChange(_ action: MarketplaceRowState.Action, of row: MarketplaceRowState) {
        guard let listing = row.listing else { return }
        if action == .changePrice {
            priceChange = PriceChange(
                listingID: listing.id,
                marketplace: row.id,
                name: row.name,
                current: listing.variant?.price,
            )
            return
        }
        guard let variant = listing.variant else { return }
        revision = ListingRevision(
            listingID: listing.id,
            marketplace: row.id,
            name: row.name,
            current: variant,
            testing: environment.features?.isTesting(.revise, on: row.id) == true,
        )
    }

    /// The same change on each row's listing at once (Relist all, End all).
    private func performAll(_ rows: [MarketplaceRowState], _ request: (String) -> ListingRequest) {
        let requests = rows.compactMap { row -> (request: ListingRequest, marketplace: String)? in
            row.listing.map { (request($0.id), row.id) }
        }
        Task { await model.performAll(requests) }
    }

    private func end(_ row: MarketplaceRowState, reason: EndReason) {
        guard let listing = row.listing else { return }
        Task { await model.perform(.end(listingID: listing.id, reason: reason.contract), marketplace: row.id) }
    }
}

/// The marketplaces part of the item screen, apart so the view's body stays short.
extension ItemDetailView {
    /// Its marketplaces, each with its status and actions, then its refresh cadence and price drop.
    @ViewBuilder
    private func marketplaces(of item: Item) -> some View {
        MarketplacesSection(
            rows: model.rows,
            histories: model.histories,
            events: model.events,
            busyMarketplace: model.busyMarketplace,
            phoneProgress: environment.phoneProgress?.progress ?? [],
            isTesting: { action, marketplace in
                action == .revise && environment.features?.isTesting(.revise, on: marketplace) == true
            },
            perform: perform,
            end: { reason, row in end(row, reason: reason) },
            relistAll: { rows in performAll(rows) { .relist(listingID: $0) } },
            endAll: { reason, rows in performAll(rows) { .end(listingID: $0, reason: reason.contract) } },
            listEverywhere: openListEverywhere,
            loadEvents: { id in await model.loadEvents(operationID: id) },
        )
        ItemScheduleSections(item: item, environment: environment)
    }
}
