import Core
import DesignSystem
import ListoraAPI
import SwiftUI

/// The profit dashboard, pushed from the Sales tab: a period (week, month, year, or custom), the
/// period's revenue, fees, shipping, cost of goods, net profit, and ROI, the averages, a chart
/// over time, the seller's own totals per marketplace, the best and worst brands and categories,
/// and dead stock. Every number is the server's (`getProfit`).
struct ProfitView: View {
    @State private var model: ProfitModel

    init(model: ProfitModel) {
        _model = State(initialValue: model)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                ProfitPeriodPicker(model: model)
                content
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
        }
        .background(Palette.background)
        .navigationTitle("Profit")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .signedOut:
            EmptyStateView(
                systemImage: "person.crop.circle.badge.questionmark",
                title: "Sign in to see your profit",
                message: "Your revenue, fees, and profit show up here once you sign in.",
            )
        case let .failed(message) where model.report == nil:
            EmptyStateView(
                systemImage: "exclamationmark.triangle",
                tone: .failed,
                title: "Profit unavailable",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await model.load() } },
            )
        default:
            if let report = model.report {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    if case let .failed(message) = model.phase {
                        Banner(
                            "Couldn't update",
                            message: message,
                            tone: .failed,
                            action: .init("Retry") { Task { await model.load() } },
                        )
                    }
                    ProfitReportView(report: report, model: model)
                        .opacity(model.isCurrent ? 1 : 0.5)
                        .animation(Motion.standard, value: model.isCurrent)
                }
            } else {
                loading
            }
        }
    }

    private var loading: some View {
        VStack(spacing: Spacing.sm) {
            SkeletonBlock(height: 160, cornerRadius: Radius.large)
            SkeletonBlock(height: 96, cornerRadius: Radius.large)
            SkeletonBlock(height: 220, cornerRadius: Radius.large)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading profit")
    }
}

/// Week, Month, Year, or Custom, and which one: arrows step through weeks, months, and years
/// (never past today); Custom picks the first and last day.
private struct ProfitPeriodPicker: View {
    let model: ProfitModel

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(spacing: Spacing.xs) {
                ForEach(ProfitRange.allCases) { range in
                    ChoiceChip(range.title, isSelected: model.period.range == range) {
                        Task { await model.select(range) }
                    }
                    .accessibilityIdentifier("profit.range.\(range.rawValue)")
                }
            }
            if model.period.range == .custom {
                customDays
            } else {
                stepper
            }
        }
    }

    private var stepper: some View {
        HStack {
            Button {
                Task { await model.step(-1) }
            } label: {
                Image(systemName: "chevron.left")
                    .frame(width: Layout.minimumTapTarget, height: Layout.minimumTapTarget)
            }
            .foregroundStyle(Palette.brand)
            .accessibilityLabel("Previous \(model.period.range.title.lowercased())")
            .accessibilityIdentifier("profit.previous")
            Spacer()
            Text(model.title)
                .font(Typography.headline)
                .foregroundStyle(Palette.textPrimary)
                .accessibilityIdentifier("profit.period")
            Spacer()
            Button {
                Task { await model.step(1) }
            } label: {
                Image(systemName: "chevron.right")
                    .frame(width: Layout.minimumTapTarget, height: Layout.minimumTapTarget)
            }
            .foregroundStyle(model.canStepForward ? AnyShapeStyle(Palette.brand) : AnyShapeStyle(Palette.separator))
            .disabled(!model.canStepForward)
            .accessibilityLabel("Next \(model.period.range.title.lowercased())")
            .accessibilityIdentifier("profit.next")
        }
        .font(Typography.headline)
    }

    private var customDays: some View {
        VStack(spacing: Spacing.xs) {
            DatePicker(
                "From",
                selection: Binding(
                    get: { model.period.start },
                    set: { start in Task { await model.setCustom(from: start, to: model.period.end) } },
                ),
                in: ...model.period.end,
                displayedComponents: .date,
            )
            .accessibilityIdentifier("profit.custom.from")
            DatePicker(
                "To",
                selection: Binding(
                    get: { model.period.end },
                    set: { end in Task { await model.setCustom(from: model.period.start, to: end) } },
                ),
                in: model.period.start...,
                displayedComponents: .date,
            )
            .accessibilityIdentifier("profit.custom.to")
        }
        .font(Typography.subheadline)
        .foregroundStyle(Palette.textPrimary)
        .tint(Palette.brand.color)
        .cardStyle(.outlined)
    }
}

/// The report's sections, top to bottom.
private struct ProfitReportView: View {
    let report: ProfitReport
    let model: ProfitModel

    var body: some View {
        let summary = report.summary
        VStack(alignment: .leading, spacing: Spacing.lg) {
            ProfitSummaryCard(summary: summary)
            if summary.missingCostCount > 0 {
                Banner(
                    summary.missingCostCount == 1
                        ? "1 sold item has no cost"
                        : "\(summary.missingCostCount) sold items have no cost",
                    message: "Their cost counts as $0, so the profit is higher than it really is. "
                        + "Add the cost on each item.",
                    tone: .actionNeeded,
                    identifier: "profit.missingCost",
                )
            }
            ProfitStatsGrid(summary: summary)
            ProfitChartSection(report: report, model: model)
            MarketplaceProfitSection(rows: report.marketplaces)
            ProfitRankingSection(
                title: "Brands",
                ranking: report.brands,
                emptyMessage: "Add brands to your items to see which ones earn the most.",
                identifier: "brand",
                name: { $0 },
            )
            ProfitRankingSection(
                title: "Categories",
                ranking: report.categories,
                emptyMessage: "Add categories to your items to see which ones earn the most.",
                identifier: "category",
                name: VocabularyName.category,
            )
            DeadStockSection(deadStock: report.deadStock)
        }
    }
}

/// Net profit first, then the lines that make it up.
private struct ProfitSummaryCard: View {
    let summary: Components.Schemas.ProfitSummary

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .firstTextBaseline) {
                Text(summary.feesEstimated ? "Net profit (estimated)" : "Net profit")
                    .font(Typography.eyebrow)
                    .textCase(.uppercase)
                    .tracking(0.6)
                    .foregroundStyle(Palette.textSecondary)
                Spacer()
                if let roi = summary.roiBasisPoints {
                    Text("\(SaleFormatting.roi(basisPoints: roi)) ROI")
                        .font(Typography.label)
                        .foregroundStyle(roi < 0 ? Palette.danger : Palette.brand)
                        .padding(.horizontal, Spacing.xs)
                        .padding(.vertical, Spacing.xxs)
                        .background(roi < 0 ? Palette.dangerSoft : Palette.brandSoft, in: Capsule())
                        .accessibilityIdentifier("profit.roi")
                }
            }
            Text(SaleFormatting.money(summary.netProfit))
                .font(Typography.priceLarge)
                .foregroundStyle(summary.netProfit.amountCents < 0 ? Palette.danger : Palette.textPrimary)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
                .accessibilityLabel(
                    "\(summary.feesEstimated ? "Net profit, estimated" : "Net profit"), "
                        + SaleFormatting.money(summary.netProfit),
                )
                .accessibilityIdentifier("profit.netProfit")
            if summary.feesEstimated {
                Text("Some fees are estimated until the marketplace reports them.")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
            }
            Divider()
            VStack(alignment: .leading, spacing: Spacing.xs) {
                MoneyRow("Revenue", summary.revenue)
                    .accessibilityIdentifier("profit.revenue")
                MoneyRow("Fees", summary.fees, negative: true)
                    .accessibilityIdentifier("profit.fees")
                MoneyRow("Shipping", summary.shipping, negative: true)
                    .accessibilityIdentifier("profit.shipping")
                MoneyRow("Cost of goods", summary.costOfGoods, negative: true)
                    .accessibilityIdentifier("profit.costOfGoods")
            }
        }
        .cardStyle()
    }
}

/// The period's counts and averages, two to a row.
private struct ProfitStatsGrid: View {
    let summary: Components.Schemas.ProfitSummary
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let columns = Array(
            repeating: GridItem(.flexible(), spacing: Spacing.sm, alignment: .top),
            count: typeSize.isAccessibilitySize ? 1 : 2,
        )
        LazyVGrid(columns: columns, alignment: .leading, spacing: Spacing.sm) {
            ProfitStat("Sales", value: "\(summary.salesCount)", identifier: "salesCount")
            ProfitStat("Items sold", value: "\(summary.itemsSold)", identifier: "itemsSold")
            ProfitStat(
                "Avg. sale price",
                value: summary.averageSalePrice.map { SaleFormatting.money($0) } ?? "–",
                identifier: "averageSalePrice",
            )
            ProfitStat(
                "Avg. profit per item",
                value: summary.averageProfitPerItem.map { SaleFormatting.money($0) } ?? "–",
                identifier: "averageProfitPerItem",
            )
            ProfitStat(
                "Avg. days to sell",
                value: summary.averageDaysToSell.map { $0 == 1 ? "1 day" : "\($0) days" } ?? "–",
                identifier: "averageDaysToSell",
            )
            ProfitStat(
                "Sell-through",
                value: summary.sellThroughBasisPoints.map { SaleFormatting.percent(basisPoints: $0) } ?? "–",
                identifier: "sellThrough",
            )
        }
    }
}

private struct ProfitStat: View {
    let title: String
    let value: String
    let identifier: String

    init(_ title: String, value: String, identifier: String) {
        self.title = title
        self.value = value
        self.identifier = identifier
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            Text(title)
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
            Text(value)
                .font(Typography.price)
                .foregroundStyle(Palette.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(.outlined)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("profit.\(identifier)")
    }
}
