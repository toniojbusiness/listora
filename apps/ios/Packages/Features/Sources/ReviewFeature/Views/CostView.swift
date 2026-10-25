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
                Text(model.cost.amount.display)
                    .font(Typography.largeTitle.monospacedDigit())
                    .foregroundStyle(model.cost.amount.isEmpty ? Palette.textSecondary : Palette.textPrimary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Spacing.sm)
                    .accessibilityLabel("Cost")
                    .accessibilityValue(model.cost.amount.isEmpty ? "None" : model.cost.amount.display)
                    .accessibilityIdentifier("cost.amount")
                KeypadView { model.cost.amount.press($0) }
                details
            }
            .padding(Spacing.md)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Palette.background)
        .navigationTitle("Cost")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) { actions }
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
        VStack(alignment: .leading, spacing: Spacing.sm) {
            DatePicker(
                "Bought on",
                selection: $model.cost.purchaseDate,
                in: ...Date(),
                displayedComponents: .date,
            )
            .font(Typography.body)
            .foregroundStyle(Palette.textPrimary)
            .tint(Palette.brand.color)
            .accessibilityIdentifier("cost.date")
            Divider().overlay(Palette.separator.color)
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text("Where")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                TextField("Thrift store, estate sale, ...", text: $model.cost.source)
                    .font(Typography.body)
                    .foregroundStyle(Palette.textPrimary)
                    .submitLabel(.done)
                    .focused($isSourceFocused)
                    .frame(minHeight: Layout.minimumTapTarget)
                    .accessibilityIdentifier("cost.source")
                let recent = model.recentSources.sources
                if !recent.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: Spacing.xs) {
                            ForEach(recent, id: \.self) { source in
                                Button(source) {
                                    model.cost.source = source
                                    isSourceFocused = false
                                }
                                .font(Typography.callout)
                                .foregroundStyle(model.cost.source == source ? Palette.onBrand : Palette.brand)
                                .padding(.horizontal, Spacing.sm)
                                .frame(minHeight: Layout.minimumTapTarget)
                                .background(
                                    model.cost.source == source ? Palette.brand : Palette.surfaceSecondary,
                                    in: Capsule(),
                                )
                                .accessibilityIdentifier("cost.recentSource")
                            }
                        }
                    }
                }
            }
        }
        .cardStyle()
    }

    private var actions: some View {
        VStack(spacing: Spacing.xs) {
            Button {
                isSourceFocused = false
                Task { await model.continueToPrice() }
            } label: {
                if model.isWorking {
                    ProgressView().tint(Palette.onBrand.color)
                } else {
                    Text("Continue")
                }
            }
            .buttonStyle(.listoraPrimary)
            .disabled(model.cost.amount.cents == nil || model.isWorking)
            .accessibilityIdentifier("cost.continue")
        }
        .bottomBar()
    }
}
