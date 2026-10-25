import SwiftUI

/// An inline message about the screen's content, in a status tone: an icon, a title, an optional
/// message, an optional action (Retry), and an optional dismiss button. Failures always come with
/// a way forward. For a passing confirmation, use ``SwiftUI/View/toast(_:)`` instead.
public struct Banner: View {
    public struct Action {
        let title: String
        let identifier: String?
        let handler: @MainActor () -> Void

        public init(_ title: String, identifier: String? = nil, handler: @escaping @MainActor () -> Void) {
            self.title = title
            self.identifier = identifier
            self.handler = handler
        }
    }

    private let tone: StatusTone
    private let title: String
    private let message: String?
    private let systemImage: String?
    private let action: Action?
    private let onDismiss: (@MainActor () -> Void)?
    private let identifier: String?

    /// `identifier` is the accessibility identifier of the title and message, read as one element.
    public init(
        _ title: String,
        message: String? = nil,
        tone: StatusTone,
        systemImage: String? = nil,
        action: Action? = nil,
        onDismiss: (@MainActor () -> Void)? = nil,
        identifier: String? = nil,
    ) {
        self.identifier = identifier
        self.title = title
        self.message = message
        self.tone = tone
        self.systemImage = systemImage
        self.action = action
        self.onDismiss = onDismiss
    }

    public var body: some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            Image(systemName: systemImage ?? tone.systemImage)
                .font(Typography.headline)
                .foregroundStyle(tone.color)
                .frame(minHeight: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Spacing.xs) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(Typography.subheadline.weight(.semibold))
                        .foregroundStyle(Palette.textPrimary)
                    if let message {
                        Text(message)
                            .font(Typography.subheadline)
                            .foregroundStyle(Palette.textPrimary)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier(identifier ?? "")
                if let action {
                    Button(action.title, action: action.handler)
                        .buttonStyle(.listora(.secondary, size: .compact))
                        .accessibilityIdentifier(action.identifier ?? "")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let onDismiss {
                Button("Dismiss", systemImage: "xmark", action: onDismiss)
                    .labelStyle(.iconOnly)
                    .font(Typography.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.textSecondary)
                    .frame(width: Layout.minimumTapTarget, height: Layout.minimumTapTarget)
                    .contentShape(Rectangle())
                    .buttonStyle(.plain)
                    .padding(.top, -Spacing.sm)
                    .padding(.trailing, -Spacing.sm)
            }
        }
        .cardStyle(.tinted(tone), padding: Spacing.md)
    }
}

/// A short confirmation that appears over the bottom of the screen and goes away on its own.
public struct Toast: Equatable, Identifiable, Sendable {
    public let id = UUID()
    public let message: String
    public let tone: StatusTone

    public init(_ message: String, tone: StatusTone = .success) {
        self.message = message
        self.tone = tone
    }

    public static func == (lhs: Toast, rhs: Toast) -> Bool {
        lhs.id == rhs.id
    }
}

struct ToastModifier: ViewModifier {
    @Binding var toast: Toast?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) {
                if let toast {
                    ToastView(toast: toast)
                        .padding(.horizontal, Spacing.md)
                        .padding(.bottom, Spacing.md)
                        .transition(.rise)
                        .task(id: toast.id) {
                            UIAccessibility.post(notification: .announcement, argument: toast.message)
                            try? await Task.sleep(for: .seconds(3))
                            if self.toast?.id == toast.id {
                                self.toast = nil
                            }
                        }
                        .onTapGesture { self.toast = nil }
                }
            }
            .animation(Motion.animation(Motion.standard, reduceMotion: reduceMotion), value: toast)
    }
}

private struct ToastView: View {
    let toast: Toast

    var body: some View {
        HStack(spacing: Spacing.xs) {
            Image(systemName: toast.tone.systemImage)
                .foregroundStyle(toast.tone.color)
                .accessibilityHidden(true)
            Text(toast.message)
                .font(Typography.subheadline.weight(.semibold))
                .foregroundStyle(Palette.textPrimary)
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, Spacing.sm)
        .frame(minHeight: Layout.minimumTapTarget)
        .background(Palette.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(Palette.separator, lineWidth: 1))
        .elevation(.high)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("toast")
    }
}

extension View {
    /// Shows `toast` over the bottom of the view for a few seconds, announces it to VoiceOver, then
    /// clears it.
    public func toast(_ toast: Binding<Toast?>) -> some View {
        modifier(ToastModifier(toast: toast))
    }
}

#Preview {
    @Previewable @State var toast: Toast? = Toast("eBay is connected")
    ScrollView {
        VStack(spacing: Spacing.md) {
            Banner(
                "2 photos failed to upload",
                message: "The server is busy.",
                tone: .failed,
                action: .init("Retry") {},
            )
            Banner("Saved on this phone", message: "Sign in to upload.", tone: .actionNeeded)
            Banner("Uploading photos", message: "1 of 3 done", tone: .inProgress, onDismiss: {})
            Banner("Saved to Listora with all 3 photos", tone: .success)
            Button("Show toast") { toast = Toast("eBay is connected") }
        }
        .padding()
    }
    .background(Palette.background)
    .toast($toast)
}
