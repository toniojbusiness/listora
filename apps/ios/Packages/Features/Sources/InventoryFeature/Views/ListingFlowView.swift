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
        .bottomActionBar {
            Button(model.selected.count > 1 ? "Review \(model.selected.count) listings" : "Review listing") {
                Task { await model.next() }
            }
            .buttonStyle(.listoraPrimary)
            .disabled(!model.canContinue)
            .accessibilityIdentifier("listing.next")
        }
        .navigationTitle("List on")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// "eBay listing", or "Poshmark listing (2 of 2)" when several are reviewed in turn.
    private var reviewTitle: String {
        let name = model.current?.name ?? "Listing"
        guard model.queue.count > 1 else { return "\(name) listing" }
        return "\(name) listing (\(model.position + 1) of \(model.queue.count))"
    }

    private var review: some View {
        Form {
            Section {
                TextField("Title", text: $model.title, axis: .vertical)
                    .font(Typography.body)
                    .accessibilityIdentifier("listing.title")
                if let limit = model.titleLimit {
                    Text("\(model.titleCount) of \(limit) characters")
                        .font(Typography.caption)
                        .foregroundStyle(model.titleCount > limit ? Palette.danger : Palette.textSecondary)
                        .accessibilityIdentifier("listing.titleCount")
                }
            } header: {
                Text("Title")
            } footer: {
                if let current = model.current, current.isAssisted {
                    Text(
                        "Listora puts this in a task in the Tasks tab, with the photos in order and a link to "
                            + "\(current.name). You post it in the \(current.name) app, then tap Done.",
                    )
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityIdentifier("listing.assistedNote")
                }
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
        .bottomActionBar {
            Button(model.sendTitle) {
                Task {
                    if await model.publish() {
                        onDone()
                    }
                }
            }
            .buttonStyle(.listoraPrimary)
            .loading(model.isPublishing)
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
}
