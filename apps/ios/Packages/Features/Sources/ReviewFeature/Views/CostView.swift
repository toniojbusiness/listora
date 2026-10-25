import Core
import DesignSystem
import SwiftUI

/// What the seller paid, when, and where: the basis of every "Don't sell below" price.
struct CostView: View {
    @Bindable var model: ReviewFlowModel
    let onFinished: @MainActor (ItemReviewOutcome) -> Void
    @FocusState private var isSourceFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text("What did you pay?")
                        .font(Typography.title)
                        .foregroundStyle(Palette.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                    Text("Listora works out the lowest price that still covers it on each marketplace.")
                        .font(Typography.callout)
                        .foregroundStyle(Palette.textSecondary)
                }
                AmountDisplay(entry: model.cost.amount, label: "Cost", identifier: "cost.amount")
                KeypadView { model.cost.amount.press($0) }
                details
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Palette.background)
        .navigationTitle("Cost")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .bottomActionBar {
            Button("Continue to price") {
                isSourceFocused = false
                Task { await model.continueToPrice() }
            }
            .buttonStyle(.listoraPrimary)
            .loading(model.isWorking)
            .disabled(model.cost.amount.cents == nil)
            .accessibilityIdentifier("cost.continue")
        }
        .toolbar {
            // Not knowing the cost is the exception, so it stays out of the thumb's way.
            ToolbarItem(placement: .topBarTrailing) {
                Button("Skip") {
                    isSourceFocused = false
                    Task { await model.continueToPrice(skippingCost: true) }
                }
                .disabled(model.isWorking)
                .accessibilityLabel("Skip, I don't know the cost")
                .accessibilityIdentifier("cost.skip")
            }
        }
        .measuresInteraction(model)
        .actionErrorAlert(model)
        .navigationDestination(isPresented: $model.showsPrice) {
            PriceView(model: model, onFinished: onFinished)
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            DatePicker(
                "Bought on",
                selection: $model.cost.purchaseDate,
                in: ...Date(),
                displayedComponents: .date,
            )
            .font(Typography.subheadline.weight(.semibold))
            .foregroundStyle(Palette.textPrimary)
            .tint(Palette.brand.color)
            .frame(minHeight: Layout.minimumTapTarget)
            .accessibilityIdentifier("cost.date")
            Divider().overlay(Palette.separator.color)
            ListoraTextField("Where you bought it") {
                TextField(
                    "Where you bought it",
                    text: $model.cost.source,
                    prompt: Text("Thrift store, estate sale, ...").foregroundStyle(Palette.textSecondary),
                )
                .submitLabel(.done)
                .focused($isSourceFocused)
                .accessibilityIdentifier("cost.source")
            }
            let recent = model.recentSources.sources
            if !recent.isEmpty {
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text("Recent")
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                    FlowLayout {
                        ForEach(recent, id: \.self) { source in
                            ChoiceChip(source, isSelected: model.cost.source == source) {
                                model.cost.source = source
                                isSourceFocused = false
                            }
                            .accessibilityIdentifier("cost.recentSource")
                        }
                    }
                }
            }
        }
        .cardStyle()
    }
}
