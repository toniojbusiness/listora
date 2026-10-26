import DesignSystem
import ListoraAPI
import SwiftUI

/// "Mark as sold": for a sale Listora did not see itself. The seller picks where it sold, enters
/// what it sold for (several items for a bundle), the shipping the buyer paid, and the day.
/// Recording it starts the same automatic delist as a detected sale: Listora delists the item
/// on every other marketplace and shows each one's result on the sale.
struct MarkSoldView: View {
    @State private var model: MarkSoldModel
    let onRecorded: @MainActor (String) -> Void
    @State private var search = ""
    @State private var addingItems = false
    @Environment(\.dismiss) private var dismiss

    init(model: MarkSoldModel, onRecorded: @escaping @MainActor (String) -> Void) {
        _model = State(initialValue: model)
        self.onRecorded = onRecorded
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    marketplaceSection
                    itemsSection
                    detailsSection
                    if let failure = model.failure {
                        Banner(
                            "The sale wasn't recorded",
                            message: failure,
                            tone: .failed,
                            onDismiss: { model.failure = nil },
                            identifier: "markSold.failure",
                        )
                    }
                }
                .padding(Spacing.md)
                .frame(maxWidth: Layout.readableWidth)
                .frame(maxWidth: .infinity)
            }
            .background(Palette.background)
            .scrollDismissesKeyboard(.interactively)
            .bottomActionBar { saveBar }
            .navigationTitle("Mark as sold")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("markSold.cancel")
                }
            }
            .sheet(isPresented: $addingItems) { addItemsSheet }
        }
    }

    private var marketplaceSection: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader("Where did it sell?")
            FlowLayout(spacing: Spacing.xs) {
                ForEach(model.marketplaces, id: \.self) { marketplace in
                    ChoiceChip(marketplace.name, isSelected: model.marketplace == marketplace) {
                        model.marketplace = marketplace
                        model.changed()
                    }
                    .accessibilityIdentifier("markSold.marketplace.\(marketplace.rawValue)")
                }
            }
        }
    }

    private var itemsSection: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader(
                model.lines.count > 1 ? "Items in this order" : "Sale price",
                subtitle: model.lines.count > 1 ? "Each item's part of the order, before shipping." : nil,
                action: .init("Add item") { addingItems = true },
            )
            VStack(alignment: .leading, spacing: Spacing.md) {
                ForEach($model.lines) { $line in
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(line.title ?? "Untitled item")
                                    .font(Typography.headline)
                                    .foregroundStyle(Palette.textPrimary)
                                Text(line.sku)
                                    .font(Typography.metadata)
                                    .foregroundStyle(Palette.textSecondary)
                            }
                            Spacer()
                            if line.itemID != model.request.itemID {
                                Button("Remove", systemImage: "minus.circle") { model.remove(itemID: line.itemID) }
                                    .labelStyle(.iconOnly)
                                    .foregroundStyle(Palette.danger)
                                    .frame(minWidth: Layout.minimumTapTarget, minHeight: Layout.minimumTapTarget)
                            }
                        }
                        PriceField("Sold for", minorUnits: $line.priceCents)
                            .onChange(of: line.priceCents) { model.changed() }
                            .accessibilityIdentifier("markSold.price.\(line.sku)")
                    }
                }
            }
            .cardStyle()
        }
    }

    private var detailsSection: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            SectionHeader("Order")
            VStack(alignment: .leading, spacing: Spacing.md) {
                PriceField(
                    "Shipping the buyer paid",
                    minorUnits: $model.shippingCents,
                    hint: "$0 if shipping was free.",
                )
                .onChange(of: model.shippingCents) { model.changed() }
                .accessibilityIdentifier("markSold.shipping")
                DatePicker("Sold on", selection: $model.soldAt, in: ...Date(), displayedComponents: [.date])
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textPrimary)
                    .onChange(of: model.soldAt) { model.changed() }
                ListoraTextField(
                    "Order number (optional)",
                    text: $model.orderNumber,
                    hint: "From the marketplace's order page. Listora then won't count the order twice.",
                )
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onChange(of: model.orderNumber) { model.changed() }
            }
            .cardStyle()
        }
    }

    private var saveBar: some View {
        VStack(spacing: Spacing.xs) {
            Text(model.missing ?? "Listora delists it everywhere else and shows each result.")
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("markSold.hint")
            Button {
                Task {
                    if let sale = await model.save() {
                        dismiss()
                        onRecorded(sale.id)
                    }
                }
            } label: {
                Text(model.totalCents > 0
                    ? "Record sale · \(SaleFormatting.money(cents: Int64(model.totalCents)))"
                    : "Record sale")
            }
            .buttonStyle(.listoraPrimary)
            .loading(model.isSaving)
            .disabled(model.missing != nil || model.isSaving)
            .accessibilityIdentifier("markSold.save")
        }
    }

    private var addItemsSheet: some View {
        NavigationStack {
            List(model.candidates, id: \.id) { item in
                Button {
                    model.add(item)
                    addingItems = false
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title ?? "Untitled item")
                            .font(Typography.emphasis)
                            .foregroundStyle(Palette.textPrimary)
                        Text(item.sku)
                            .font(Typography.metadata)
                            .foregroundStyle(Palette.textSecondary)
                    }
                }
            }
            .overlay {
                if model.candidates.isEmpty {
                    ContentUnavailableView.search(text: search)
                }
            }
            .searchable(text: $search, prompt: "SKU, title, or brand")
            .task(id: search) {
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
                await model.search(search)
            }
            .navigationTitle("Add an item")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { addingItems = false }
                }
            }
        }
    }
}
