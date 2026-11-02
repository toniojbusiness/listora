import Core
import DesignSystem
import ListoraAPI
import SwiftUI

/// The year's expenses on the Reports screen (docs/features/expenses.md), ruled under the
/// marketplaces: the miles at the year's mileage rate, the money spent by category, the total,
/// and the profit after them, then the way into the list to add or remove one. Every number is
/// the server's; miles without a rate are counted, never priced at a guess.
struct ReportsExpensesSection: View {
    let model: ReportsModel
    let report: YearReport
    @State private var editingRate = false

    private var expenses: YearExpenses {
        report.expenses
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(
                "Expenses",
                subtitle: "Miles and sourcing spend, for your taxes",
                action: .init("Rate") { editingRate = true },
            )
            .accessibilityIdentifier("reports.expenses.header")
            mileageRow
            ForEach(expenses.categories, id: \.category) { category in
                ExpenseTotalRow(
                    title: category.category,
                    detail: category.count == 1 ? "1 expense" : "\(category.count) expenses",
                    amount: SaleFormatting.money(category.spent),
                )
            }
            ExpenseTotalRow(
                title: "Total expenses",
                detail: expenses.total == nil ? "Shown once the year has a mileage rate" : nil,
                amount: expenses.total.map(SaleFormatting.money) ?? "Not known yet",
                emphasized: true,
            )
            .accessibilityIdentifier("reports.expenses.total")
            if let net = report.netAfterExpenses {
                ExpenseTotalRow(
                    title: "Profit after expenses",
                    detail: nil,
                    amount: SaleFormatting.money(net),
                    emphasized: true,
                    negative: net.amountCents < 0,
                )
                .accessibilityIdentifier("reports.expenses.net")
            }
            NavigationLink {
                ExpensesView(model: model)
            } label: {
                HStack {
                    Label("Add or review expenses", systemImage: "list.bullet.rectangle")
                        .font(Typography.headline)
                        .foregroundStyle(Palette.brand)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .foregroundStyle(Palette.textSecondary)
                        .accessibilityHidden(true)
                }
                .frame(minHeight: Layout.minimumTapTarget)
            }
            .cardStyle(.ruled, padding: Spacing.sm)
            .accessibilityIdentifier("reports.expenses.open")
        }
        .sheet(isPresented: $editingRate) {
            MileageRateSheet(model: model, rate: expenses.mileage.rate)
        }
    }

    private var mileageRow: some View {
        let mileage = expenses.mileage
        let miles = mileage.miles == 1 ? "1 mile" : "\(mileage.miles) miles"
        let trips = mileage.trips == 1 ? "1 trip" : "\(mileage.trips) trips"
        let detail = if let rate = mileage.rate.tenthCentsPerMile {
            "\(miles), \(trips) · \(MileageFormatting.rate(Int(rate)))"
                + (mileage.rate.setBySeller ? ", your rate" : ", IRS rate")
        } else {
            "\(miles), \(trips) · set this year's rate to price them"
        }
        return ExpenseTotalRow(
            title: "Mileage",
            detail: detail,
            amount: mileage.deduction.map(SaleFormatting.money) ?? "Not known yet",
        )
        .accessibilityIdentifier("reports.expenses.mileage")
    }
}

/// One ruled line of the expenses: its title and detail, its amount.
private struct ExpenseTotalRow: View {
    let title: String
    let detail: String?
    let amount: String
    var emphasized = false
    var negative = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(title)
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                if let detail {
                    Text(detail)
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: Spacing.sm)
            Text(amount)
                .font(emphasized ? Typography.price : Typography.emphasis)
                .foregroundStyle(negative ? Palette.danger : Palette.textPrimary)
                .fixedSize()
        }
        .cardStyle(.ruled, padding: Spacing.sm)
        .accessibilityElement(children: .combine)
    }
}

/// How a mileage rate reads: "72.5¢ a mile" for 725 tenths of a cent.
enum MileageFormatting {
    static func rate(_ tenthCents: Int) -> String {
        "\(cents(tenthCents))¢ a mile"
    }

    /// "72.5" for 725, "70" for 700.
    static func cents(_ tenthCents: Int) -> String {
        tenthCents.isMultiple(of: 10) ? "\(tenthCents / 10)" : "\(tenthCents / 10).\(tenthCents % 10)"
    }

    /// Tenths of a cent for what the seller typed in cents ("72.5" is 725); nil unless it is
    /// 0 to 1,000 cents with at most one decimal.
    static func tenthCents(_ text: String) -> Int? {
        let trimmed = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        let parts = trimmed.split(separator: ".", omittingEmptySubsequences: false)
        guard (1 ... 2).contains(parts.count), let whole = Int(parts[0]), whole >= 0 else { return nil }
        var tenths = 0
        if parts.count == 2 {
            guard parts[1].count == 1, let digit = Int(parts[1]) else { return nil }
            tenths = digit
        }
        let value = whole * 10 + tenths
        return value <= 10000 ? value : nil
    }
}

/// The year's standard mileage rate, in cents a mile, starting from the one in use.
struct MileageRateSheet: View {
    let model: ReportsModel
    let rate: MileageRate
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var failure: String?

    init(model: ReportsModel, rate: MileageRate) {
        self.model = model
        self.rate = rate
        _text = State(initialValue: rate.tenthCentsPerMile.map { MileageFormatting.cents(Int($0)) } ?? "")
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                ListoraTextField(
                    "Cents a mile in \(String(rate.year))",
                    hint: hint,
                    error: text.isEmpty || MileageFormatting.tenthCents(text) != nil
                        ? nil : "Enter cents, like 72.5",
                ) {
                    TextField("Cents a mile", text: $text)
                        .keyboardType(.decimalPad)
                        .accessibilityIdentifier("mileageRate.cents")
                }
                if let failure {
                    Banner("Couldn't save the rate", message: failure, tone: .failed)
                }
                Spacer()
            }
            .padding(Spacing.md)
            .background(Palette.background)
            .navigationTitle("Mileage rate")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        guard let tenths = MileageFormatting.tenthCents(text) else { return }
                        Task {
                            failure = await model.setMileageRate(tenthCentsPerMile: tenths)
                            if failure == nil {
                                dismiss()
                            }
                        }
                    }
                    .disabled(MileageFormatting.tenthCents(text) == nil || model.isSavingExpense)
                    .accessibilityIdentifier("mileageRate.save")
                }
            }
        }
        .presentationDetents([.medium])
    }

    private var hint: String {
        if let irs = rate.irsTenthCentsPerMile {
            return "The IRS business rate for \(String(rate.year)) is \(MileageFormatting.cents(Int(irs)))¢. "
                + "Every mile of the year uses this rate."
        }
        return "Listora doesn't know the IRS rate for \(String(rate.year)) yet. Every mile of the year uses this rate."
    }
}
