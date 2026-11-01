import DesignSystem
import ListoraAPI
import SwiftUI

/// Settings > Price drops (docs/features/price-drops.md): every drop planned before it runs, the
/// seller's rules with a switch each, and a new brand rule. Ruled, not boxed (Hang Tag: no
/// stitching on Settings); the prices are in Fraunces, the old one struck through.
struct PriceDropsView: View {
    @State private var model: PriceDropsModel
    @State private var editing: PriceDropRuleEditorModel.Target?
    private let testing: Bool

    init(model: PriceDropsModel, testing: Bool = false) {
        _model = State(initialValue: model)
        self.testing = testing
    }

    var body: some View {
        content
            .background(Palette.background)
            .navigationTitle("Price drops")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Add brand rule", systemImage: "plus") { editing = .newBrand }
                        .accessibilityIdentifier("priceDrops.addBrand")
                }
            }
            .task { await model.load() }
            .refreshable { await model.load() }
            .sheet(item: $editing, onDismiss: { Task { await model.load() } }, content: { target in
                NavigationStack {
                    PriceDropRuleEditor(model: PriceDropRuleEditorModel(target: target, service: model.service))
                }
            })
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            SkeletonList(count: 3, label: "Loading price drops")
        case let .failed(message):
            EmptyStateView(
                systemImage: "tag",
                tone: .failed,
                title: "Price drops unavailable",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await model.load() } },
            )
        case .loaded where model.rules.isEmpty:
            EmptyStateView(
                systemImage: "tag",
                title: "No price drops yet",
                message: "Lower the price of listings that haven't sold, a little at a time, down to a price "
                    + "you choose. You see every drop here a day before it runs.",
                steps: [
                    "Add a rule for a brand, or for one item on its screen.",
                    "Listora suggests the days from how fast your own items sell.",
                ],
                action: .init("Add brand rule", systemImage: "plus") { editing = .newBrand },
            )
        case .loaded:
            List {
                if let error = model.changeError {
                    Banner("Couldn't change it", message: error, tone: .failed)
                        .listRowBackground(Color.clear)
                }
                plannedSection
                rulesSection(model.brandRules, title: "Brands")
                rulesSection(model.itemRules, title: "Items")
                explanation
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
        }
    }

    private var plannedSection: some View {
        Section {
            if model.scheduled.isEmpty {
                Text("No drops coming up. A listing drops once it has gone a rule's days without selling.")
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
            }
            ForEach(model.scheduled, id: \.listingId) { drop in
                PlannedDropRow(drop: drop)
            }
            ForEach(model.waiting, id: \.listingId) { drop in
                PlannedDropRow(drop: drop)
            }
        } header: {
            HStack {
                SectionHeader("Coming up", subtitle: "Each drop shows here a day before it runs.")
                if testing {
                    TestingTag()
                }
            }
        }
        .listRowBackground(Palette.surface.color)
    }

    @ViewBuilder
    private func rulesSection(_ rules: [Components.Schemas.PriceDropRule], title: String) -> some View {
        if !rules.isEmpty {
            Section {
                ForEach(rules, id: \.id) { rule in
                    RuleRow(
                        rule: rule,
                        isSaving: model.savingRuleID == rule.id,
                        onToggle: { enabled in Task { await model.setEnabled(enabled, for: rule) } },
                        onEdit: { editing = .existing(rule) },
                    )
                }
            } header: {
                SectionHeader(title)
            }
            .listRowBackground(Palette.surface.color)
        }
    }

    private var explanation: some View {
        Section {
            Text(
                "Each drop is a price change on the marketplace, shown as done only once Listora reads the "
                    + "new price back. Listora changes a few prices a day per shop, one at a time, and never "
                    + "goes below a rule's lowest price or the item's own. Depop, Poshmark, and Mercari "
                    + "listings drop; eBay listings don't yet. A listing's days start again after any price "
                    + "change.",
            )
            .font(Typography.footnote)
            .foregroundStyle(Palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
            .listRowBackground(Color.clear)
        }
    }
}

extension PriceDropRuleEditorModel.Target: Identifiable {
    var id: String {
        switch self {
        case .newBrand: "new-brand"
        case let .newItem(itemID, _): "new-item-\(itemID)"
        case let .existing(rule): rule.id
        }
    }
}

/// One rule: what it is for, its terms, and its switch; tapping it opens it to change.
private struct RuleRow: View {
    let rule: Components.Schemas.PriceDropRule
    let isSaving: Bool
    let onToggle: (Bool) -> Void
    let onEdit: () -> Void

    var body: some View {
        HStack(spacing: Spacing.sm) {
            Button(action: onEdit) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(PriceDropWords.target(rule))
                        .font(Typography.headline)
                        .foregroundStyle(Palette.textPrimary)
                    Text(PriceDropWords.terms(rule))
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                    if rule.scope.value1 == .item, let sku = rule.sku {
                        Text(sku)
                            .font(Typography.sku)
                            .foregroundStyle(Palette.textSecondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Change this rule")
            Toggle(
                "On",
                isOn: Binding(get: { rule.enabled }, set: { onToggle($0) }),
            )
            .labelsHidden()
            .tint(Palette.brand.color)
            .disabled(isSaving)
            .accessibilityLabel("\(PriceDropWords.target(rule)) price drops")
            .accessibilityIdentifier("priceDrops.rule.toggle")
        }
        .frame(minHeight: Layout.minimumTapTarget)
        .accessibilityIdentifier("priceDrops.rule")
    }
}

/// A planned drop: the item, its marketplace, and the price now struck through beside the next
/// one, or why it won't drop.
struct PlannedDropRow: View {
    let drop: Components.Schemas.PlannedPriceDrop
    var now = Date()

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(alignment: .firstTextBaseline) {
                Text(drop.title ?? drop.sku)
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                    .lineLimit(2)
                Spacer(minLength: Spacing.sm)
                Text(Formatting.marketplaceName(drop.marketplace.id))
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
            }
            if drop.state.value1 == .scheduled, let next = drop.nextPrice {
                HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                    Text(Formatting.money(drop.price))
                        .font(Typography.subheadline)
                        .strikethrough()
                        .foregroundStyle(Palette.textSecondary)
                    Text(Formatting.money(next))
                        .font(Typography.price)
                        .foregroundStyle(Palette.textPrimary)
                    Spacer(minLength: 0)
                    Text(drop.at.map { $0 <= now ? "Soon" : PriceDropWords.moment($0, now: now) } ?? "Soon")
                        .font(Typography.metadata)
                        .foregroundStyle(Palette.textSecondary)
                }
            } else {
                Text(PriceDropWords.plan(drop, now: now))
                    .font(Typography.subheadline)
                    .foregroundStyle(drop.state.value1 == .lastFailed ? Palette.warning : Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, Spacing.xs)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(drop.title ?? drop.sku), \(Formatting.marketplaceName(drop.marketplace.id)): "
            + PriceDropWords.plan(drop, now: now))
        .accessibilityIdentifier("priceDrops.planned")
    }
}
