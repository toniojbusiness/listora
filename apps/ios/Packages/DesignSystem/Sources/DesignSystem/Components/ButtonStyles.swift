import SwiftUI

/// Listora's buttons. Every kind is full width by default (`.compact` hugs its label), at least
/// ``Layout/minimumTapTarget`` tall, scales down slightly while pressed (not with Reduce Motion),
/// dims when disabled, and shows a spinner in place of its label while ``SwiftUI/View/loading(_:)``
/// is true.
///
/// - `primary`: the one main action of a screen, brand filled.
/// - `secondary`: the alternative, brand text on a brand-tinted fill.
/// - `destructive`: deletes or removes something, danger filled. Confirm before acting.
/// - `tertiary`: low-emphasis actions (Dismiss, Use a different email), brand text only.
/// - `destructiveText`: a low-emphasis destructive action (Sign out), danger text only.
public struct ListoraButtonStyle: ButtonStyle {
    public enum Kind: Sendable {
        case primary
        case secondary
        case destructive
        case tertiary
        case destructiveText
    }

    public enum Size: Sendable {
        /// Full width, ``Layout/buttonHeight`` tall.
        case large
        /// Hugs its label, ``Layout/compactButtonHeight`` tall.
        case compact
    }

    let kind: Kind
    let size: Size

    public init(_ kind: Kind, size: Size = .large) {
        self.kind = kind
        self.size = size
    }

    public func makeBody(configuration: Configuration) -> some View {
        ListoraButtonBody(configuration: configuration, kind: kind, size: size)
    }
}

private struct ListoraButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let kind: ListoraButtonStyle.Kind
    let size: ListoraButtonStyle.Size

    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.isLoading) private var isLoading
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
        configuration.label
            .font(size == .large ? Typography.headline : Typography.emphasis)
            .lineLimit(3)
            .multilineTextAlignment(.center)
            .foregroundStyle(foreground)
            .opacity(isLoading ? 0 : 1)
            .overlay {
                if isLoading {
                    // The button's value already says "In progress".
                    BrandSpinner(color: foreground)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, size == .large ? Spacing.md : Spacing.sm)
            .padding(.vertical, Spacing.xs)
            .frame(
                maxWidth: size == .large ? .infinity : nil,
                minHeight: size == .large ? Layout.buttonHeight : Layout.compactButtonHeight,
            )
            .background(background, in: shape)
            .contentShape(shape)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .opacity(isEnabled || isLoading ? (configuration.isPressed ? 0.85 : 1) : 0.45)
            .animation(Motion.animation(Motion.snappy, reduceMotion: reduceMotion), value: configuration.isPressed)
            .allowsHitTesting(!isLoading)
            .accessibilityValue(isLoading ? Text("In progress") : Text(""))
    }

    private var foreground: ColorToken {
        switch kind {
        case .primary: Palette.onBrand
        case .secondary, .tertiary: Palette.brand
        case .destructive: Palette.onDanger
        case .destructiveText: Palette.danger
        }
    }

    private var background: AnyShapeStyle {
        switch kind {
        case .primary: AnyShapeStyle(Palette.brand)
        case .secondary: AnyShapeStyle(Palette.brandSoft)
        case .destructive: AnyShapeStyle(Palette.danger)
        case .tertiary, .destructiveText: AnyShapeStyle(Color.clear)
        }
    }
}

extension ButtonStyle where Self == ListoraButtonStyle {
    public static var listoraPrimary: ListoraButtonStyle {
        ListoraButtonStyle(.primary)
    }

    public static var listoraSecondary: ListoraButtonStyle {
        ListoraButtonStyle(.secondary)
    }

    public static var listoraDestructive: ListoraButtonStyle {
        ListoraButtonStyle(.destructive)
    }

    public static var listoraTertiary: ListoraButtonStyle {
        ListoraButtonStyle(.tertiary)
    }

    /// A ``ListoraButtonStyle`` of any kind and size.
    public static func listora(_ kind: ListoraButtonStyle.Kind, size: ListoraButtonStyle.Size) -> ListoraButtonStyle {
        ListoraButtonStyle(kind, size: size)
    }
}

extension EnvironmentValues {
    /// True while the action a Listora button started is running.
    @Entry var isLoading = false
}

extension View {
    /// Shows a spinner in place of the label of the Listora buttons inside, and ignores taps on
    /// them, while `isLoading` is true. VoiceOver reads the button's label with "In progress".
    public func loading(_ isLoading: Bool) -> some View {
        environment(\.isLoading, isLoading)
    }
}

#Preview {
    ScrollView {
        VStack(spacing: Spacing.md) {
            Button("Take photos", systemImage: "camera.fill") {}.buttonStyle(.listoraPrimary)
            Button("Import photos", systemImage: "photo.on.rectangle") {}.buttonStyle(.listoraSecondary)
            Button("Connect eBay") {}.buttonStyle(.listoraPrimary).loading(true)
            Button("Delete draft", systemImage: "trash") {}.buttonStyle(.listoraDestructive)
            Button("Use a different email") {}.buttonStyle(.listoraTertiary)
            Button("Publish") {}.buttonStyle(.listoraPrimary).disabled(true)
            HStack {
                Button("Retry") {}.buttonStyle(.listora(.secondary, size: .compact))
                Button("Dismiss") {}.buttonStyle(.listora(.tertiary, size: .compact))
            }
        }
        .padding()
    }
    .background(Palette.background)
}
