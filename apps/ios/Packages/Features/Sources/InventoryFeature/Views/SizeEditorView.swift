import DesignSystem
import SwiftUI

/// The item's size, as the tag says it ("M", "32", "9.5", "One size"). Saving replaces the item's
/// size; a listing a marketplace refused for its size can then be listed again.
struct SizeEditorView: View {
    /// Saves the size and returns the failure to show, or nil once saved.
    let save: (String) async -> String?
    @State private var size: String
    @State private var problem: String?
    @State private var isSaving = false
    @FocusState private var isFocused: Bool
    @Environment(\.dismiss) private var dismiss

    init(current: String?, save: @escaping (String) async -> String?) {
        self.save = save
        _size = State(initialValue: current ?? "")
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                ListoraTextField(
                    "Size",
                    hint: "As the tag says it, for example M, 32, or 9.5. eBay, Poshmark, Mercari, and Depop need it "
                        + "for clothing and shoes.",
                    error: problem,
                ) {
                    TextField("Size", text: $size)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .focused($isFocused)
                        .onSubmit { Task { await submit() } }
                        .accessibilityIdentifier("size.field")
                }
                .padding(Spacing.md)
            }
            .background(Palette.background)
            .bottomActionBar {
                Button("Save size", systemImage: "checkmark") { Task { await submit() } }
                    .buttonStyle(.listoraPrimary)
                    .loading(isSaving)
                    .disabled(isSaving)
                    .accessibilityIdentifier("size.save")
            }
            .navigationTitle("Size")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .onAppear { isFocused = true }
        }
        .presentationDetents([.medium, .large])
    }

    private func submit() async {
        guard !isSaving else { return }
        isSaving = true
        problem = nil
        defer { isSaving = false }
        if let failure = await save(size) {
            problem = failure
        } else {
            dismiss()
        }
    }
}
