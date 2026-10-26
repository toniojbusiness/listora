import SwiftUI

/// A small non-interactive label on a capsule, such as a photo's role or "Cover". `prominent`
/// uses the brand fill; otherwise it sits on the surface, readable over photos. `muted` sits on
/// a card, for a fact beside the card's title such as how Listora works with a marketplace.
public struct Chip: View {
    public enum Emphasis: Sendable {
        case surface
        case prominent
        case muted
    }

    private let title: String
    private let systemImage: String?
    private let emphasis: Emphasis

    public init(_ title: String, systemImage: String? = nil, prominent: Bool = false) {
        self.init(title, systemImage: systemImage, emphasis: prominent ? .prominent : .surface)
    }

    public init(_ title: String, systemImage: String? = nil, emphasis: Emphasis) {
        self.title = title
        self.systemImage = systemImage
        self.emphasis = emphasis
    }

    private var foreground: ColorToken {
        switch emphasis {
        case .surface: Palette.textPrimary
        case .prominent: Palette.onBrand
        case .muted: Palette.textSecondary
        }
    }

    private var fill: ColorToken {
        switch emphasis {
        case .surface: Palette.surface
        case .prominent: Palette.brand
        case .muted: Palette.surfaceSecondary
        }
    }

    public var body: some View {
        HStack(spacing: Spacing.xxs) {
            if let systemImage {
                Image(systemName: systemImage).imageScale(.small)
            }
            Text(title).lineLimit(1)
        }
        .font(Typography.label)
        .foregroundStyle(foreground)
        .padding(.horizontal, Spacing.xs)
        .padding(.vertical, Spacing.xxs)
        .background(fill, in: Capsule())
    }
}

/// A choice among a few options (a photo's role, a cost source): brand filled when selected,
/// with a check, and a tinted outline otherwise. At least ``Layout/minimumTapTarget`` tall, with
/// the selected trait for VoiceOver and a selection haptic.
public struct ChoiceChip: View {
    private let title: String
    private let systemImage: String?
    private let isSelected: Bool
    private let action: @MainActor () -> Void
    @Environment(\.isEnabled) private var isEnabled

    public init(
        _ title: String,
        systemImage: String? = nil,
        isSelected: Bool,
        action: @escaping @MainActor () -> Void,
    ) {
        self.title = title
        self.systemImage = systemImage
        self.isSelected = isSelected
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.xxs) {
                if isSelected {
                    Image(systemName: "checkmark").imageScale(.small)
                } else if let systemImage {
                    Image(systemName: systemImage).imageScale(.small)
                }
                Text(title).lineLimit(1)
            }
            .font(Typography.emphasis)
            .foregroundStyle(isSelected ? Palette.onBrand : Palette.textPrimary)
            .padding(.horizontal, Spacing.sm)
            .frame(minHeight: 36)
            .background(isSelected ? Palette.brand : Palette.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(isSelected ? Color.clear : Palette.separator.color, lineWidth: 1))
            // The visible pill is 36 points; the tap area reaches the minimum target.
            .frame(minHeight: Layout.minimumTapTarget)
            .contentShape(Rectangle())
            .opacity(isEnabled ? 1 : 0.45)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .sensoryFeedback(.selection, trigger: isSelected) { _, selected in selected }
    }
}

#Preview {
    VStack(alignment: .leading, spacing: Spacing.md) {
        HStack {
            Chip("Cover", prominent: true)
            Chip("Front")
            Chip("Blurry", systemImage: "drop.triangle.fill")
        }
        HStack {
            ChoiceChip("Front", isSelected: true) {}
            ChoiceChip("Back", isSelected: false) {}
            ChoiceChip("Tag", isSelected: false) {}
        }
    }
    .padding()
    .background(Palette.surfaceSecondary)
}
