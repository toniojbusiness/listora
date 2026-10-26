import Charts
import DesignSystem
import ListoraAPI
import SwiftUI

/// Net profit or revenue over the period, one bar per day, week, or month.
struct ProfitChartSection: View {
    let report: ProfitReport
    @Bindable var model: ProfitModel

    private struct Point: Identifiable {
        let id: String
        let date: Date
        let cents: Int64
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader("Over time", subtitle: subtitle)
            VStack(alignment: .leading, spacing: Spacing.sm) {
                HStack(spacing: Spacing.xs) {
                    ForEach(ProfitChartMetric.allCases) { metric in
                        ChoiceChip(metric.title, isSelected: model.chartMetric == metric) {
                            model.chartMetric = metric
                        }
                        .accessibilityIdentifier("profit.chart.\(metric.rawValue)")
                    }
                }
                if report.summary.itemsSold == 0 {
                    Text("No sales in this period yet.")
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                        .frame(maxWidth: .infinity, minHeight: 120)
                        .accessibilityIdentifier("profit.chart.empty")
                } else {
                    chart
                }
            }
            .cardStyle()
        }
    }

    private var subtitle: String {
        switch report.period.granularity.value1 {
        case .day: "By day"
        case .week: "By week"
        case .month: "By month"
        case nil: "By period"
        }
    }

    private var points: [Point] {
        report.series.compactMap { bucket in
            guard let date = date(bucket.start) else { return nil }
            let money = model.chartMetric == .netProfit ? bucket.netProfit : bucket.revenue
            return Point(id: bucket.start, date: date, cents: money.amountCents)
        }
    }

    private var unit: Calendar.Component {
        switch report.period.granularity.value1 {
        case .day, nil: .day
        case .week: .weekOfYear
        case .month: .month
        }
    }

    private var chart: some View {
        Chart(points) { point in
            BarMark(
                x: .value("Period", point.date, unit: unit, calendar: model.calendar),
                y: .value(model.chartMetric.title, Double(point.cents) / 100),
            )
            .foregroundStyle(barColor(point.cents))
            .cornerRadius(Radius.small / 2)
            .accessibilityLabel(accessibilityDate(point.date))
            .accessibilityValue(SaleFormatting.money(cents: point.cents))
        }
        .chartYAxis {
            AxisMarks(position: .leading) { value in
                AxisGridLine().foregroundStyle(Palette.separator.color)
                AxisValueLabel {
                    if let dollars = value.as(Double.self) {
                        Text(dollars.formatted(.currency(code: "USD").precision(.fractionLength(0))))
                            .font(Typography.caption)
                            .foregroundStyle(Palette.textSecondary)
                    }
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 5)) { value in
                AxisValueLabel {
                    if let date = value.as(Date.self) {
                        Text(axisDate(date))
                            .font(Typography.caption)
                            .foregroundStyle(Palette.textSecondary)
                    }
                }
            }
        }
        .frame(height: 200)
        .accessibilityLabel("\(model.chartMetric.title) \(subtitle.lowercased())")
        .accessibilityIdentifier("profit.chart")
    }

    private func barColor(_ cents: Int64) -> Color {
        if cents < 0 {
            return Palette.danger.color
        }
        return model.chartMetric == .netProfit ? Palette.brand.color : Palette.info.color
    }

    private func date(_ day: String) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return model.calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    private func axisDate(_ date: Date) -> String {
        var style: Date.FormatStyle = unit == .month
            ? .dateTime.month(.abbreviated)
            : .dateTime.month(.abbreviated).day()
        style.timeZone = model.calendar.timeZone
        return date.formatted(style)
    }

    private func accessibilityDate(_ date: Date) -> String {
        var style: Date.FormatStyle = unit == .month
            ? .dateTime.month(.wide).year()
            : .dateTime.month(.wide).day().year()
        style.timeZone = model.calendar.timeZone
        let text = date.formatted(style)
        return unit == .weekOfYear ? "Week of \(text)" : text
    }
}

/// The seller's own totals on each marketplace, in a fixed order: side by side, never ranked
/// (eBay's API License Agreement forbids presenting eBay's results relative to another
/// service's without eBay's consent).
struct MarketplaceProfitSection: View {
    let rows: [MarketplaceProfit]

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader("By marketplace", subtitle: "Your own totals on each marketplace you sold on.")
            VStack(alignment: .leading, spacing: Spacing.sm) {
                if rows.isEmpty {
                    Text("No sales in this period yet.")
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    if index > 0 {
                        Divider()
                    }
                    marketplaceRow(row)
                }
            }
            .cardStyle()
        }
    }

    private func marketplaceRow(_ row: MarketplaceProfit) -> some View {
        let name = row.marketplace.name
        let sales = row.salesCount == 1 ? "1 sale" : "\(row.salesCount) sales"
        return HStack(alignment: .center, spacing: Spacing.sm) {
            IconTile(monogram: String(name.prefix(1)))
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                Text("\(sales) · \(SaleFormatting.money(row.revenue)) revenue")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                Text("Fees \(SaleFormatting.money(row.fees)) · Shipping \(SaleFormatting.money(row.shipping))")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
            }
            Spacer(minLength: Spacing.sm)
            ProfitAmount(money: row.netProfit)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("profit.marketplace.\(row.marketplace.id)")
    }
}

/// The best brands or categories in a chart, and the worst below.
struct ProfitRankingSection: View {
    let title: String
    let ranking: Components.Schemas.ProfitRanking
    let emptyMessage: String
    let identifier: String
    let name: (String) -> String

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader(title, subtitle: "Ranked by net profit.")
            VStack(alignment: .leading, spacing: Spacing.md) {
                if ranking.best.isEmpty {
                    Text(emptyMessage)
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                } else {
                    Text("Best")
                        .font(Typography.emphasis)
                        .foregroundStyle(Palette.textPrimary)
                    groupRows(ranking.best, kind: "best")
                }
                if !ranking.worst.isEmpty {
                    Divider()
                    Text("Worst")
                        .font(Typography.emphasis)
                        .foregroundStyle(Palette.textPrimary)
                    groupRows(ranking.worst, kind: "worst")
                }
            }
            .cardStyle()
        }
    }

    private func groupRows(_ groups: [ProfitGroup], kind: String) -> some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            ForEach(Array(groups.enumerated()), id: \.offset) { index, group in
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(name(group.key))
                                .font(Typography.emphasis)
                                .foregroundStyle(Palette.textPrimary)
                            Text(details(group))
                                .font(Typography.footnote)
                                .foregroundStyle(Palette.textSecondary)
                        }
                        Spacer(minLength: Spacing.sm)
                        ProfitAmount(money: group.netProfit)
                    }
                    ProfitBar(fraction: fraction(group), loss: group.netProfit.amountCents < 0)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("profit.\(identifier).\(kind).\(index)")
            }
        }
    }

    /// The group's net profit as a share of the largest one in either list, by size.
    private func fraction(_ group: ProfitGroup) -> Double {
        let largest = (ranking.best + ranking.worst).map { abs($0.netProfit.amountCents) }.max() ?? 0
        guard largest > 0 else { return 0 }
        return Double(abs(group.netProfit.amountCents)) / Double(largest)
    }

    private func details(_ group: ProfitGroup) -> String {
        var parts = [group.itemsSold == 1 ? "1 sold" : "\(group.itemsSold) sold"]
        if let roi = group.roiBasisPoints {
            parts.append("\(SaleFormatting.roi(basisPoints: roi)) ROI")
        }
        if let days = group.averageDaysToSell {
            parts.append(days == 1 ? "1 day to sell" : "\(days) days to sell")
        }
        return parts.joined(separator: " · ")
    }
}

/// Unsold inventory over 60 and 90 days old, the money tied up in it, and the oldest items.
struct DeadStockSection: View {
    let deadStock: Components.Schemas.DeadStock

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader("Dead stock", subtitle: "Unsold items by how long you've had them, as of today.")
            VStack(alignment: .leading, spacing: Spacing.md) {
                AdaptiveStack {
                    tile("Over 60 days", deadStock.over60Days, identifier: "over60")
                    tile("Over 90 days", deadStock.over90Days, identifier: "over90")
                }
                if deadStock.oldest.isEmpty {
                    Text("Nothing has sat unsold for over 60 days.")
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                } else {
                    Text("Oldest")
                        .font(Typography.emphasis)
                        .foregroundStyle(Palette.textPrimary)
                    ForEach(deadStock.oldest, id: \.itemId) { item in
                        oldestRow(item)
                    }
                }
            }
            .cardStyle()
        }
    }

    private func tile(_ title: String, _ bucket: Components.Schemas.DeadStockBucket, identifier: String) -> some View {
        let items = bucket.itemCount == 1 ? "1 item" : "\(bucket.itemCount) items"
        return VStack(alignment: .leading, spacing: Spacing.xxs) {
            Text(title)
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
            Text(items)
                .font(Typography.price)
                .foregroundStyle(bucket.itemCount > 0 ? Palette.warning : Palette.textPrimary)
            Text("\(SaleFormatting.money(bucket.cost)) tied up")
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
            if bucket.missingCostCount > 0 {
                Text("\(bucket.missingCostCount) without a cost")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Spacing.sm)
        .background(
            bucket.itemCount > 0 ? Palette.warningSoft : Palette.surfaceSecondary,
            in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous),
        )
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("profit.deadStock.\(identifier)")
    }

    private func oldestRow(_ item: DeadStockItem) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title ?? item.sku)
                    .font(Typography.emphasis)
                    .foregroundStyle(Palette.textPrimary)
                    .lineLimit(2)
                Text("\(item.sku) · \(item.ageDays) days")
                    .font(Typography.metadata)
                    .foregroundStyle(Palette.textSecondary)
            }
            Spacer(minLength: Spacing.sm)
            Text(item.cost.map { SaleFormatting.money($0) } ?? "No cost")
                .font(Typography.emphasis)
                .foregroundStyle(item.cost == nil ? Palette.textSecondary : Palette.textPrimary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("profit.deadStock.item.\(item.sku)")
    }
}

/// A bar as long as `fraction` of the row, red for a loss.
private struct ProfitBar: View {
    let fraction: Double
    let loss: Bool

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Palette.surfaceSecondary)
                Capsule()
                    .fill(loss ? Palette.danger : Palette.brand)
                    .frame(width: max(geometry.size.width * fraction, fraction > 0 ? 6 : 0))
            }
        }
        .frame(height: 6)
        .accessibilityHidden(true)
    }
}

/// A net profit, red for a loss.
private struct ProfitAmount: View {
    let money: Money

    var body: some View {
        Text(SaleFormatting.money(money))
            .font(Typography.emphasis)
            .foregroundStyle(money.amountCents < 0 ? Palette.danger : Palette.textPrimary)
    }
}
