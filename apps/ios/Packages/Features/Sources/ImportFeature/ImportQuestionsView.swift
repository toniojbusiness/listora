import Core
import DesignSystem
import ListoraAPI
import SwiftUI

/// The listings an import was not sure about: each with the items Listora has that it may be.
/// The seller taps the item it is, "It's a different item", or "Don't import".
struct ImportQuestionsView: View {
    @State private var model: ImportQuestionsModel
    let marketplace: String

    init(model: ImportQuestionsModel, marketplace: String) {
        _model = State(initialValue: model)
        self.marketplace = marketplace
    }

    var body: some View {
        content
            .background(Palette.background)
            .navigationTitle("\(marketplace) questions")
            .task { await model.load() }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading where model.questions.isEmpty:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message) where model.questions.isEmpty:
            EmptyStateView(
                systemImage: "questionmark.circle",
                tone: .failed,
                title: "Questions unavailable",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await model.load() } },
            )
        default:
            if model.questions.isEmpty {
                EmptyStateView(
                    systemImage: "checkmark.circle",
                    tone: .success,
                    title: "All answered",
                    message: model.summary ?? "Nothing from this import needs you.",
                )
            } else {
                list
            }
        }
    }

    private var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.md) {
                if let failure = model.failure {
                    Banner(failure, tone: .failed, identifier: "imports.questions.failure")
                }
                ForEach(model.questions, id: \.id) { question in
                    QuestionCard(
                        question: question,
                        marketplace: marketplace,
                        isAnswering: model.answering == question.id,
                        isEnabled: model.answering == nil,
                        answer: { answer in Task { await model.answer(question, answer) } },
                    )
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
            .motion(value: model.questions.map(\.id))
        }
        .refreshable { await model.load() }
    }
}

/// One question: the marketplace's listing, then each item it may be.
private struct QuestionCard: View {
    let question: Components.Schemas.ListingImportQuestion
    let marketplace: String
    let isAnswering: Bool
    let isEnabled: Bool
    let answer: (ImportQuestionsModel.Answer) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .top, spacing: Spacing.sm) {
                thumbnail(question.photoUrl)
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text("On \(marketplace)")
                        .font(Typography.eyebrow)
                        .foregroundStyle(Palette.textSecondary)
                    Text(question.title ?? "Untitled listing")
                        .font(Typography.headline)
                        .foregroundStyle(Palette.textPrimary)
                        .lineLimit(3)
                    if let price = question.price {
                        Text((Decimal(price.amountCents) / 100).formatted(.currency(code: price.currency.rawValue)))
                            .font(Typography.price)
                            .foregroundStyle(Palette.brand)
                    }
                }
            }
            Text("Is it one of these?")
                .font(Typography.subheadline)
                .foregroundStyle(Palette.textSecondary)
            ForEach(question.candidates, id: \.itemId) { candidate in
                Button {
                    answer(.sameItem(itemID: candidate.itemId))
                } label: {
                    HStack(spacing: Spacing.sm) {
                        thumbnail(candidate.coverPhotoUrl)
                        VStack(alignment: .leading, spacing: Spacing.xxs) {
                            Text(candidate.title ?? candidate.sku)
                                .font(Typography.subheadline.weight(.semibold))
                                .foregroundStyle(Palette.textPrimary)
                                .lineLimit(2)
                            Text("\(candidate.sku) · \(candidate.why)")
                                .font(Typography.footnote)
                                .foregroundStyle(Palette.textSecondary)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "checkmark.circle")
                            .foregroundStyle(Palette.brand)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!isEnabled)
                .accessibilityLabel("Same item: \(candidate.title ?? candidate.sku)")
                .accessibilityIdentifier("imports.question.same.\(candidate.itemId)")
            }
            HStack(spacing: Spacing.xs) {
                Button("It's a different item") { answer(.newItem) }
                    .buttonStyle(.listora(.secondary, size: .compact))
                    .accessibilityIdentifier("imports.question.new")
                Button("Don't import") { answer(.skip) }
                    .buttonStyle(.listora(.tertiary, size: .compact))
                    .accessibilityIdentifier("imports.question.skip")
            }
            .disabled(!isEnabled)
            .loading(isAnswering)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
        .accessibilityIdentifier("imports.question.\(question.id)")
    }

    private func thumbnail(_ url: String?) -> some View {
        RemoteImage(url: url.flatMap(URL.init(string:))) {
            Image(systemName: "photo")
                .foregroundStyle(Palette.textSecondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Palette.surfaceSecondary)
        }
        .frame(width: 56, height: 56)
        .clipShape(RoundedRectangle(cornerRadius: Radius.small))
        .accessibilityHidden(true)
    }
}
