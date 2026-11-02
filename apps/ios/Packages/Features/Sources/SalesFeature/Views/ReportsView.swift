import Core
import DesignSystem
import ListoraAPI
import SwiftUI

/// The Reports screen, pushed from the Sales tab, for taxes and bookkeeping: a year's revenue,
/// fees, shipping, cost of goods, and profit on a tag, then each month and each marketplace
/// ruled, the year's expenses (miles and sourcing spend), and the CSV exports of the year's
/// sales, its expenses, and the inventory, shared through the share sheet. Every number is the server's
/// (`getYearReport`); one the server cannot compute
/// reliably is shown as not known, with why, never as a guess.
struct ReportsView: View {
    @State private var model: ReportsModel
    private let onSignIn: @MainActor () -> Void

    init(model: ReportsModel, onSignIn: @escaping @MainActor () -> Void = {}) {
        _model = State(initialValue: model)
        self.onSignIn = onSignIn
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                ReportsYearPicker(model: model)
                content
                ReportsExportSection(model: model)
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
        }
        .background(Palette.background)
        .navigationTitle("Reports")
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
                title: "Sign in to see your reports",
                message: "Your year's sales, fees, costs, and profit show up here once you sign in.",
                action: .init("Sign in", systemImage: "person.crop.circle", handler: onSignIn),
            )
        case let .failed(message) where model.report == nil:
            EmptyStateView(
                systemImage: "exclamationmark.triangle",
                tone: .failed,
                title: "Reports unavailable",
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
                    YearReportSections(report: report, calendar: model.calendar)
                        .opacity(model.isCurrent ? 1 : 0.5)
                        .animation(Motion.standard, value: model.isCurrent)
                    ReportsExpensesSection(model: model, report: report)
                        .opacity(model.isCurrent ? 1 : 0.5)
                }
            } else {
                VStack(spacing: Spacing.sm) {
                    SkeletonBlock(height: 200, cornerRadius: Radius.large)
                    SkeletonBlock(height: 160, cornerRadius: Radius.large)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Loading reports")
            }
        }
    }
}

/// The year, with arrows to the previous and next one (never past this year).
private struct ReportsYearPicker: View {
    let model: ReportsModel

    var body: some View {
        HStack {
            Button {
                Task { await model.step(-1) }
            } label: {
                Image(systemName: "chevron.left")
                    .frame(width: Layout.minimumTapTarget, height: Layout.minimumTapTarget)
            }
            .foregroundStyle(Palette.brand)
            .accessibilityLabel("Previous year")
            .accessibilityIdentifier("reports.previous")
            Spacer()
            Text(String(model.year))
                .font(Typography.headline)
                .foregroundStyle(Palette.textPrimary)
                .accessibilityIdentifier("reports.year")
            Spacer()
            Button {
                Task { await model.step(1) }
            } label: {
                Image(systemName: "chevron.right")
                    .frame(width: Layout.minimumTapTarget, height: Layout.minimumTapTarget)
            }
            .foregroundStyle(model.canStepForward ? AnyShapeStyle(Palette.brand) : AnyShapeStyle(Palette.separator))
            .disabled(!model.canStepForward)
            .accessibilityLabel("Next year")
            .accessibilityIdentifier("reports.next")
        }
        .font(Typography.headline)
    }
}

/// The year on its tag, then the months and the marketplaces, ruled.
private struct YearReportSections: View {
    let report: YearReport
    let calendar: Calendar

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            YearTotalTag(year: Int(report.year), totals: report.total)
            if report.total.itemsSold == 0 {
                Text("No sales in \(String(report.year)).")
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityIdentifier("reports.empty")
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    SectionHeader("By month")
                    ForEach(report.months.filter { $0.totals.itemsSold > 0 }, id: \.month) { month in
                        ReportRow(title: monthName(month.month), totals: month.totals)
                            .accessibilityIdentifier("reports.month.\(month.month)")
                    }
                }
                VStack(alignment: .leading, spacing: 0) {
                    // Side by side in their fixed order, never ranked (eBay's licence).
                    SectionHeader("By marketplace")
                    ForEach(report.marketplaces, id: \.marketplace.id) { row in
                        ReportRow(title: row.marketplace.name, totals: row.totals)
                            .accessibilityIdentifier("reports.marketplace.\(row.marketplace.id)")
                    }
                }
            }
        }
    }

    /// "March" for `2026-03`.
    private func monthName(_ month: String) -> String {
        let parts = month.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 2,
              let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: 1))
        else { return month }
        var style = Date.FormatStyle.dateTime.month(.wide)
        style.timeZone = calendar.timeZone
        return date.formatted(style)
    }
}

/// The year's totals on a price tag: the revenue in Fraunces, then the lines that make the
/// profit, each one the server could not compute shown as not known, with why.
private struct YearTotalTag: View {
    let year: Int
    let totals: ReportTotals

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text("\(String(year)) revenue")
                    .font(Typography.eyebrow)
                    .textCase(.uppercase)
                    .tracking(0.6)
                    .foregroundStyle(Palette.textSecondary)
                Text(SaleFormatting.money(totals.revenue))
                    .font(Typography.priceLarge)
                    .foregroundStyle(Palette.textPrimary)
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                Text(SalesSummaryView.counts(totals.salesCount, totals.itemsSold, since: nil))
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("reports.revenue")
            Divider().overlay(Palette.separator.color)
            VStack(alignment: .leading, spacing: Spacing.xs) {
                ReportLine("Fees", totals.fees, negative: true, unknown: ReportNotes.fees(totals))
                    .accessibilityIdentifier("reports.fees")
                ReportLine("Shipping", totals.shipping, negative: true)
                    .accessibilityIdentifier("reports.shipping")
                ReportLine("Cost of goods", totals.costOfGoods, negative: true, unknown: ReportNotes.cost(totals))
                    .accessibilityIdentifier("reports.costOfGoods")
                Divider().overlay(Palette.separator.color)
                ReportLine("Profit", totals.netProfit, emphasized: true, unknown: ReportNotes.profit)
                    .accessibilityIdentifier("reports.profit")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .tagStyle()
    }
}

/// One line of the totals: its amount, or "Not known yet" and why.
private struct ReportLine: View {
    let label: String
    let money: Money?
    let negative: Bool
    let emphasized: Bool
    let unknown: String

    init(_ label: String, _ money: Money?, negative: Bool = false, emphasized: Bool = false, unknown: String = "") {
        self.label = label
        self.money = money
        self.negative = negative
        self.emphasized = emphasized
        self.unknown = unknown
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
            Text(label)
                .font(emphasized ? Typography.headline : Typography.subheadline)
                .foregroundStyle(emphasized ? Palette.textPrimary : Palette.textSecondary)
            Spacer(minLength: Spacing.sm)
            VStack(alignment: .trailing, spacing: 2) {
                if let money {
                    let amount = SaleFormatting.money(money)
                    Text(negative && money.amountCents != 0 ? "-\(amount)" : amount)
                        .font(emphasized ? Typography.price : Typography.emphasis)
                        .foregroundStyle(money.amountCents < 0 && !negative ? Palette.danger : Palette.textPrimary)
                } else {
                    Text("Not known yet")
                        .font(Typography.emphasis)
                        .foregroundStyle(Palette.textSecondary)
                    Text(unknown)
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                        .multilineTextAlignment(.trailing)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Why a number is not known yet, in the seller's words.
enum ReportNotes {
    static func fees(_ totals: ReportTotals) -> String {
        let count = totals.feesUnknownCount
        return count == 1
            ? "1 sale's fees aren't final from the marketplace"
            : "\(count) sales' fees aren't final from the marketplace"
    }

    static func cost(_ totals: ReportTotals) -> String {
        let count = totals.missingCostCount
        return count == 1 ? "1 sold item has no cost" : "\(count) sold items have no cost"
    }

    static let profit = "Shown once every fee and cost is known"

    /// The profit, or why it isn't shown, for a month's or marketplace's row.
    static func rowProfit(_ totals: ReportTotals) -> String {
        if let profit = totals.netProfit {
            return "Profit \(SaleFormatting.money(profit))"
        }
        if totals.feesUnknownCount > 0 {
            return "Profit waits for final fees"
        }
        return "Profit waits for item costs"
    }
}

/// A month or a marketplace: its sales, revenue, and profit, ruled.
private struct ReportRow: View {
    let title: String
    let totals: ReportTotals

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(title)
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                Text(SalesSummaryView.counts(totals.salesCount, totals.itemsSold, since: nil))
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
            }
            Spacer(minLength: Spacing.sm)
            VStack(alignment: .trailing, spacing: Spacing.xxs) {
                Text(SaleFormatting.money(totals.revenue))
                    .font(Typography.price)
                    .foregroundStyle(Palette.textPrimary)
                    .fixedSize()
                Text(ReportNotes.rowProfit(totals))
                    .font(Typography.footnote)
                    .foregroundStyle(
                        (totals.netProfit?.amountCents ?? 0) < 0 ? Palette.danger : Palette.textSecondary,
                    )
                    .multilineTextAlignment(.trailing)
            }
        }
        .cardStyle(.ruled, padding: Spacing.sm)
        .accessibilityElement(children: .combine)
    }
}
