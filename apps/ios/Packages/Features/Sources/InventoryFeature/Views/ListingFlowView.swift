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
                        .accessibilityIdentifier("listing.cancel")
                }
            }
        }
        .task { await model.prepare() }
        .interactiveDismissDisabled(model.isPublishing)
    }

    private var chooser: some View {
        List {
            Section {
                ForEach(model.choices) { choice in
                    Toggle(isOn: Binding(
                        get: { model.selected.contains(choice.id) },
                        set: { isOn in
                            if isOn {
                                model.selected.insert(choice.id)
                            } else {
                                model.selected.remove(choice.id)
                            }
                        },
                    )) {
                        VStack(alignment: .leading, spacing: Spacing.xxs) {
                            Text(choice.name)
                                .font(Typography.headline)
                                .foregroundStyle(Palette.textPrimary)
                            Text(choice.detail)
                                .font(Typography.callout)
                                .foregroundStyle(Palette.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .tint(Palette.brand.color)
                    .disabled(!choice.isAvailable)
                    .accessibilityIdentifier("listing.choose.\(choice.id)")
                    .listRowBackground(Palette.surface.color)
                }
            } footer: {
                Text("Listora lists on each marketplace once you review its version of the listing.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
            }
        }
        .scrollContentBackground(.hidden)
        .overlay {
            if model.isPreparing, model.choices.isEmpty {
                ProgressView()
            }
        }
        .safeAreaInset(edge: .bottom) {
            Button("Review eBay listing") { model.next() }
                .buttonStyle(.listoraPrimary)
                .disabled(!model.canContinue)
                .padding(Spacing.md)
                .background(Palette.background)
                .accessibilityIdentifier("listing.next")
        }
        .navigationTitle("List on")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var review: some View {
        Form {
            Section {
                TextField("Title", text: $model.title, axis: .vertical)
                    .font(Typography.body)
                    .accessibilityIdentifier("listing.title")
                Text("\(model.titleCount) of \(ListingFlowModel.ebayTitleLimit) characters")
                    .font(Typography.caption)
                    .foregroundStyle(model.titleCount > ListingFlowModel.ebayTitleLimit ? Palette.danger : Palette
                        .textSecondary)
                    .accessibilityIdentifier("listing.titleCount")
            } header: {
                Text("Title")
            }
            .listRowBackground(Palette.surface.color)
            Section("Description") {
                TextField("Description", text: $model.description, axis: .vertical)
                    .lineLimit(4 ... 12)
                    .font(Typography.body)
                    .accessibilityIdentifier("listing.description")
            }
            .listRowBackground(Palette.surface.color)
            Section("Price") {
                HStack {
                    Text("$").foregroundStyle(Palette.textSecondary)
                    TextField("0.00", text: $model.price)
                        .keyboardType(.decimalPad)
                        .font(Typography.price)
                        .accessibilityIdentifier("listing.price")
                }
            }
            .listRowBackground(Palette.surface.color)
            if let problem = model.problem {
                Section {
                    Label(problem, systemImage: "exclamationmark.triangle.fill")
                        .font(Typography.callout)
                        .foregroundStyle(Palette.danger)
                        .accessibilityIdentifier("listing.problem")
                }
                .listRowBackground(Palette.surface.color)
            }
        }
        .scrollContentBackground(.hidden)
        .safeAreaInset(edge: .bottom) {
            Button {
                Task {
                    if await model.publish() {
                        onDone()
                    }
                }
            } label: {
                HStack(spacing: Spacing.xs) {
                    if model.isPublishing {
                        ProgressView().tint(Palette.onBrand.color)
                    }
                    Text(model.isPublishing ? "Publishing..." : "Publish to eBay")
                }
            }
            .buttonStyle(.listoraPrimary)
            .disabled(model.isPublishing)
            .padding(Spacing.md)
            .background(Palette.background)
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
