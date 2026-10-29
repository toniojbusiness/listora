import Core
import DesignSystem
import ListoraAPI
import SwiftUI

/// The Sales tab: all the seller's sales in total and per marketplace, the sales, newest sold
/// first or in the order the sort menu picks, with what each one sold for and its profit, and
/// the ways to the profit dashboard and to the reports and exports. The
/// list is read from the server each time it appears, after a sync, and on pull to refresh,
/// which syncs the marketplaces too.
public struct SalesView<Settings: View>: View {
    private let environment: SalesEnvironment
    private let settings: Settings
    private let onOpenInventory: (@MainActor () -> Void)?
    @State private var model: SalesListModel

    /// `settings` is the header's button that opens Settings; `onOpenInventory` opens Inventory,
    /// the empty list's action.
    public init(
        environment: SalesEnvironment,
        onOpenInventory: (@MainActor () -> Void)? = nil,
        @ViewBuilder settings: () -> Settings,
    ) {
        self.environment = environment
        self.onOpenInventory = onOpenInventory
        self.settings = settings()
        _model = State(initialValue: environment.makeListModel())
    }

    public var body: some View {
        NavigationStack {
            content
                .background(Palette.background)
                .navigationTitle("Sales")
                .navigationDestination(for: SaleRoute.self) { route in
                    SaleDetailView(environment: environment, saleID: route.saleID)
                }
                .navigationDestination(for: PackOrdersRoute.self) { _ in
                    environment.packOrders?.screen()
                }
                .navigationDestination(for: ProfitRoute.self) { _ in
                    ProfitView(model: environment.makeProfitModel(), onSignIn: environment.onSignIn)
                }
                .navigationDestination(for: ReportsRoute.self) { _ in
                    ReportsView(model: environment.makeReportsModel(), onSignIn: environment.onSignIn)
                }
                .toolbar {
                    if let syncButton = environment.syncButton {
                        ToolbarItem(placement: .topBarTrailing) { syncButton() }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        NavigationLink(value: ProfitRoute()) {
                            Label("Profit", systemImage: "chart.bar.xaxis")
                        }
                        .accessibilityIdentifier("sales.profit")
                    }
                    ToolbarItem(placement: .topBarTrailing) { settings }
                }
                .task {
                    await environment.packOrders?.refresh()
                    await model.load()
                }
                // A pull to refresh syncs the marketplaces too (docs/features/sync.md).
                .refreshable {
                    await environment.sync?.syncNow()
                    await model.load()
                }
                .onChange(of: model.sort) {
                    Task { await model.load() }
                }
                // A sync that ended may have found sales.
                .onChange(of: environment.sync?.isSyncing ?? false) { _, syncing in
                    if !syncing {
                        Task { await model.load() }
                    }
                }
        }
        .celebration(trigger: model.newSaleID)
    }

    private var content: some View {
        phaseContent.motion(value: model.phase)
    }

    @ViewBuilder
    private var phaseContent: some View {
        switch model.phase {
        case .loading where model.sales.isEmpty:
            SkeletonList(count: 4, label: "Loading sales")
        case .signedOut:
            EmptyStateView(
                systemImage: "person.crop.circle.badge.questionmark",
                title: "Sign in to see your sales",
                message: "Every sale, its fees, and its profit show up here once you sign in.",
                action: .init("Sign in", systemImage: "person.crop.circle", handler: environment.onSignIn),
            )
        case let .failed(message) where model.sales.isEmpty:
            EmptyStateView(
                systemImage: "exclamationmark.triangle",
                tone: .failed,
                title: "Sales unavailable",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await model.load() } },
            )
        default:
            if model.sales.isEmpty {
                EmptyStateView(
                    systemImage: "dollarsign.circle",
                    title: "No sales yet",
                    message: "When an item sells, Listora delists it everywhere else and shows the sale and "
                        + "its profit here. Sold somewhere Listora doesn't see? Open the item and tap Mark as sold.",
                    action: onOpenInventory.map { .init("Go to Inventory", systemImage: "hanger", handler: $0) },
                )
                .accessibilityIdentifier("sales.empty")
            } else {
                list
            }
        }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Spacing.sm) {
                if let summary = model.summary, summary.total.salesCount > 0 {
                    SalesSummaryView(summary: summary)
                        .padding(.bottom, Spacing.xs)
                }
                if environment.packOrders?.isShown() == true {
                    NavigationLink(value: PackOrdersRoute()) {
                        ListRow(
                            "Pack orders",
                            subtitle: "Scan each label before it ships",
                            systemImage: "shippingbox",
                        )
                        .cardStyle(.flat)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("sales.packOrders")
                }
                NavigationLink(value: ProfitRoute()) {
                    ProfitEntryRow()
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("sales.profitCard")
                NavigationLink(value: ReportsRoute()) {
                    ListRow(
                        "Reports and exports",
                        subtitle: "Your year by month and marketplace, and CSV files for taxes",
                        systemImage: "doc.text",
                    )
                    .cardStyle(.flat)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("sales.reports")
                SortMenu(selection: $model.sort, options: SaleSort.allCases, title: \.title)
                    .accessibilityIdentifier("sales.sort")
                ForEach(model.sales, id: \.id) { sale in
                    NavigationLink(value: SaleRoute(saleID: sale.id)) {
                        SaleRow(sale: sale)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("sales.row.\(sale.items.first?.sku ?? sale.id)")
                }
                if model.hasMore {
                    SkeletonRow()
                        .cardStyle(.flat)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("Loading more sales")
                        .task { await model.loadMore() }
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
        }
    }
}

struct SaleRoute: Hashable {
    let saleID: String
}

struct ProfitRoute: Hashable {}

struct ReportsRoute: Hashable {}

/// The way into the profit dashboard, above the sales.
private struct ProfitEntryRow: View {
    var body: some View {
        HStack(spacing: Spacing.sm) {
            IconTile(systemImage: "chart.bar.xaxis", size: .card)
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text("Profit dashboard")
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                Text("Revenue, fees, profit, and dead stock by week, month, or year")
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
            }
            Spacer(minLength: Spacing.sm)
            Image(systemName: "chevron.right")
                .font(Typography.emphasis)
                .foregroundStyle(Palette.textSecondary)
                .accessibilityHidden(true)
        }
        .contentShape(Rectangle())
        .cardStyle()
        .accessibilityElement(children: .combine)
    }
}

/// One sale in the list: what sold (its photo), where and when, its price, and its profit.
private struct SaleRow: View {
    let sale: Sale

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            SaleThumbnail(sale: sale)
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(sale.title)
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                    .lineLimit(2)
                // Where and when on one line when it fits, else on two, never breaking the date.
                ViewThatFits(in: .horizontal) {
                    Text("\(sale.marketplace.name) · \(SaleFormatting.day(sale.soldAt))")
                        .lineLimit(1)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(sale.marketplace.name)
                        Text(SaleFormatting.day(sale.soldAt))
                    }
                }
                .font(Typography.subheadline)
                .foregroundStyle(Palette.textSecondary)
                if sale.status.value1 != .detected {
                    StatusBadge(sale.status.label, tone: sale.status.tone, showsIcon: false)
                }
            }
            Spacer(minLength: Spacing.sm)
            VStack(alignment: .trailing, spacing: Spacing.xxs) {
                Text(SaleFormatting.money(sale.salePrice))
                    .font(Typography.number)
                    .foregroundStyle(Palette.textPrimary)
                profit
            }
        }
        .contentShape(Rectangle())
        .cardStyle(.flat)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var profit: some View {
        if sale.status.isUndone {
            Text("No profit")
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
        } else if let profit = sale.profit {
            Text("\(sale.feesEstimated == true ? "Est. profit" : "Profit") \(SaleFormatting.money(profit))")
                .font(Typography.smallEmphasis)
                .foregroundStyle(profit.amountCents < 0 ? Palette.danger : Palette.success)
        } else {
            Text("Add cost for profit")
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
        }
    }
}

/// The sold item's photo, small (its thumbnail); the marketplace's initial until it has one.
/// Decorative: the row's text names the item.
struct SaleThumbnail: View {
    let sale: Sale
    /// A card's mark, 48 points, growing with Dynamic Type up to 1.6 times.
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1
    private static let side: CGFloat = 48

    /// The first item's thumbnail, when its photo is processed.
    static func url(of sale: Sale) -> URL? {
        sale.items.first?.thumbnailUrl.flatMap(URL.init(string:))
    }

    var body: some View {
        let side = Self.side * min(scale, 1.6)
        RemoteImage(url: Self.url(of: sale)) {
            Text(String(sale.marketplace.name.prefix(1)))
                .font(Typography.headline)
                .foregroundStyle(sale.status.tone.color)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(sale.status.tone.softColor)
        }
        .frame(width: side, height: side)
        .background(Palette.surfaceSecondary.color)
        .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
        .accessibilityHidden(true)
    }
}

/// Pack check's to-ship list, pushed from the Sales tab.
private struct PackOrdersRoute: Hashable {}
