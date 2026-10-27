import DesignSystem
import ListoraAPI
import SwiftUI

/// Asks what the change is (where to list, the new prices, why the listings end), runs it over
/// every item, and shows how it went for each item on each marketplace, with Try again for what
/// failed. Started is not done: each item then shows its listings' progress until the
/// marketplace confirms.
struct BulkActionSheet: View {
    @Bindable var model: BulkActionModel
    let kind: BulkActionKind
    let onDone: () -> Void
    @State private var adjustment = PriceAdjustment()
    @State private var amountCents: Int? = 500
    @State private var reason = EndReason.notAvailable
    @State private var isConfirmingDelete = false

    static let percentChoices = [5, 10, 15, 20, 25, 30]

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .choosing: choosing
                case .running, .finished: progress
                }
            }
            .background(Palette.background)
            .navigationTitle(kind.title(count: model.total))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(model.phase == .finished ? "Done" : "Cancel", action: onDone)
                        .disabled(model.phase == .running)
                        .accessibilityIdentifier("bulk.close")
                }
            }
        }
        .task {
            if kind == .list {
                await model.prepare()
            }
        }
        .interactiveDismissDisabled(model.phase == .running)
    }

    // MARK: Choosing

    private var choosing: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.md) {
                switch kind {
                case .list: listChoices
                case .changePrice: priceChoices
                case .end: endChoices
                case .relist:
                    note("Listora relists every ended listing of these items, and shows each as listed once its "
                        + "marketplace confirms. An item with no ended listing is left as it is.")
                case .delete:
                    note("Deletes these items from Listora for good. An item that is still on a marketplace, or "
                        + "has sales, is kept: end its listings first, or archive it.")
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
        }
        .bottomActionBar { startButton }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(Typography.body)
            .foregroundStyle(Palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("bulk.note")
    }

    @ViewBuilder
    private var listChoices: some View {
        SectionHeader(
            "Where to list",
            subtitle: "Each item goes up with its own title, description, and price for that marketplace. "
                + "Where an item is already listed, it stays as it is.",
        )
        if model.destinations.isEmpty {
            ForEach(0 ..< 4, id: \.self) { _ in
                SkeletonRow().cardStyle(.flat)
            }
        }
        ForEach(model.destinations) { destination in
            DestinationRow(destination: destination, isOn: Binding(
                get: { model.chosen.contains(destination.id) },
                set: { isOn in
                    if isOn {
                        model.chosen.insert(destination.id)
                    } else {
                        model.chosen.remove(destination.id)
                    }
                },
            ))
        }
    }

    @ViewBuilder
    private var priceChoices: some View {
        SectionHeader(
            "New prices",
            subtitle: "Every live listing and each item's own list price change by the same amount. A price "
                + "below an item's floor on a marketplace is skipped.",
        )
        FlowLayout(spacing: Spacing.xs, lineSpacing: Spacing.xs) {
            ChoiceChip("Lower", systemImage: "arrow.down", isSelected: adjustment.direction == .lower) {
                adjustment.direction = .lower
            }
            .accessibilityIdentifier("bulk.price.lower")
            ChoiceChip("Raise", systemImage: "arrow.up", isSelected: adjustment.direction == .raise) {
                adjustment.direction = .raise
            }
            .accessibilityIdentifier("bulk.price.raise")
        }
        FlowLayout(spacing: Spacing.xs, lineSpacing: Spacing.xs) {
            ChoiceChip("By percent", isSelected: adjustment.unit == .percent) {
                adjustment.unit = .percent
                adjustment.value = 10
            }
            .accessibilityIdentifier("bulk.price.percent")
            ChoiceChip("By amount", isSelected: adjustment.unit == .amount) {
                adjustment.unit = .amount
                adjustment.value = amountCents ?? 0
            }
            .accessibilityIdentifier("bulk.price.amount")
        }
        switch adjustment.unit {
        case .percent:
            FlowLayout(spacing: Spacing.xs, lineSpacing: Spacing.xs) {
                ForEach(Self.percentChoices, id: \.self) { percent in
                    ChoiceChip("\(percent)%", isSelected: adjustment.value == percent) {
                        adjustment.value = percent
                    }
                    .accessibilityIdentifier("bulk.price.percent.\(percent)")
                }
            }
        case .amount:
            PriceField("Amount", minorUnits: $amountCents, hint: "Taken off or added to each price.")
                .onChange(of: amountCents) { _, cents in adjustment.value = cents ?? 0 }
        }
        if let example = priceExample {
            Label(example, systemImage: "equal.circle")
                .font(Typography.subheadline)
                .foregroundStyle(Palette.textSecondary)
                .accessibilityIdentifier("bulk.price.example")
        }
    }

    /// "$45.00 becomes $40.50", from the first chosen item with a price.
    private var priceExample: String? {
        guard let price = model.items.lazy.compactMap(\.listPrice).first else { return nil }
        guard let new = adjustment.apply(to: price.amountCents) else {
            return "That takes \(Formatting.money(price)) to $0 or less."
        }
        return "\(Formatting.money(price)) becomes \(Formatting.money(cents: new, currency: price.currency.rawValue))"
    }

    @ViewBuilder
    private var endChoices: some View {
        SectionHeader(
            "Why they end",
            subtitle: "Listora ends every live listing of these items and shows each as delisted once its "
                + "marketplace confirms. Where you list by hand, it adds a task for you.",
        )
        FlowLayout(spacing: Spacing.xs, lineSpacing: Spacing.xs) {
            ForEach(EndReason.allCases) { choice in
                ChoiceChip(choice.shortTitle, isSelected: reason == choice) { reason = choice }
                    .accessibilityIdentifier("bulk.end.\(choice.rawValue)")
            }
        }
    }

    @ViewBuilder
    private var startButton: some View {
        switch kind {
        case .list:
            Button(listTitle, systemImage: kind.systemImage) {
                Task { await model.run(.list(marketplaces: model.chosen)) }
            }
            .buttonStyle(.listoraPrimary)
            .disabled(model.chosen.isEmpty)
            .accessibilityIdentifier("bulk.start")
        case .changePrice:
            Button("Change prices", systemImage: kind.systemImage) {
                Haptics.play(.tap)
                Task { await model.run(.changePrice(adjustment)) }
            }
            .buttonStyle(.listoraPrimary)
            .disabled(adjustment.value <= 0)
            .accessibilityIdentifier("bulk.start")
        case .end:
            Button("End the listings", systemImage: kind.systemImage) {
                Task { await model.run(.end(reason)) }
            }
            .buttonStyle(.listoraDestructive)
            .accessibilityIdentifier("bulk.start")
        case .relist:
            Button("Relist", systemImage: kind.systemImage) { Task { await model.run(.relist) } }
                .buttonStyle(.listoraPrimary)
                .accessibilityIdentifier("bulk.start")
        case .delete:
            Button(kind.title(count: model.total), systemImage: kind.systemImage) { isConfirmingDelete = true }
                .buttonStyle(.listoraDestructive)
                .accessibilityIdentifier("bulk.start")
                .confirmationDialog(
                    "Delete \(model.total == 1 ? "this item" : "these \(model.total) items") for good?",
                    isPresented: $isConfirmingDelete,
                    titleVisibility: .visible,
                ) {
                    Button("Delete", role: .destructive) { Task { await model.run(.delete) } }
                        .accessibilityIdentifier("bulk.delete.confirm")
                    Button("Keep them", role: .cancel) {}
                } message: {
                    Text("Their photos and details leave Listora. This can't be undone.")
                }
        }
    }

    private var listTitle: String {
        let marketplaces = model.chosen.count
        return marketplaces == 0 ? "Choose where to list"
            : "List on \(marketplaces) marketplace\(marketplaces == 1 ? "" : "s")"
    }
}

/// How the change goes, item by item, and Try again for what failed.
extension BulkActionSheet {
    var progress: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.md) {
                header
                ForEach(groups, id: \.itemID) { group in
                    OutcomeCard(group: group)
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
        }
        .bottomActionBar {
            if model.phase == .finished {
                if !model.failedOutcomes.isEmpty {
                    Button(
                        "Try again for \(failedItemCount) item\(failedItemCount == 1 ? "" : "s")",
                        systemImage: "arrow.clockwise",
                    ) {
                        Task { await model.retryFailed() }
                    }
                    .buttonStyle(.listoraSecondary)
                    .accessibilityIdentifier("bulk.retry")
                }
                Button("Done", action: onDone)
                    .buttonStyle(.listoraPrimary)
                    .accessibilityIdentifier("bulk.done")
            }
        }
    }

    private var failedItemCount: Int {
        Set(model.failedOutcomes.map(\.itemID)).count
    }

    @ViewBuilder
    private var header: some View {
        if model.phase == .running {
            HStack(spacing: Spacing.sm) {
                BrandSpinner()
                    .controlSize(.small)
                Text("Working on \(model.finishedItems + 1 > model.total ? model.total : model.finishedItems + 1) "
                    + "of \(model.total)")
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("bulk.running")
        } else if model.failedOutcomes.isEmpty {
            Banner(
                kind == .delete ? "Done" : "Sent to Listora",
                message: kind == .delete ? model.summary
                    : "\(model.summary.capitalizedFirst). Each item shows its progress until the marketplace "
                    + "confirms.",
                tone: kind == .delete ? .success : .inProgress,
                identifier: "bulk.summary",
            )
        } else {
            Banner(
                "Some changes didn't go through",
                message: "\(model.summary.capitalizedFirst). Try again, or open the item to fix what's skipped.",
                tone: .failed,
                identifier: "bulk.summary",
            )
        }
    }

    /// The outcomes by item, in the order they were chosen.
    private var groups: [OutcomeGroup] {
        var groups: [OutcomeGroup] = []
        for outcome in model.outcomes {
            if let last = groups.indices.last, groups[last].itemID == outcome.itemID {
                groups[last].outcomes.append(outcome)
            } else {
                groups.append(OutcomeGroup(
                    itemID: outcome.itemID,
                    title: outcome.title,
                    sku: outcome.sku,
                    outcomes: [outcome],
                ))
            }
        }
        return groups
    }
}
