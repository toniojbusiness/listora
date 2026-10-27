import Core
import DesignSystem
import ListoraAPI
import SwiftUI

typealias PrefillField = Components.Schemas.PrefillField
typealias PrefillOption = Components.Schemas.PrefillOption

/// What Listora fills in on each marketplace's sell form, for the marketplaces it lists on
/// itself (docs/features/marketplace-prefill.md): the category and size in the marketplace's own
/// names, the details its form shows, and the questions Listora isn't sure of, each a tap on a
/// ranked short list, so a listing never stops for something the review could ask.
struct MarketplacePrefillSection: View {
    let model: ReviewFlowModel
    @State private var browsing: Browse?

    /// A "More" list: every category of a marketplace, or every size of its category.
    struct Browse: Identifiable {
        let id = UUID()
        let marketplace: String
        let field: PrefillField
    }

    var body: some View {
        let marketplaces = model.prefillMarketplaces
        if !marketplaces.isEmpty {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SectionHeader(
                    "On each marketplace's form",
                    subtitle: model.marketplaceQuestions > 0
                        ? "Listora filled in the rest. Pick one where it isn't sure."
                        : "Listora fills these in where it lists for you. Tap one to change it.",
                )
                ForEach(model.prefillItemFields, id: \.key.id) { field in
                    PrefillChoiceRow(field: field, isBusy: model.isAnsweringPrefill) { option in
                        answer(field, marketplace: nil, option: option)
                    }
                    .cardStyle(field.needsAnswer ? .tinted(.actionNeeded) : .flat)
                    .accessibilityIdentifier("review.prefill.\(field.key.id)")
                }
                ForEach(marketplaces, id: \.marketplace.id) { entry in
                    MarketplacePrefillCard(
                        entry: entry,
                        isBusy: model.isAnsweringPrefill,
                        onChoose: { field, option in
                            answer(field, marketplace: entry.marketplace.id, option: option)
                        },
                        onMore: { field in
                            browsing = Browse(marketplace: entry.marketplace.id, field: field)
                        },
                    )
                }
            }
            .sheet(item: $browsing) { browse in
                NavigationStack {
                    PrefillBrowser(model: model, browse: browse) { option in
                        answer(browse.field, marketplace: browse.marketplace, option: option)
                    }
                }
            }
        }
    }

    private func answer(_ field: PrefillField, marketplace: String?, option: PrefillOption) {
        guard let answerField = Components.Schemas.PrefillAnswerField(rawValue: field.key.id) else { return }
        Task { await model.answerPrefill(field: answerField, marketplace: marketplace, value: option.value) }
    }
}

/// One marketplace's form: its category and size, then the details it shows.
private struct MarketplacePrefillCard: View {
    let entry: Components.Schemas.MarketplacePrefill
    let isBusy: Bool
    let onChoose: (PrefillField, PrefillOption) -> Void
    let onMore: (PrefillField) -> Void

    private var name: String {
        Formatting.marketplaceName(entry.marketplace.id)
    }

    private var questions: Int {
        entry.fields.count(where: \.needsAnswer)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(spacing: Spacing.sm) {
                IconTile(monogram: String(name.prefix(1)), tone: questions > 0 ? .actionNeeded : nil)
                Text(name)
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                Spacer(minLength: 0)
                status
            }
            ForEach(choiceFields, id: \.key.id) { field in
                PrefillChoiceRow(
                    field: field,
                    isBusy: isBusy,
                    onChoose: { onChoose(field, $0) },
                    onMore: canBrowse(field) ? { onMore(field) } : nil,
                )
                .accessibilityIdentifier("review.prefill.\(entry.marketplace.id).\(field.key.id)")
            }
            if !infoLine.isEmpty {
                Text(infoLine)
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("review.prefill.\(entry.marketplace.id).details")
            }
        }
        .cardStyle(questions > 0 ? .tinted(.actionNeeded) : .flat)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("review.prefill.\(entry.marketplace.id)")
    }

    @ViewBuilder
    private var status: some View {
        if questions > 0 {
            Chip(questions == 1 ? "1 to pick" : "\(questions) to pick", emphasis: .surface)
        } else if entry.ready {
            Label("Ready", systemImage: StatusTone.success.systemImage)
                .font(Typography.smallEmphasis)
                .foregroundStyle(Palette.success)
        } else {
            Chip("Needs a detail above", emphasis: .muted)
        }
    }

    /// The category and size: the fields with a value to choose.
    private var choiceFields: [PrefillField] {
        entry.fields.filter { ["category", "size"].contains($0.key.id) }
    }

    /// The other details as the form shows them: "Used - Good · Shaka Wear · Black · Cotton".
    private var infoLine: String {
        entry.fields
            .filter { !["category", "size"].contains($0.key.id) }
            .compactMap { $0.value?.label ?? $0.note }
            .joined(separator: " · ")
    }

    private func canBrowse(_ field: PrefillField) -> Bool {
        field.key.id == "category" || !(field.choices ?? []).isEmpty
    }
}

/// A field with a value to choose: its value (or the question), the ranked short list as chips,
/// the reason, and "More" for every other choice the form offers.
private struct PrefillChoiceRow: View {
    let field: PrefillField
    let isBusy: Bool
    let onChoose: (PrefillOption) -> Void
    var onMore: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(spacing: Spacing.xs) {
                Text(field.label)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                if let source = sourceLabel {
                    Chip(source, emphasis: .muted)
                }
            }
            Text(valueText)
                .font(Typography.body)
                .foregroundStyle(field.needsAnswer ? Palette.warning : Palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            if showsChips {
                FlowLayout {
                    ForEach(field.options, id: \.value) { option in
                        ChoiceChip(option.label, isSelected: option.value == field.value?.value) {
                            onChoose(option)
                        }
                        .disabled(isBusy)
                        .accessibilityIdentifier("review.prefill.option.\(option.label)")
                    }
                    if let onMore {
                        ChoiceChip("More", systemImage: "ellipsis", isSelected: false) { onMore() }
                            .disabled(isBusy)
                            .accessibilityIdentifier("review.prefill.more")
                    }
                }
            }
            if let note = field.note {
                Text(note)
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var valueText: String {
        if let value = field.value {
            return value.path.map { $0.joined(separator: " > ") } ?? value.label
        }
        return field.needsAnswer ? "Which one?" : "-"
    }

    /// A question, or a value the seller may want the other way (a unisex item's department).
    private var showsChips: Bool {
        field.needsAnswer || field.options.count > 1
    }

    private var sourceLabel: String? {
        switch field.source?.value1 {
        case .ai: "AI pick"
        case .you: "Your pick"
        case ._default: "Default"
        case .listora, nil: nil
        }
    }
}

/// Every category of a marketplace (or every size of the category), searchable.
private struct PrefillBrowser: View {
    let model: ReviewFlowModel
    let browse: MarketplacePrefillSection.Browse
    let onChoose: (PrefillOption) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var all: [PrefillOption] = []
    @State private var isLoading = false

    var body: some View {
        List {
            if isLoading {
                ProgressView().frame(maxWidth: .infinity)
            }
            ForEach(matching, id: \.value) { option in
                Button {
                    onChoose(option)
                    dismiss()
                } label: {
                    Text(option.path.map { $0.joined(separator: " > ") } ?? option.label)
                        .foregroundStyle(Palette.textPrimary)
                }
                .accessibilityIdentifier("review.prefill.browse.\(option.value)")
            }
        }
        .searchable(text: $query, prompt: "Search \(name)")
        .navigationTitle("\(name) \(browse.field.label.lowercased())")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
        }
        .task { await load() }
    }

    private var name: String {
        Formatting.marketplaceName(browse.marketplace)
    }

    private var matching: [PrefillOption] {
        let words = query.lowercased().split(separator: " ").map(String.init)
        guard !words.isEmpty else { return all }
        return all.filter { option in
            let text = (option.path?.joined(separator: " ") ?? option.label).lowercased()
            return words.allSatisfy { text.contains($0) }
        }
    }

    private func load() async {
        if let choices = browse.field.choices, !choices.isEmpty {
            all = choices
            return
        }
        isLoading = true
        defer { isLoading = false }
        all = await model.allCategories(marketplace: browse.marketplace).map { category in
            PrefillOption(value: category.ref, label: category.path.joined(separator: " > "), path: category.path)
        }
    }
}
