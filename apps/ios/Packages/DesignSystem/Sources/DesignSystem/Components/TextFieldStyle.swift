import SwiftUI

/// A labeled text field on a rounded well: the label above, the field at least
/// ``Layout/minimumTapTarget`` tall with a brand outline while focused, and a hint or error below.
/// An error replaces the hint, in the danger color, and VoiceOver reads it with the field.
public struct ListoraTextField<Field: View>: View {
    private let label: String
    private let hint: String?
    private let error: String?
    private let field: Field
    @FocusState private var isFocused: Bool

    public init(_ label: String, hint: String? = nil, error: String? = nil, @ViewBuilder field: () -> Field) {
        self.label = label
        self.hint = hint
        self.error = error
        self.field = field()
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(label)
                .font(Typography.emphasis)
                .foregroundStyle(Palette.textPrimary)
                .accessibilityHidden(true)
            field
                .font(Typography.body)
                .foregroundStyle(Palette.textPrimary)
                .tint(Palette.brand.color)
                .focused($isFocused)
                .padding(.horizontal, Spacing.sm)
                .padding(.vertical, Spacing.sm)
                .frame(minHeight: Layout.minimumTapTarget + 4)
                .background(Palette.surfaceSecondary, in: shape)
                .overlay(shape.strokeBorder(outline, lineWidth: isFocused || error != nil ? 2 : 0))
                .accessibilityLabel(label)
                .accessibilityHint(error ?? hint ?? "")
            if let message = error ?? hint {
                Label {
                    Text(message)
                } icon: {
                    if error != nil {
                        Image(systemName: "exclamationmark.circle.fill")
                    }
                }
                .labelStyle(CompactLabelStyle())
                .font(Typography.footnote)
                .foregroundStyle(error == nil ? Palette.textSecondary : Palette.danger)
                .accessibilityHidden(true)
            }
        }
    }

    private var outline: AnyShapeStyle {
        error != nil ? AnyShapeStyle(Palette.danger) : AnyShapeStyle(Palette.brand)
    }
}

extension ListoraTextField where Field == TextField<Text> {
    /// A plain text field.
    public init(
        _ label: String,
        text: Binding<String>,
        prompt: String? = nil,
        hint: String? = nil,
        error: String? = nil,
    ) {
        self.init(label, hint: hint, error: error) {
            TextField(label, text: text, prompt: prompt.map { Text($0).foregroundStyle(Palette.textSecondary) })
        }
    }
}

/// An icon and title with tight spacing, aligned on the first line.
struct CompactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.xxs) {
            configuration.icon
            configuration.title
        }
    }
}

#Preview {
    @Previewable @State var email = ""
    @Previewable @State var code = "12"
    VStack(spacing: Spacing.lg) {
        ListoraTextField("Email", text: $email, prompt: "you@example.com", hint: "We'll send a 6-digit code.")
        ListoraTextField("Code", text: $code, error: "Enter all 6 digits.")
    }
    .padding()
    .background(Palette.surface)
}
