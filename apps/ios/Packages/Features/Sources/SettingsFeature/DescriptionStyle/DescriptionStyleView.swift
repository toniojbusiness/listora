import DesignSystem
import SwiftUI

/// Settings > Description style: the instructions Listora's AI follows when it writes the
/// seller's Depop drafts, editable in their own words. Save keeps them on the server; "Use
/// Listora's default" goes back to the default style.
struct DescriptionStyleView: View {
    @Bindable var model: DescriptionStyleModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                switch model.phase {
                case .loading:
                    ProgressView("Loading your style…")
                        .frame(maxWidth: .infinity)
                        .padding(.top, Spacing.xl)
                case let .failed(message):
                    Banner(
                        "Your style couldn't load",
                        message: message,
                        tone: .failed,
                        identifier: "descriptionStyle.loadError",
                    )
                    Button("Try again") { Task { await model.load() } }
                        .buttonStyle(.listora(.secondary, size: .compact))
                        .accessibilityIdentifier("descriptionStyle.retry")
                case .loaded:
                    editor
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Palette.background)
        .navigationTitle("Description style")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    Task {
                        if await model.save() {
                            dismiss()
                        }
                    }
                }
                .disabled(!model.canSave)
                .accessibilityIdentifier("descriptionStyle.save")
            }
        }
        .task { await model.load() }
    }

    @ViewBuilder
    private var editor: some View {
        Text(
            "How Listora writes your Depop drafts: the layout, the tone, the hashtags. New drafts follow it; "
                +
                "items already analyzed keep their copy. Listora always names every flaw and keeps to Depop's limits.",
        )
        .font(Typography.subheadline)
        .foregroundStyle(Palette.textSecondary)
        if model.style?.depopIsDefault == true {
            StatusBadge("Listora's default", tone: .neutral)
                .accessibilityIdentifier("descriptionStyle.default")
        }
        ListoraTextField("Depop", hint: counterHint) {
            TextField("Depop", text: $model.draft, axis: .vertical)
                .lineLimit(10 ... 30)
                .accessibilityIdentifier("descriptionStyle.depop")
        }
        if let error = model.saveError {
            Banner("Your style wasn't saved", message: error, tone: .failed, identifier: "descriptionStyle.saveError")
        }
        if model.style?.depopIsDefault == false {
            Button("Use Listora's default") {
                Task { await model.useDefault() }
            }
            .buttonStyle(.listora(.secondary, size: .compact))
            .disabled(model.isSaving)
            .accessibilityIdentifier("descriptionStyle.useDefault")
        }
    }

    private var counterHint: String {
        "\(model.length) of \(DescriptionStyleModel.maxLength) characters"
    }
}
