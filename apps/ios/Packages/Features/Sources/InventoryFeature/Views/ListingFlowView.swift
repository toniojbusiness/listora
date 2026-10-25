import DesignSystem
import SwiftUI

extension ListingFlowModel: Identifiable {}

/// The List flow: choose marketplaces, review the eBay listing, publish. Publishing closes the
/// sheet as soon as the server has queued it; the item screen then shows its progress.
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
                        SkeletonRow().cardStyle(.outlined)
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
            Button("Review eBay listing", systemImage: "arrow.right") { model.next() }
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
                        "eBay won't take it like this yet",
                        message: problem,
                        tone: .failed,
                        identifier: "listing.problem",
                    )
                    .transition(.rise)
                }
                ListoraTextField(
                    "Title",
                    hint: "\(model.titleCount) of \(ListingFlowModel.ebayTitleLimit) characters",
                    error: model.titleCount > ListingFlowModel.ebayTitleLimit
                        ? "\(model.titleCount) of \(ListingFlowModel.ebayTitleLimit) characters: shorten it"
                        : nil,
                ) {
                    TextField("Title", text: $model.title, axis: .vertical)
                        .accessibilityIdentifier("listing.title")
                }
                ListoraTextField("Description") {
                    TextField("Description", text: $model.description, axis: .vertical)
                        .lineLimit(4 ... 12)
                        .accessibilityIdentifier("listing.description")
                }
                PriceField("Price", minorUnits: $model.priceCents, hint: "What buyers pay on eBay.")
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
            .motion(value: model.problem)
        }
        .scrollDismissesKeyboard(.interactively)
        .bottomActionBar {
            Button(model.isPublishing ? "Publishing..." : "Publish to eBay", systemImage: "paperplane.fill") {
                Task {
                    if await model.publish() {
                        onDone()
                    }
                }
            }
            .buttonStyle(.listoraPrimary)
            .loading(model.isPublishing)
            .disabled(model.isPublishing)
            .accessibilityIdentifier("listing.publish")
        }
        .navigationTitle("eBay listing")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Back") { model.back() }
                    .disabled(model.isPublishing)
            }
        }
    }
}

/// One marketplace in the picker: its tile, how Listora works with it, and the switch.
private struct ChoiceRow: View {
    let choice: ListingFlowModel.Choice
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            HStack(alignment: .center, spacing: Spacing.sm) {
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
        .cardStyle(.outlined)
        .accessibilityIdentifier("listing.choose.\(choice.id)")
    }
}
