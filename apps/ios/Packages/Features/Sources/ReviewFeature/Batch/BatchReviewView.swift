import Core
import DesignSystem
import SwiftUI

/// The rapid review of a batch: swipe through the items; each shows only what Listora was unsure
/// about, the cost on the in-app keypad, and the price, with one tap to approve and move on.
struct BatchReviewView: View {
    @State private var model: BatchReviewModel

    init(
        environment: ReviewEnvironment,
        request: BatchReviewRequest,
        onEvent: @escaping @MainActor (BatchReviewEvent) -> Void,
    ) {
        _model = State(initialValue: BatchReviewModel(request: request, environment: environment, onEvent: onEvent))
    }

    var body: some View {
        Group {
            if model.showsSummary {
                BatchReviewSummaryView(summary: model.summary, total: model.pages.count) { model.finish() }
            } else {
                TabView(selection: $model.index) {
                    ForEach(Array(model.pages.enumerated()), id: \.offset) { index, page in
                        BatchReviewPage(model: page, batch: model, number: index + 1)
                            .tag(index)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                .task(id: model.index) { await model.pageAppeared(model.index) }
            }
        }
        .onAppear { model.setVisible(true) }
        .onDisappear { model.setVisible(false) }
        .background(Palette.background)
        .navigationTitle(model.showsSummary ? "Batch reviewed" : title)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(model.showsSummary)
        .toolbar {
            if !model.showsSummary {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Finish") { model.showsSummary = true }
                        .accessibilityIdentifier("batchReview.finish")
                }
            }
        }
    }

    private var title: String {
        "Item \(model.index + 1) of \(model.pages.count)"
    }
}

/// One item of the rapid review.
struct BatchReviewPage: View {
    @Bindable var model: ReviewFlowModel
    let batch: BatchReviewModel
    let number: Int
    @State private var isApproving = false

    var body: some View {
        content
            .actionErrorAlert(model)
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading, .preparingPhotos, .analyzing:
            VStack {
                AnalysisProgressView(phase: model.phase)
                Button("Skip for now") { batch.skip() }
                    .buttonStyle(.listora(.tertiary, size: .large))
                    .padding(.horizontal, Spacing.md)
                    .accessibilityIdentifier("batchReview.skip")
            }
        case let .failed(problem):
            ProblemView(
                problem: problem,
                onRetry: { Task { await model.start() } },
                onEditPhotos: { batch.skip() },
                onGoBack: { batch.skip() },
            )
        case .reviewing:
            if model.saved != nil {
                saved
            } else {
                review
            }
        case .alreadySaved:
            saved
        }
    }

    private var saved: some View {
        VStack(spacing: Spacing.md) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 48))
                .foregroundStyle(Palette.success)
                .accessibilityHidden(true)
            Text("Saved as \(model.saved?.sku ?? model.item?.sku ?? "")")
                .font(Typography.title3)
                .foregroundStyle(Palette.textPrimary)
                .accessibilityIdentifier("batchReview.saved.\(number)")
            if let price = model.saved?.price {
                Text(price).font(Typography.price).foregroundStyle(Palette.brand)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var review: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                header
                attention
                BatchCostCard(model: model, batch: batch, number: number)
                BatchPriceCard(model: model)
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .bottomActionBar { actions }
        .task {
            if case .idle = model.pricing {
                await model.loadPricing()
            }
        }
    }

    // MARK: Header: photos, SKU, and title

    private var header: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.xs) {
                    ForEach(model.item?.photos ?? [], id: \.id) { photo in
                        AsyncImage(url: photo.urls.flatMap { URL(string: $0.thumbnail) }) { phase in
                            if let image = phase.image {
                                image.resizable().scaledToFill()
                            } else {
                                Palette.surfaceSecondary.color
                            }
                        }
                        .frame(width: 96, height: 96)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
                        .accessibilityHidden(true)
                    }
                }
            }
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(model.item?.sku ?? model.request.sku ?? "Item \(number)")
                    .font(Typography.label)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityIdentifier("batchReview.sku.\(number)")
                Text(model.form?.field(.title).displayValue.nonEmpty ?? "Untitled item")
                    .font(Typography.title3)
                    .foregroundStyle(Palette.textPrimary)
                    .accessibilityAddTraits(.isHeader)
            }
        }
    }

    // MARK: Low-confidence details first

    @ViewBuilder
    private var attention: some View {
        if let form = model.form {
            let keys = form.sections.first { $0.section == .attention }?.keys ?? []
            if keys.isEmpty {
                Label("Nothing to check: Listora is sure of every detail.", systemImage: "checkmark.seal.fill")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.success)
                    .accessibilityIdentifier("batchReview.nothingToCheck.\(number)")
            } else {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Text("Check these (\(keys.count))")
                        .font(Typography.headline)
                        .foregroundStyle(Palette.warning)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("batchReview.attention.\(number)")
                    VStack(spacing: 0) {
                        ForEach(Array(keys.enumerated()), id: \.element) { index, key in
                            if index > 0 {
                                Divider().overlay(Palette.separator.color)
                            }
                            FieldRow(
                                field: form.field(key),
                                draftText: draftText(key),
                                onEdit: { model.beginEditing(key) },
                                onSelect: { value in model.update(key, to: value) },
                                onCommit: { model.commitEditing(key) },
                                onQuickPick: { option in model.choose(option) },
                            )
                        }
                    }
                    .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: Radius.large, style: .continuous)
                            .strokeBorder(Palette.warning, lineWidth: 1),
                    )
                }
            }
        }
    }

    private func draftText(_ key: ReviewFieldKey) -> Binding<String>? {
        guard model.editing?.key == key else { return nil }
        return Binding(
            get: { model.editing?.text ?? "" },
            set: { text in
                if model.editing?.key == key {
                    model.editing?.text = text
                }
            },
        )
    }

    // MARK: Actions

    @ViewBuilder
    private var actions: some View {
        Button {
            Task {
                isApproving = true
                defer { isApproving = false }
                await batch.approve(model)
            }
        } label: {
            Label(approveTitle, systemImage: "checkmark.circle.fill")
        }
        .buttonStyle(.listoraPrimary)
        .loading(isApproving || model.isWorking)
        .disabled(isApproving || model.isWorking)
        .accessibilityIdentifier("batchReview.approve.\(number)")
        Button("Skip for now") { batch.skip() }
            .buttonStyle(.listora(.tertiary, size: .compact))
            .disabled(isApproving)
            .accessibilityIdentifier("batchReview.skipItem.\(number)")
    }

    private var approveTitle: String {
        let isLast = batch.remaining.count <= 1
        if let price = model.chosenPriceLabel {
            return isLast ? "Approve at \(price)" : "Approve at \(price) & next"
        }
        return isLast ? "Approve" : "Approve & next"
    }
}

extension String {
    var nonEmpty: String? {
        isEmpty ? nil : self
    }
}
