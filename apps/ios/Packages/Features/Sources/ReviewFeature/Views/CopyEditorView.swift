import Core
import DesignSystem
import SwiftUI

/// Edits one marketplace's title, description, and (on Depop) hashtags, with the marketplace's
/// limits counted as the seller types.
struct CopyEditorView: View {
    let copy: MarketplaceCopy
    let onSave: (ListingCopy) -> Void
    @State private var title: String
    @State private var description: String
    @State private var hashtags: String
    @Environment(\.dismiss) private var dismiss

    init(copy: MarketplaceCopy, onSave: @escaping (ListingCopy) -> Void) {
        self.copy = copy
        self.onSave = onSave
        _title = State(initialValue: copy.current.title)
        _description = State(initialValue: copy.current.description)
        _hashtags = State(initialValue: copy.current.hashtags.map { "#\($0)" }.joined(separator: " "))
    }

    private var draft: ListingCopy {
        let tags = hashtags
            .split(whereSeparator: { $0 == " " || $0 == "," || $0 == "\n" })
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "#")).lowercased() }
            .filter { !$0.isEmpty }
        return ListingCopy(title: title, description: description, hashtags: copy.showsHashtags ? tags : [])
    }

    var body: some View {
        NavigationStack {
            Form {
                fields.listRowBackground(Palette.surface.color)
            }
            .scrollContentBackground(.hidden)
            .background(Palette.background)
            .navigationTitle(copy.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(draft)
                        dismiss()
                    }
                    .accessibilityIdentifier("copy.save")
                }
            }
        }
    }

    @ViewBuilder
    private var fields: some View {
        Section {
            TextField(copy.hasTitle ? "Title" : "Headline", text: $title, axis: .vertical)
                .accessibilityIdentifier("copy.title")
        } header: {
            Text(copy.hasTitle ? "Title" : "Headline")
        } footer: {
            if copy.hasTitle, let limit = copy.limits?.title {
                counter(title.utf16.count, limit: limit)
            } else {
                Text("Depop listings have no title. This headline is only for you.")
            }
        }
        Section {
            TextField("Description", text: $description, axis: .vertical)
                .lineLimit(6 ... 16)
                .accessibilityIdentifier("copy.description")
        } header: {
            Text("Description")
        } footer: {
            if let limit = copy.limits?.description {
                let listed = MarketplaceCopy.listedDescription(draft, hashtags: copy.showsHashtags)
                counter(listed.utf16.count, limit: limit)
            }
        }
        if copy.showsHashtags {
            Section {
                TextField("#vintage #streetwear", text: $hashtags)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("copy.hashtags")
            } header: {
                Text("Hashtags")
            } footer: {
                Text("Up to \(copy.limits?.hashtags ?? 0). They count toward the description's limit.")
            }
        }
        let problems = MarketplaceCopy.problems(of: draft, marketplace: copy.marketplace)
        if !problems.isEmpty {
            Section {
                ForEach(problems, id: \.self) { problem in
                    Label(problem, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(Palette.danger)
                }
            }
        }
        if copy.edited != nil || draft != copy.suggested {
            Section {
                Button("Use Listora's copy") {
                    title = copy.suggested.title
                    description = copy.suggested.description
                    hashtags = copy.suggested.hashtags.map { "#\($0)" }.joined(separator: " ")
                }
                .accessibilityIdentifier("copy.reset")
            }
        }
    }

    private func counter(_ count: Int, limit: Int) -> some View {
        Text("\(count) of \(limit) characters")
            .foregroundStyle(count > limit ? Palette.danger : Palette.textSecondary)
            .monospacedDigit()
    }
}
