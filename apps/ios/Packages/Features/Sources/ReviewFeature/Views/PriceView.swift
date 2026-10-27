import Core
import DesignSystem
import SwiftUI

/// The price: the three tiers with the server's source labels, each with whether it clears the
/// "Don't sell below" floors, the floor per marketplace against the chosen price, the AI estimate
/// labeled as such, and research links that open in Safari.
struct PriceView: View {
    @Bindable var model: ReviewFlowModel
    let onFinished: @MainActor (ItemReviewOutcome) -> Void
    @State private var isEnteringPrice = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        content
            .background(Palette.background)
            .navigationTitle("Price")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .tabBar)
            .measuresInteraction(model)
            .actionErrorAlert(model)
            .sheet(isPresented: $isEnteringPrice) {
                CustomPriceView(initial: model.chosenCents, presentation: loadedPresentation) { cents in
                    model.priceChoice = .custom(cents)
                }
                .presentationDetents([.large])
            }
            .navigationDestination(isPresented: $model.showsSaved) {
                if let saved = model.saved {
                    SavedItemView(
                        saved: saved,
                        onDone: { onFinished(.saved(sku: saved.sku)) },
                        onListNow: { onFinished(.saved(sku: saved.sku, listNow: true)) },
                    )
                    .navigationBarBackButtonHidden()
                }
            }
    }

    private var loadedPresentation: PricingPresentation? {
        if case let .loaded(presentation) = model.pricing {
            return presentation
        }
        return nil
    }

    @ViewBuilder
    private var content: some View {
        switch model.pricing {
        case .idle, .loading:
            PriceSkeleton()
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
                .frame(maxWidth: Layout.readableWidth)
                .frame(maxWidth: .infinity)
            }
            .bottomActionBar { saveBar(presentation) }
        }
    }

    // MARK: Tiers

    private func tiers(_ presentation: PricingPresentation) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            SectionHeader(
                "Choose a price",
                subtitle: presentation.tiers.isEmpty ? "There is no estimate for this item. Set your own price." : nil,
            )
            ForEach(presentation.tiers) { tier in
                PriceOption(
                    title: tier.label,
                    price: tier.price,
                    warning: presentation.shortWarning(for: tier.cents),
                    isSelected: model.priceChoice == .tier(tier.tier),
                    identifier: "price.tier.\(tier.tier.rawValue)",
                ) {
                    model.priceChoice = .tier(tier.tier)
                }
            }
            if case let .custom(cents) = model.priceChoice {
                PriceOption(
                    title: "Your price",
                    price: Formatting.money(cents: cents),
                    warning: presentation.shortWarning(for: cents),
                    isSelected: true,
                    identifier: "price.custom",
                ) {
                    isEnteringPrice = true
                }
            }
            Button("Set my own price", systemImage: "pencil") { isEnteringPrice = true }
                .buttonStyle(.listoraSecondary)
                .accessibilityIdentifier("price.setOwn")
        }
    }

    // MARK: Floors

    private func floors(_ presentation: PricingPresentation) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            if presentation.floors.isEmpty {
                SectionHeader("Don't sell below")
                Text("Add what you paid to see the lowest price that covers it on each marketplace.")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.textSecondary)
                    .cardStyle(.flat)
                    .accessibilityIdentifier("price.noFloors")
            } else {
                SectionHeader(
                    "Don't sell below",
                    subtitle: "The lowest price that still covers your cost, fees, shipping, and minimum profit. "
                        + "Tap one to see how it adds up.",
                )
                VStack(spacing: 0) {
                    ForEach(Array(presentation.floors.enumerated()), id: \.element.id) { index, floor in
                        if index > 0 {
                            Divider().overlay(Palette.separator.color).padding(.leading, Spacing.md)
                        }
                        FloorRow(floor: floor, chosenCents: model.chosenCents)
                    }
                }
                .cardStyle(.flat, padding: 0)
            }
        }
    }

    // MARK: Estimate and sold data

    private func marketData(_ presentation: PricingPresentation) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            SectionHeader("Where the prices come from")
            VStack(alignment: .leading, spacing: Spacing.md) {
                if let estimate = presentation.estimate {
                    HStack(alignment: .top, spacing: Spacing.sm) {
                        IconTile(systemImage: "sparkles")
                        VStack(alignment: .leading, spacing: Spacing.xxs) {
                            Text(estimate.label)
                                .font(Typography.headline)
                                .foregroundStyle(Palette.textPrimary)
                                .accessibilityIdentifier("price.estimateLabel")
                            Text("\(estimate.range) · \(estimate.confidence)")
                                .font(Typography.subheadline)
                                .foregroundStyle(Palette.textSecondary)
                                .accessibilityIdentifier("price.estimateDetail")
                        }
                    }
                }
                if let message = presentation.noSoldDataMessage {
                    HStack(alignment: .top, spacing: Spacing.sm) {
                        IconTile(systemImage: "chart.bar.xaxis", tone: .neutral)
                        Text(message)
                            .font(Typography.subheadline)
                            .foregroundStyle(Palette.textSecondary)
                            .frame(minHeight: 36)
                            .accessibilityIdentifier("price.noSoldData")
                    }
                }
                ForEach(presentation.soldData) { sold in
                    HStack(alignment: .top, spacing: Spacing.sm) {
                        IconTile(systemImage: "chart.bar.xaxis")
                        VStack(alignment: .leading, spacing: Spacing.xxs) {
                            Text(sold.label)
                                .font(Typography.headline)
                                .foregroundStyle(Palette.textPrimary)
                            Text(sold.summary)
                                .font(Typography.subheadline)
                                .foregroundStyle(Palette.textSecondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .cardStyle(.flat)
        }
    }

    @ViewBuilder
    private func research(_ presentation: PricingPresentation) -> some View {
        if !presentation.researchLinks.isEmpty {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SectionHeader("Research", subtitle: "Opens in Safari. Listora doesn't read these pages.")
                VStack(spacing: 0) {
                    ForEach(Array(presentation.researchLinks.enumerated()), id: \.element.id) { index, link in
                        if index > 0 {
                            Divider().overlay(Palette.separator.color).padding(.leading, Spacing.md)
                        }
                        Link(destination: link.url) {
                            ListRow(link.label, systemImage: "safari") {
                                Image(systemName: "arrow.up.right")
                                    .font(Typography.smallEmphasis)
                                    .foregroundStyle(Palette.textSecondary)
                                    .accessibilityHidden(true)
                            }
                            .padding(.horizontal, Spacing.md)
                            .padding(.vertical, Spacing.xs)
                        }
                        .accessibilityIdentifier("price.research.\(index)")
                    }
                }
                .cardStyle(.flat, padding: 0)
            }
        }
    }

    // MARK: Save

    @ViewBuilder
    private func saveBar(_ presentation: PricingPresentation) -> some View {
        // At accessibility sizes the short form, so the bar leaves room for the screen.
        if let cents = model.chosenCents,
           let warning = dynamicTypeSize.isAccessibilitySize
           ? presentation.shortWarning(for: cents) : presentation.warning(for: cents)
        {
            Label(warning, systemImage: "exclamationmark.triangle.fill")
                .font(Typography.smallEmphasis)
                .foregroundStyle(Palette.warning)
                .dynamicTypeSize(...DynamicTypeSize.accessibility2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("price.belowFloor")
        }
        Button {
            Task { await model.save() }
        } label: {
            if let cents = model.chosenCents {
                Text("Save item at \(Formatting.money(cents: cents))")
            } else {
                Text("Save item")
            }
        }
        .buttonStyle(.listoraPrimary)
        .loading(model.isWorking)
        .disabled(model.chosenCents == nil)
        .accessibilityIdentifier("price.save")
    }
}
