import DesignSystem
import ListoraAPI
import SwiftUI

/// A change to a live listing's details: its title and description, the rest of the listing as
/// it is. Offered only where the server offers `revise` (where it passed live, or in the owner's
/// Test mode, docs/features/test-mode.md).
struct ListingRevision: Identifiable, Equatable {
    let listingID: String
    /// The marketplace id (`depop`).
    let marketplace: String
    let name: String
    let current: ListingVariant
    /// Edit listing shows only because of Test mode: the sheet says so.
    let testing: Bool

    var id: String {
        listingID
    }

    /// The listing's variant with the new title and description; `nil` when neither changed or
    /// the title is empty.
    func revised(title: String, description: String) -> ListingVariant? {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let description = description.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title != current.title || description != current.description else { return nil }
        var variant = current
        variant.title = title
        variant.description = description
        return variant
    }
}

/// The live listing's new title and description. Saving queues the change; the item screen shows
/// it as done only once the marketplace confirms it, and a failure shows with Retry.
struct ReviseListingView: View {
    let revision: ListingRevision
    let save: (ListingVariant) -> Void
    @State private var title: String
    @State private var description: String
    @Environment(\.dismiss) private var dismiss

    init(revision: ListingRevision, save: @escaping (ListingVariant) -> Void) {
        self.revision = revision
        self.save = save
        _title = State(initialValue: revision.current.title)
        _description = State(initialValue: revision.current.description)
    }

    private var revised: ListingVariant? {
        revision.revised(title: title, description: description)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    if revision.testing {
                        HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                            TestingTag()
                            Text("Editing a live \(revision.name) listing hasn't passed a live test yet.")
                                .font(Typography.footnote)
                                .foregroundStyle(Palette.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    ListoraTextField("Title") {
                        TextField("Title", text: $title, axis: .vertical)
                            .accessibilityIdentifier("revise.title")
                    }
                    ListoraTextField("Description") {
                        TextField("Description", text: $description, axis: .vertical)
                            .lineLimit(4 ... 12)
                            .accessibilityIdentifier("revise.description")
                    }
                }
                .padding(Spacing.md)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Palette.background)
            .bottomActionBar {
                Button("Save changes", systemImage: "checkmark") {
                    if let revised {
                        save(revised)
                    }
                }
                .buttonStyle(.listoraPrimary)
                .disabled(revised == nil)
                .accessibilityIdentifier("revise.save")
            }
            .navigationTitle("Edit on \(revision.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
    }
}
