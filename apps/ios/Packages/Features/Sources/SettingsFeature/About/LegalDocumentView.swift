import DesignSystem
import SwiftUI

/// Settings > Privacy policy or Terms of service: the bundled document, readable at every text
/// size, with each table row as a small card of label and value pairs.
struct LegalDocumentView: View {
    let kind: LegalDocument.Kind
    let document: LegalDocument?

    var body: some View {
        Group {
            if let document {
                ScrollView {
                    VStack(alignment: .leading, spacing: Spacing.md) {
                        ForEach(Array(document.blocks.enumerated()), id: \.offset) { _, block in
                            view(for: block)
                        }
                    }
                    .padding(Spacing.md)
                    .frame(maxWidth: Layout.readableWidth, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .accessibilityIdentifier("legal.\(kind.rawValue)")
            } else {
                EmptyStateView(
                    systemImage: "doc.text",
                    title: "\(kind.title) unavailable",
                    message: "This build of Listora doesn't include it.",
                )
            }
        }
        .background(Palette.background)
        .navigationTitle(kind.title)
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func view(for block: LegalDocument.Block) -> some View {
        switch block {
        case let .heading(text):
            Text(text)
                .font(Typography.title3)
                .foregroundStyle(Palette.textPrimary)
                .padding(.top, Spacing.sm)
                .accessibilityAddTraits(.isHeader)
        case let .subheading(text):
            Text(text)
                .font(Typography.headline)
                .foregroundStyle(Palette.textPrimary)
                .accessibilityAddTraits(.isHeader)
        case let .paragraph(text):
            prose(text)
        case let .bullet(text):
            HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                Text("•")
                    .font(Typography.body)
                    .foregroundStyle(Palette.brand)
                    .accessibilityHidden(true)
                prose(text)
            }
        case let .note(text):
            prose(text, font: Typography.subheadline)
                .cardStyle(.tinted(.actionNeeded))
        case let .table(rows):
            VStack(alignment: .leading, spacing: Spacing.sm) {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        ForEach(Array(row.enumerated()), id: \.offset) { index, cell in
                            if index == 0 {
                                Text(Self.inline(cell.value))
                                    .font(Typography.headline)
                                    .foregroundStyle(Palette.textPrimary)
                            } else {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(cell.label)
                                        .font(Typography.eyebrow)
                                        .foregroundStyle(Palette.textSecondary)
                                    prose(cell.value, font: Typography.subheadline)
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .cardStyle(.flat)
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private func prose(_ text: String, font: Font = Typography.body) -> some View {
        Text(Self.inline(text))
            .font(font)
            .foregroundStyle(Palette.textPrimary)
            .tint(Palette.brand.color)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Bold, italics, code, and links; anything else as written.
    static func inline(_ text: String) -> AttributedString {
        (try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace),
        )) ?? AttributedString(text)
    }
}
