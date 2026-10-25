import SwiftUI

/// A small non-interactive label on a capsule, such as a photo's role or "Cover". `prominent`
/// uses the brand fill; otherwise it sits on the surface, readable over photos.
public struct Chip: View {
    private let title: String
    private let systemImage: String?
    private let isProminent: Bool

    public init(_ title: String, systemImage: String? = nil, prominent: Bool = false) {
        self.title = title
        self.systemImage = systemImage
        isProminent = prominent
    }

    public var body: some View {
        HStack(spacing: Spacing.xxs) {
            if let systemImage {
                Image(systemName: systemImage).imageScale(.small)
            }
            Text(title).lineLimit(1)
        }
        .font(Typography.label)
        .foregroundStyle(isProminent ? Palette.onBrand : Palette.textPrimary)
        .padding(.horizontal, Spacing.xs)
        .padding(.vertical, Spacing.xxs)
        .background(isProminent ? Palette.brand : Palette.surface, in: Capsule())
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
            .font(Typography.subheadline.weight(.semibold))
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
