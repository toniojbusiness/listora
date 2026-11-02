import DesignSystem
import SwiftUI

/// The CSV exports: the year's sales and the inventory today, each read from the server, saved
/// on the phone, and then shared through the share sheet.
struct ReportsExportSection: View {
    let model: ReportsModel

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader("Export for taxes", subtitle: "CSV files for a spreadsheet or your accountant")
            ExportRow(
                model: model,
                export: .sales,
                title: "Sales in \(String(model.year))",
                subtitle: "Each item sold: price, fees, shipping, cost, and profit",
            )
            ExportRow(
                model: model,
                export: .expenses,
                title: "Expenses in \(String(model.year))",
                subtitle: "Each expense: day, category, miles and their deduction, and amount",
            )
            ExportRow(
                model: model,
                export: .inventory,
                title: "Inventory today",
                subtitle: "Each item: status, purchase, cost, and price",
            )
        }
    }
}

private struct ExportRow: View {
    let model: ReportsModel
    let export: ReportExport
    let title: String
    let subtitle: String

    var body: some View {
        let state = model.exportState(export)
        HStack(alignment: .center, spacing: Spacing.sm) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(title)
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                Text(detail(state))
                    .font(Typography.footnote)
                    .foregroundStyle(isFailed(state) ? Palette.danger : Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: Spacing.sm)
            action(state)
        }
        .cardStyle(.ruled, padding: Spacing.sm)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("reports.export.\(export.rawValue)")
    }

    @ViewBuilder
    private func action(_ state: ReportsModel.ExportState) -> some View {
        switch state {
        case .idle, .failed:
            Button(isFailed(state) ? "Try again" : "Prepare") {
                Task { await model.prepare(export) }
            }
            .buttonStyle(.listora(.secondary, size: .compact))
            .accessibilityIdentifier("reports.export.\(export.rawValue).prepare")
        case .preparing:
            BrandSpinner()
                .accessibilityLabel("Preparing \(title)")
        case let .ready(file):
            ShareLink(item: file.url) {
                Label("Share", systemImage: "square.and.arrow.up")
            }
            .buttonStyle(.listora(.primary, size: .compact))
            .accessibilityIdentifier("reports.export.\(export.rawValue).share")
        }
    }

    private func detail(_ state: ReportsModel.ExportState) -> String {
        switch state {
        case .idle, .preparing: subtitle
        case let .ready(file):
            "\(file.url.lastPathComponent), \(file.rowCount == 1 ? "1 row" : "\(file.rowCount) rows")"
        case let .failed(message): message
        }
    }

    private func isFailed(_ state: ReportsModel.ExportState) -> Bool {
        if case .failed = state {
            return true
        }
        return false
    }
}
