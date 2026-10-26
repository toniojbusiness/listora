import DesignSystem
import ListoraAPI
import SwiftUI

extension ListingFlowModel: Identifiable {}

/// The List flow: choose marketplaces, review each one's listing in turn, and send it: eBay
/// publishes through its API, an assisted marketplace gets a task. The sheet closes once the last
/// one is queued; the item screen then shows their progress.
struct ListingFlowView: View {
    @Bindable var model: ListingFlowModel
    let onDone: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                switch model.step {
                case .choose: chooser
                case .review: review
                }
            }
            .background(Palette.background)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Cancel", action: onDone)
                        .disabled(model.isPublishing)
                        .accessibilityIdentifier("listing.cancel")
                }
            }
        }
        .task { await model.prepare() }
        .interactiveDismissDisabled(model.isPublishing)
    }

    private var chooser: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SectionHeader(
                    "Where to list",
                    subtitle: "You review each marketplace's version of the listing before it goes live.",
                )
                if model.isPreparing, model.choices.isEmpty {
                    ForEach(0 ..< 4, id: \.self) { _ in
                        SkeletonRow().cardStyle(.flat)
                    }
                }
                ForEach(model.choices) { choice in
                    ChoiceRow(choice: choice, isOn: Binding(
                        get: { model.selected.contains(choice.id) },
                        set: { isOn in
                            if isOn {
                                model.selected.insert(choice.id)
                            } else {
                                model.selected.remove(choice.id)
                            }
                        },
                    ))
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
        }
        .bottomActionBar {
            Button(
                model.selected.count > 1 ? "Review \(model.selected.count) listings" : "Review listing",
                systemImage: "arrow.right",
            ) { Task { await model.next() } }
                .buttonStyle(.listoraPrimary)
                .disabled(!model.canContinue)
                .accessibilityIdentifier("listing.next")
        }
        .navigationTitle("List on")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var review: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.md) {
                if let problem = model.problem {
                    Banner(
                        "\(model.current?.name ?? "The marketplace") won't take it like this yet",
                        message: problem,
                        tone: .failed,
                        identifier: "listing.problem",
                    )
                    .transition(.rise)
                }
                if let current = model.current, current.isAssisted {
                    Banner(
                        "You post this one in the \(current.name) app",
                        message: "Listora puts it in a task in the Tasks tab, with the photos in order and a link to "
                            + "\(current.name). Then you tap Done.",
                        tone: .actionNeeded,
                        systemImage: "checklist",
                        identifier: "listing.assistedNote",
                    )
                }
                ListoraTextField(
                    "Title",
                    hint: model.titleLimit.map { "\(model.titleCount) of \($0) characters" },
                    error: model.titleLimit.flatMap { limit in
                        model.titleCount > limit ? "\(model.titleCount) of \(limit) characters: shorten it" : nil
                    },
                ) {
                    TextField("Title", text: $model.title, axis: .vertical)
                        .accessibilityIdentifier("listing.title")
                }
                ListoraTextField("Description") {
                    TextField("Description", text: $model.description, axis: .vertical)
                        .lineLimit(4 ... 12)
                        .accessibilityIdentifier("listing.description")
                }
                PriceField(
                    "Price",
                    minorUnits: $model.priceCents,
                    hint: "What buyers pay on \(model.current?.name ?? "the marketplace").",
                )
                if let categories = model.categories {
                    CategoryRow(
                        marketplace: model.current?.name ?? "the marketplace",
                        category: model.category,
                        categories: categories,
                        onChoose: model.chooseCategory,
                    )
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
            .motion(value: model.problem)
        }
        .scrollDismissesKeyboard(.interactively)
        .bottomActionBar {
            Button(model.sendTitle, systemImage: model.current?.isAssisted == true ? "checklist" : "paperplane.fill") {
                Task {
                    if await model.publish() {
                        // Sent, not yet confirmed: a light tap, not a success.
                        Haptics.play(.tap)
                        onDone()
                    }
                }
            }
            .buttonStyle(.listoraPrimary)
            .loading(model.isPublishing)
            .disabled(model.isPublishing)
            .accessibilityIdentifier("listing.publish")
        }
        .navigationTitle(reviewTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                // Once one marketplace is sent, the rest follow in turn.
                Button("Back") { model.back() }
                    .disabled(model.isPublishing || model.position > 0)
            }
        }
    }

    /// "eBay listing", or "Poshmark listing (2 of 2)" when several are reviewed in turn.
    private var reviewTitle: String {
        let name = model.current?.name ?? "Listing"
        guard model.queue.count > 1 else { return "\(name) listing" }
        return "\(name) listing (\(model.position + 1) of \(model.queue.count))"
    }
}

/// One marketplace in the picker: its tile, how Listora works with it, and the switch.
private struct ChoiceRow: View {
    let choice: ListingFlowModel.Choice
    @Binding var isOn: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        // The tile above the text at accessibility sizes, leaving the text room beside the switch.
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.xs))
            : AnyLayout(HStackLayout(alignment: .center, spacing: Spacing.sm))
        Toggle(isOn: $isOn) {
            layout {
                IconTile(monogram: String(choice.name.prefix(1)), tone: choice.isAvailable ? nil : .neutral)
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(choice.name)
                        .font(Typography.headline)
                        .foregroundStyle(Palette.textPrimary)
                    Text(choice.detail)
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .tint(Palette.brand.color)
        .disabled(!choice.isAvailable)
        .cardStyle(.flat)
        // A toggle reads every text in its label, the tile's letter too; name what matters.
        .accessibilityLabel("\(choice.name), \(choice.detail)")
        .accessibilityIdentifier("listing.choose.\(choice.id)")
    }
}

/// The listing's category on the marketplace: the one Listora maps the item to, or the seller's
/// pick from that marketplace's own categories when Listora can't tell (a unisex item).
private struct CategoryRow: View {
    let marketplace: String
    let category: Components.Schemas.MarketplaceCategory?
    let categories: Components.Schemas.MarketplaceCategories
    let onChoose: (Components.Schemas.MarketplaceCategory) -> Void

    var body: some View {
        NavigationLink {
            CategoryPicker(marketplace: marketplace, categories: categories, onChoose: onChoose)
        } label: {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text("\(marketplace) category")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                Text(category.map { $0.path.joined(separator: " > ") } ?? "Choose one")
                    .font(Typography.body)
                    .foregroundStyle(category == nil ? Palette.danger : Palette.textPrimary)
                    .multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Spacing.sm)
            .background(Palette.surface.color, in: RoundedRectangle(cornerRadius: Radius.medium))
        }
        .accessibilityIdentifier("listing.category")
    }
}

/// The marketplace's categories to pick from, the likely ones first, with a search.
private struct CategoryPicker: View {
    let marketplace: String
    let categories: Components.Schemas.MarketplaceCategories
    let onChoose: (Components.Schemas.MarketplaceCategory) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        List {
            if query.isEmpty, !categories.likely.isEmpty {
                Section("Likely") {
                    ForEach(categories.likely, id: \.ref) { row($0) }
                }
            }
            Section(query.isEmpty ? "All \(marketplace) categories" : "Matches") {
                ForEach(matching, id: \.ref) { row($0) }
            }
        }
        .searchable(text: $query, prompt: "Search \(marketplace) categories")
        .navigationTitle("\(marketplace) category")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var matching: [Components.Schemas.MarketplaceCategory] {
        let words = query.lowercased().split(separator: " ").map(String.init)
        guard !words.isEmpty else { return categories.choices }
        return categories.choices.filter { choice in
            let text = choice.path.joined(separator: " ").lowercased()
            return words.allSatisfy { text.contains($0) }
        }
    }

    private func row(_ choice: Components.Schemas.MarketplaceCategory) -> some View {
        Button {
            onChoose(choice)
            dismiss()
        } label: {
            Text(choice.path.joined(separator: " > "))
                .foregroundStyle(Palette.textPrimary)
        }
        .accessibilityIdentifier("listing.category.\(choice.ref)")
    }
}
