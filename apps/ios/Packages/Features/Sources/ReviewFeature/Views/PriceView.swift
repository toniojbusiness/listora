import Core
import DesignSystem
import SwiftUI

/// The price: the "Don't sell below" floor per marketplace, the three tiers with the server's
/// source labels, the AI estimate labeled as such, and research links that open in Safari.
struct PriceView: View {
    @Bindable var model: ReviewFlowModel
    let onFinished: @MainActor (ItemReviewOutcome) -> Void
    @State private var isEnteringPrice = false

    var body: some View {
        content
            .background(Palette.background)
            .navigationTitle("Price")
            .navigationBarTitleDisplayMode(.inline)
            .measuresInteraction(model)
            .actionErrorAlert(model)
            .sheet(isPresented: $isEnteringPrice) {
                CustomPriceView(initial: model.chosenCents) { cents in
                    model.priceChoice = .custom(cents)
                }
                .presentationDetents([.large])
            }
            .navigationDestination(isPresented: $model.showsSaved) {
                if let saved = model.saved {
                    SavedItemView(saved: saved) { onFinished(.saved(sku: saved.sku)) }
                        .navigationBarBackButtonHidden()
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.pricing {
        case .idle, .loading:
            ProgressView("Working out prices")
                .foregroundStyle(Palette.textSecondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("price.loading")
        case let .failed(message):
            ProblemView(
                problem: .init(
                    title: "Couldn't load prices",
                    message: message,
                    canRetry: true,
                    suggestsEditingPhotos: false,
                ),
                onRetry: { Task { await model.loadPricing() } },
                onEditPhotos: {},
                onGoBack: {},
            )
        case let .loaded(presentation):
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    tiers(presentation)
                    floors(presentation)
                    marketData(presentation)
                    research(presentation)
                }
                .padding(Spacing.md)
            }
            .safeAreaInset(edge: .bottom) { saveBar(presentation) }
        }
    }

    // MARK: Tiers

    private func tiers(_ presentation: PricingPresentation) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            heading("Choose a price")
            if presentation.tiers.isEmpty {
                Text("There is no estimate for this item. Set your own price.")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.textSecondary)
            }
            ForEach(presentation.tiers) { tier in
                choiceButton(
                    title: tier.label,
                    price: tier.price,
                    isSelected: model.priceChoice == .tier(tier.tier),
                    identifier: "price.tier.\(tier.tier.rawValue)",
                ) {
                    model.priceChoice = .tier(tier.tier)
                }
            }
            if case let .custom(cents) = model.priceChoice {
                choiceButton(
                    title: "Your price",
                    price: Formatting.money(cents: cents),
                    isSelected: true,
                    identifier: "price.custom",
                ) {
                    isEnteringPrice = true
                }
            }
            Button("Set my own price") { isEnteringPrice = true }
                .font(Typography.headline)
                .foregroundStyle(Palette.brand)
                .frame(minHeight: Layout.minimumTapTarget)
                .accessibilityIdentifier("price.setOwn")
        }
    }

    private func choiceButton(
        title: String,
        price: String,
        isSelected: Bool,
        identifier: String,
        action: @escaping () -> Void,
    ) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
        return Button(action: action) {
            HStack(spacing: Spacing.sm) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(Typography.headline)
                    .foregroundStyle(isSelected ? Palette.brand : Palette.textSecondary)
                    .accessibilityHidden(true)
                Text(title)
                    .font(Typography.body)
                    .foregroundStyle(Palette.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(price)
                    .font(Typography.price)
                    .foregroundStyle(Palette.textPrimary)
            }
            .padding(Spacing.md)
            .frame(minHeight: Layout.buttonHeight)
            .background(Palette.surface, in: shape)
            .overlay(shape.strokeBorder(isSelected ? Palette.brand : Palette.separator, lineWidth: isSelected ? 2 : 1))
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier(identifier)
    }

    // MARK: Floors

    private func floors(_ presentation: PricingPresentation) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            heading("Don't sell below")
            if presentation.floors.isEmpty {
                Text("Add what you paid to see the lowest price that covers it on each marketplace.")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityIdentifier("price.noFloors")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(presentation.floors.enumerated()), id: \.element.id) { index, floor in
                        if index > 0 {
                            Divider().overlay(Palette.separator.color)
                        }
                        FloorRow(floor: floor)
                    }
                }
                .cardBackground()
            }
        }
    }

    // MARK: Estimate and sold data

    private func marketData(_ presentation: PricingPresentation) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            heading("Where the prices come from")
            VStack(alignment: .leading, spacing: Spacing.sm) {
                if let estimate = presentation.estimate {
                    VStack(alignment: .leading, spacing: Spacing.xxs) {
                        Text(estimate.label)
                            .font(Typography.headline)
                            .foregroundStyle(Palette.textPrimary)
                            .accessibilityIdentifier("price.estimateLabel")
                        Text("\(estimate.range) · \(estimate.confidence)")
                            .font(Typography.callout)
                            .foregroundStyle(Palette.textSecondary)
                            .accessibilityIdentifier("price.estimateDetail")
                    }
                }
                if let message = presentation.noSoldDataMessage {
                    Text(message)
                        .font(Typography.callout)
                        .foregroundStyle(Palette.textSecondary)
                        .accessibilityIdentifier("price.noSoldData")
                }
                ForEach(presentation.soldData) { sold in
                    VStack(alignment: .leading, spacing: Spacing.xxs) {
                        Text(sold.label)
                            .font(Typography.headline)
                            .foregroundStyle(Palette.textPrimary)
                        Text(sold.summary)
                            .font(Typography.callout)
                            .foregroundStyle(Palette.textSecondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .cardStyle()
        }
    }

    @ViewBuilder
    private func research(_ presentation: PricingPresentation) -> some View {
        if !presentation.researchLinks.isEmpty {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                heading("Research")
                Text("Opens in Safari. Listora doesn't read these pages.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                VStack(spacing: 0) {
                    ForEach(Array(presentation.researchLinks.enumerated()), id: \.element.id) { index, link in
                        if index > 0 {
                            Divider().overlay(Palette.separator.color)
                        }
                        Link(destination: link.url) {
                            HStack {
                                Text(link.label)
                                    .font(Typography.body)
                                    .foregroundStyle(Palette.brand)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                Image(systemName: "safari")
                                    .foregroundStyle(Palette.textSecondary)
                                    .accessibilityHidden(true)
                            }
                            .padding(Spacing.md)
                            .frame(minHeight: Layout.minimumTapTarget)
                            .contentShape(Rectangle())
                        }
                        .accessibilityIdentifier("price.research.\(index)")
                    }
                }
                .cardBackground()
            }
        }
    }

    // MARK: Save

    private func saveBar(_ presentation: PricingPresentation) -> some View {
        VStack(spacing: Spacing.xs) {
            if let cents = model.chosenCents, let warning = presentation.warning(for: cents) {
                Label(warning, systemImage: "exclamationmark.triangle.fill")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.warning)
                    .accessibilityIdentifier("price.belowFloor")
            }
            Button {
                Task { await model.save() }
            } label: {
                if model.isWorking {
                    ProgressView().tint(Palette.onBrand.color)
                } else if let cents = model.chosenCents {
                    Text("Save item at \(Formatting.money(cents: cents))")
                } else {
                    Text("Save item")
                }
            }
            .buttonStyle(.listoraPrimary)
            .disabled(model.chosenCents == nil || model.isWorking)
            .accessibilityIdentifier("price.save")
        }
        .bottomBar()
    }

    private func heading(_ text: String) -> some View {
        Text(text)
            .font(Typography.headline)
            .foregroundStyle(Palette.textPrimary)
            .accessibilityAddTraits(.isHeader)
    }
}

/// One marketplace's floor; tap to see how it adds up.
private struct FloorRow: View {
    let floor: PricingPresentation.Floor
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Button {
                isExpanded.toggle()
            } label: {
                HStack {
                    Text(floor.name)
                        .font(Typography.body)
                        .foregroundStyle(Palette.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(floor.price)
                        .font(Typography.price)
                        .foregroundStyle(Palette.textPrimary)
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(Typography.caption.weight(.semibold))
                        .foregroundStyle(Palette.textSecondary)
                        .accessibilityHidden(true)
                }
                .frame(minHeight: Layout.minimumTapTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(floor.name), don't sell below \(floor.price)")
            .accessibilityHint(isExpanded ? "Hides how it adds up" : "Shows how it adds up")
            .accessibilityIdentifier("price.floor.\(floor.marketplace)")
            if isExpanded {
                ForEach(floor.breakdown, id: \.label) { line in
                    HStack {
                        Text(line.label)
                        Spacer()
                        Text(line.amount).monospacedDigit()
                    }
                    .font(Typography.callout)
                    .foregroundStyle(Palette.textSecondary)
                }
                Text(floor.feeNote)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
            }
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, Spacing.xs)
    }
}

/// The seller's own price on the keypad.
private struct CustomPriceView: View {
    let onDone: (Int64) -> Void
    @State private var entry: AmountEntry
    @Environment(\.dismiss) private var dismiss

    init(initial: Int64?, onDone: @escaping (Int64) -> Void) {
        self.onDone = onDone
        _entry = State(initialValue: initial.map(AmountEntry.init(cents:)) ?? AmountEntry())
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: Spacing.lg) {
                Text(entry.display)
                    .font(Typography.largeTitle.monospacedDigit())
                    .foregroundStyle(entry.isEmpty ? Palette.textSecondary : Palette.textPrimary)
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel("Price")
                    .accessibilityValue(entry.display)
                    .accessibilityIdentifier("price.customAmount")
                KeypadView { entry.press($0) }
                Spacer(minLength: 0)
            }
            .padding(Spacing.md)
            .background(Palette.background)
            .navigationTitle("Your price")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Use") {
                        if let cents = entry.cents {
                            onDone(cents)
                        }
                        dismiss()
                    }
                    .disabled((entry.cents ?? 0) <= 0)
                    .accessibilityIdentifier("price.customUse")
                }
            }
        }
    }
}
