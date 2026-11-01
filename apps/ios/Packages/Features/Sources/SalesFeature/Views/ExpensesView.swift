import Core
import DesignSystem
import ListoraAPI
import SwiftUI

/// The year's expenses, ruled, oldest first (docs/features/expenses.md): each with its day,
/// what it was for, and its miles or amount; swipe to delete, Add for a new one. A change is
/// shown only once the server recorded it; a failure says why, and nothing changed.
struct ExpensesView: View {
    let model: ReportsModel
    @State private var adding = false
    @State private var failure: String?

    private static let emptyHint = "Miles and trip spend from a thrift run's checkout show up here."

    var body: some View {
        List {
            if let failure = failure ?? model.expenseFailure {
                Banner(
                    "Couldn't update",
                    message: failure,
                    tone: .failed,
                    action: .init("Retry") {
                        self.failure = nil
                        Task { await model.loadExpenses() }
                    },
                )
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            }
            if let expenses = model.expenses {
                if expenses.isEmpty {
                    Text("No expenses in \(String(model.year)) yet. \(Self.emptyHint)")
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                        .listRowBackground(Color.clear)
                        .accessibilityIdentifier("expenses.empty")
                }
                ForEach(expenses, id: \.id) { expense in
                    ExpenseRow(expense: expense)
                        .listRowBackground(Palette.background.color)
                        .swipeActions {
                            Button("Delete", role: .destructive) {
                                Task { failure = await model.deleteExpense(id: expense.id) }
                            }
                        }
                }
            } else if model.expenseFailure == nil {
                SkeletonBlock(height: 120, cornerRadius: Radius.large)
                    .listRowBackground(Color.clear)
                    .accessibilityLabel("Loading expenses")
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Palette.background)
        .navigationTitle("Expenses \(String(model.year))")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    adding = true
                } label: {
                    Label("Add expense", systemImage: "plus")
                }
                .accessibilityIdentifier("expenses.add")
            }
        }
        .sheet(isPresented: $adding) {
            AddExpenseSheet(model: model)
        }
        .task { await model.loadExpenses() }
        .refreshable { await model.loadExpenses() }
    }
}

private struct ExpenseRow: View {
    let expense: Expense

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(expense.category)
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                Text([expense.incurredOn, expense.description].compactMap(\.self).joined(separator: " · "))
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
            }
            Spacer(minLength: Spacing.sm)
            Text(amount)
                .font(Typography.emphasis)
                .foregroundStyle(Palette.textPrimary)
                .fixedSize()
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("expenses.row")
    }

    private var amount: String {
        if let miles = expense.miles {
            return miles == 1 ? "1 mi" : "\(miles) mi"
        }
        return expense.amount.map(SaleFormatting.money) ?? ""
    }
}

/// A new expense: miles driven or money spent, on a day of the year shown, and what it was for.
struct AddExpenseSheet: View {
    enum Kind: String, CaseIterable, Identifiable {
        case miles = "Miles"
        case spent = "Money spent"

        var id: Self {
            self
        }
    }

    let model: ReportsModel
    @Environment(\.dismiss) private var dismiss
    @State private var kind: Kind = .miles
    @State private var day: Date
    @State private var category = ""
    @State private var note = ""
    @State private var miles = ""
    @State private var amountCents: Int?
    @State private var failure: String?
    /// One key per sheet, so a retry after a lost answer records the expense once.
    @State private var idempotencyKey = UUID().uuidString.lowercased()

    init(model: ReportsModel) {
        self.model = model
        let today = Date()
        let calendar = model.calendar
        let date = calendar.component(.year, from: today) == model.year
            ? today
            : calendar.date(from: DateComponents(year: model.year, month: 12, day: 31)) ?? today
        _day = State(initialValue: date)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    Picker("Kind", selection: $kind) {
                        ForEach(Kind.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("addExpense.kind")
                    DatePicker("Day", selection: $day, in: yearRange, displayedComponents: .date)
                        .font(Typography.subheadline)
                    switch kind {
                    case .miles:
                        ListoraTextField("Miles driven", error: milesError) {
                            TextField("Miles driven", text: $miles)
                                .keyboardType(.numberPad)
                                .accessibilityIdentifier("addExpense.miles")
                        }
                    case .spent:
                        PriceField("Amount", minorUnits: $amountCents)
                            .accessibilityIdentifier("addExpense.amount")
                        ListoraTextField("What it was for") {
                            TextField(
                                "What it was for",
                                text: $category,
                                prompt: Text("Parking, supplies, an entry fee").foregroundStyle(Palette.textSecondary),
                            )
                            .accessibilityIdentifier("addExpense.category")
                        }
                    }
                    ListoraTextField("Note (optional)") {
                        TextField("Note (optional)", text: $note)
                            .accessibilityIdentifier("addExpense.note")
                    }
                    if let failure {
                        Banner(
                            "Couldn't add the expense",
                            message: "\(failure) Nothing was recorded; try again.",
                            tone: .failed,
                        )
                    }
                }
                .padding(Spacing.md)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Palette.background)
            .navigationTitle("Add expense")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(model.isSavingExpense)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        guard let write else { return }
                        Task {
                            failure = await model.addExpense(write, idempotencyKey: idempotencyKey)
                            if failure == nil {
                                dismiss()
                            }
                        }
                    }
                    .disabled(write == nil || model.isSavingExpense)
                    .accessibilityIdentifier("addExpense.save")
                }
            }
        }
        .interactiveDismissDisabled(model.isSavingExpense)
    }

    private var yearRange: ClosedRange<Date> {
        let calendar = model.calendar
        let start = calendar.date(from: DateComponents(year: model.year, month: 1, day: 1)) ?? day
        let end = calendar.date(from: DateComponents(year: model.year, month: 12, day: 31)) ?? day
        return start ... end
    }

    private var parsedMiles: Int? {
        Int(miles.trimmingCharacters(in: .whitespaces)).flatMap { (1 ... 2000).contains($0) ? $0 : nil }
    }

    private var milesError: String? {
        miles.isEmpty || parsedMiles != nil ? nil : "Enter whole miles, 1 to 2,000"
    }

    /// What the form holds, once it is an expense Listora accepts.
    private var write: ExpenseWrite? {
        let parts = model.calendar.dateComponents([.year, .month, .day], from: day)
        let incurredOn = String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
        let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        let description = trimmedNote.isEmpty ? nil : String(trimmedNote.prefix(500))
        switch kind {
        case .miles:
            guard let parsedMiles else { return nil }
            return ExpenseWrite(
                incurredOn: incurredOn,
                category: "Mileage",
                description: description,
                miles: Int32(parsedMiles),
            )
        case .spent:
            let label = category.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let amountCents, amountCents > 0, !label.isEmpty else { return nil }
            return ExpenseWrite(
                incurredOn: incurredOn,
                category: String(label.prefix(100)),
                description: description,
                amount: .init(amountCents: Int64(amountCents), currency: .usd),
            )
        }
    }
}
