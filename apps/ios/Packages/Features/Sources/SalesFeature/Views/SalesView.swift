import DesignSystem
import ListoraAPI
import SwiftUI

/// The Sales tab: recent sales, newest first, with what each one sold for and its profit, and the
/// way to the profit dashboard. The list is read from the server each time it appears and on
/// pull to refresh.
public struct SalesView<Settings: View>: View {
    private let environment: SalesEnvironment
    private let settings: Settings
    @State private var model: SalesListModel

    /// `settings` is the header's button that opens Settings.
    public init(environment: SalesEnvironment, @ViewBuilder settings: () -> Settings) {
        self.environment = environment
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
                .navigationDestination(for: ProfitRoute.self) { _ in
                    ProfitView(model: environment.makeProfitModel())
                }
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        NavigationLink(value: ProfitRoute()) {
                            Label("Profit", systemImage: "chart.bar.xaxis")
                        }
                        .accessibilityIdentifier("sales.profit")
                    }
                    ToolbarItem(placement: .topBarTrailing) { settings }
                }
                .task { await model.load() }
                .refreshable { await model.load() }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading where model.sales.isEmpty:
            ScrollView {
                VStack(spacing: Spacing.sm) {
                    ForEach(0 ..< 4, id: \.self) { _ in
                        SkeletonRow().cardStyle(.outlined)
                    }
                }
                .padding(Spacing.md)
            }
            .scrollDisabled(true)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Loading sales")
        case .signedOut:
            EmptyStateView(
                systemImage: "person.crop.circle.badge.questionmark",
                title: "Sign in to see your sales",
                message: "Every sale, its fees, and its profit show up here once you sign in.",
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
                NavigationLink(value: ProfitRoute()) {
                    ProfitEntryRow()
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("sales.profitCard")
                ForEach(model.sales, id: \.id) { sale in
                    NavigationLink(value: SaleRoute(saleID: sale.id)) {
                        SaleRow(sale: sale)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("sales.row.\(sale.items.first?.sku ?? sale.id)")
                }
                if model.hasMore {
                    ProgressView()
                        .frame(maxWidth: .infinity)
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
                .font(Typography.subheadline.weight(.semibold))
                .foregroundStyle(Palette.textSecondary)
                .accessibilityHidden(true)
        }
        .contentShape(Rectangle())
        .cardStyle()
        .accessibilityElement(children: .combine)
    }
}

/// One sale in the list: what sold, where and when, its price, and its profit.
private struct SaleRow: View {
    let sale: Sale

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            IconTile(monogram: String(sale.marketplace.name.prefix(1)), tone: sale.status.tone)
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(sale.title)
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                    .lineLimit(2)
                Text("\(sale.marketplace.name) · \(SaleFormatting.day(sale.soldAt))")
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                if sale.status.value1 != .detected {
                    StatusBadge(sale.status.label, tone: sale.status.tone, showsIcon: false)
                }
            }
            Spacer(minLength: Spacing.sm)
            VStack(alignment: .trailing, spacing: Spacing.xxs) {
                Text(SaleFormatting.money(sale.salePrice))
                    .font(Typography.headline.monospacedDigit())
                    .foregroundStyle(Palette.textPrimary)
                profit
            }
        }
        .contentShape(Rectangle())
        .cardStyle(.outlined)
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
                .font(Typography.footnote.weight(.semibold).monospacedDigit())
                .foregroundStyle(profit.amountCents < 0 ? Palette.danger : Palette.success)
        } else {
            Text("Add cost for profit")
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
        }
    }
}
