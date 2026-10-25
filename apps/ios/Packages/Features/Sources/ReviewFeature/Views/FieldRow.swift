import DesignSystem
import SwiftUI

/// One detail in the review: its value, where it came from, and, when it needs a look, why. Tap
/// to edit it in place; choices open a menu of the canonical values.
struct FieldRow: View {
    let field: ReviewField
    let isEditing: Bool
    let onEdit: () -> Void
    let onCommit: (FieldValue) -> Void

    var body: some View {
        // The row's identifier goes on the row only: on a container it would also replace the
        // editor's own.
        if field.key.kind == .choice {
            ChoiceMenu(key: field.key, onSelect: onCommit) { summary }
                .accessibilityIdentifier("review.field.\(field.key.rawValue)")
        } else if isEditing {
            FieldEditor(field: field, onCommit: onCommit)
        } else {
            Button(action: onEdit) { summary }
                .buttonStyle(.plain)
                .accessibilityIdentifier("review.field.\(field.key.rawValue)")
        }
    }

    private var summary: some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(field.key.title)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                Text(field.value.isEmpty ? placeholder : field.displayValue)
                    .font(Typography.body)
                    .foregroundStyle(field.value.isEmpty ? Palette.textSecondary : Palette.textPrimary)
                    .multilineTextAlignment(.leading)
                    .lineLimit(field.key.kind == .multiline ? 4 : 2)
                if let note = attentionNote {
                    Label(note, systemImage: field.isMissing ? "plus.circle.fill" : "exclamationmark.circle.fill")
                        .font(Typography.caption.weight(.semibold))
                        .foregroundStyle(Palette.warning)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let provenance = field.provenance {
                ProvenanceBadge(provenance: provenance)
            }
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, Spacing.sm)
        .frame(minHeight: Layout.minimumTapTarget)
        .background(alignment: .leading) {
            if field.needsAttention {
                Palette.warning.color.frame(width: 4)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityHint(field.key.kind == .choice ? "Shows the choices" : "Edits the value")
        .accessibilityAddTraits(.isButton)
    }

    private var placeholder: String {
        "Add \(field.key.title.lowercased())"
    }

    private var attentionNote: String? {
        if field.isMissing {
            return "Needed to list"
        }
        if field.isLowConfidence, let confidence = field.confidence {
            return "Check this: \(Int((confidence * 100).rounded()))% sure"
        }
        return nil
    }

    private var accessibilityText: String {
        var parts = [field.key.title, field.value.isEmpty ? "No value" : field.displayValue]
        if let provenance = field.provenance {
            parts.append("From \(provenance.label)")
        }
        if let note = attentionNote {
            parts.append(note)
        }
        return parts.joined(separator: ", ")
    }
}

/// Where a value came from: AI, a tag, a barcode, or the seller.
struct ProvenanceBadge: View {
    let provenance: ReviewProvenance

    var body: some View {
        Label(provenance.label, systemImage: provenance.systemImage)
            .labelStyle(.titleAndIcon)
            .font(Typography.caption.weight(.semibold))
            .foregroundStyle(provenance == .user ? Palette.onBrand : Palette.textPrimary)
            .padding(.horizontal, Spacing.xs)
            .padding(.vertical, Spacing.xxs)
            .background(provenance == .user ? Palette.brand : Palette.surfaceSecondary, in: Capsule())
            .fixedSize()
            .accessibilityLabel("From \(provenance.label)")
    }
}

/// The in-place editor of a text or list detail. Return or leaving the field keeps the value.
private struct FieldEditor: View {
    let field: ReviewField
    let onCommit: (FieldValue) -> Void
    @State private var text: String
    @FocusState private var isFocused: Bool

    init(field: ReviewField, onCommit: @escaping (FieldValue) -> Void) {
        self.field = field
        self.onCommit = onCommit
        _text = State(initialValue: field.value.editingText)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            Text(field.key.title)
                .font(Typography.caption)
                .foregroundStyle(Palette.brand)
            TextField(
                field.key.kind == .list ? "Separate with commas" : "Add \(field.key.title.lowercased())",
                text: $text,
                axis: field.key.kind == .multiline ? .vertical : .horizontal,
            )
            .font(Typography.body)
            .foregroundStyle(Palette.textPrimary)
            .lineLimit(field.key.kind == .multiline ? 3 ... 10 : 1 ... 1)
            .textInputAutocapitalization(field.key == .upc || field.key == .rnNumber ? .never : .sentences)
            .keyboardType(field.key == .upc || field.key == .rnNumber ? .numberPad : .default)
            .submitLabel(.done)
            .focused($isFocused)
            .onSubmit(commit)
            .onChange(of: text) { _, value in
                if value.count > field.key.maxLength {
                    text = String(value.prefix(field.key.maxLength))
                }
            }
            .onChange(of: isFocused) { _, focused in
                if !focused {
                    commit()
                }
            }
            .accessibilityIdentifier("review.editor.\(field.key.rawValue)")
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, Spacing.sm)
        .frame(minHeight: Layout.minimumTapTarget)
        .onAppear { isFocused = true }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done", action: commit)
                    .font(Typography.headline)
                    .accessibilityIdentifier("review.editor.done")
            }
        }
    }

    private func commit() {
        onCommit(FieldValue.parse(text, as: field.key.kind))
    }
}

/// The canonical values of a choice detail, as a menu. Categories are grouped by their top level.
private struct ChoiceMenu<Label: View>: View {
    let key: ReviewFieldKey
    let onSelect: (FieldValue) -> Void
    @ViewBuilder let label: () -> Label

    var body: some View {
        Menu {
            if key == .category {
                ForEach(ItemVocabulary.shared.categories, id: \.category) { category in
                    Menu(ItemVocabulary.categoryName(category.category)) {
                        ForEach(category.subcategories, id: \.self) { subcategory in
                            Button(ItemVocabulary.humanize(subcategory)) {
                                onSelect(.text("\(category.category)/\(subcategory)"))
                            }
                        }
                    }
                }
            } else {
                ForEach(key.choices, id: \.value) { choice in
                    Button(choice.name) { onSelect(.text(choice.value)) }
                }
            }
            if key != .condition {
                Divider()
                Button("None", role: .destructive) { onSelect(.text("")) }
            }
        } label: {
            label()
        }
        .buttonStyle(.plain)
    }
}
