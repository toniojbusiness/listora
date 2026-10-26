import DesignSystem
import SwiftUI
import UIKit

/// The build's details for a support conversation: where it talks to and which build it is.
/// Hidden from the normal list: a long press on the version (or VoiceOver's "Show diagnostics"
/// action) opens it.
struct DiagnosticsView: View {
    let rows: [SettingsContent.DiagnosticsRow]
    @State private var copied = false

    var body: some View {
        List {
            Section {
                ForEach(rows, id: \.label) { row in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.label)
                            .font(Typography.caption)
                            .foregroundStyle(Palette.textSecondary)
                        Text(row.value)
                            .font(Typography.code)
                            .foregroundStyle(Palette.textPrimary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("diagnostics.\(row.id)")
                    }
                    .padding(.vertical, Spacing.xxs)
                    .accessibilityElement(children: .combine)
                }
            } footer: {
                Text("Share these with Listora support if they ask for them.")
            }
            .listRowBackground(Palette.surface.color)
            Section {
                Button(copied ? "Copied" : "Copy all", systemImage: copied ? "checkmark" : "doc.on.doc") {
                    UIPasteboard.general.string = rows.map { "\($0.label): \($0.value)" }.joined(separator: "\n")
                    copied = true
                }
                .accessibilityIdentifier("diagnostics.copy")
            }
            .listRowBackground(Palette.surface.color)
        }
        .scrollContentBackground(.hidden)
        .background(Palette.background)
        .foregroundStyle(Palette.textPrimary)
        .navigationTitle("Diagnostics")
        .navigationBarTitleDisplayMode(.inline)
    }
}
