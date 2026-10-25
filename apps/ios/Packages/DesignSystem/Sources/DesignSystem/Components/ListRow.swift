import SwiftUI

/// A row in a list or card: an optional leading icon tile or image, a title with an optional
/// subtitle, and an optional trailing accessory. At least ``Layout/minimumTapTarget`` tall; at
/// accessibility text sizes the trailing accessory moves below the text so nothing truncates.
public struct ListRow<Leading: View, Trailing: View>: View {
    private let title: String
    private let subtitle: String?
    private let leading: Leading
    private let trailing: Trailing
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    public init(
        _ title: String,
        subtitle: String? = nil,
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder trailing: () -> Trailing,
    ) {
        self.title = title
        self.subtitle = subtitle
        self.leading = leading()
        self.trailing = trailing()
    }

    public var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.xs))
            : AnyLayout(HStackLayout(alignment: .center, spacing: Spacing.sm))
        layout {
            HStack(alignment: .center, spacing: Spacing.sm) {
                leading
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(Typography.headline)
                        .foregroundStyle(Palette.textPrimary)
                    if let subtitle {
                        Text(subtitle)
                            .font(Typography.subheadline)
                            .foregroundStyle(Palette.textSecondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)
            }
            trailing
        }
        .frame(minHeight: Layout.minimumTapTarget)
        .contentShape(Rectangle())
    }
}

extension ListRow where Leading == IconTile {
    /// A row with an SF Symbol tile.
    public init(
        _ title: String,
        subtitle: String? = nil,
        systemImage: String,
        tone: StatusTone? = nil,
        @ViewBuilder trailing: () -> Trailing,
    ) {
        self.init(title, subtitle: subtitle) {
            IconTile(systemImage: systemImage, tone: tone)
        } trailing: {
            trailing()
        }
    }
}

extension ListRow where Leading == IconTile, Trailing == EmptyView {
    public init(_ title: String, subtitle: String? = nil, systemImage: String, tone: StatusTone? = nil) {
        self.init(title, subtitle: subtitle, systemImage: systemImage, tone: tone) { EmptyView() }
    }
}

extension ListRow where Leading == EmptyView, Trailing == Text {
    /// A label and a value, like "Version  1.0 (1)".
    public init(_ title: String, value: String) {
        self.init(title) {
            EmptyView()
        } trailing: {
            Text(value).foregroundStyle(Palette.textSecondary)
        }
    }
}

#Preview {
    List {
        ListRow("Marketplaces", subtitle: "eBay, Depop, Poshmark, Mercari", systemImage: "link")
        ListRow("Upload failed", subtitle: "2 photos", systemImage: "exclamationmark.triangle.fill", tone: .failed) {
            StatusBadge("Retry", tone: .failed)
        }
        ListRow("Version", value: "1.0 (1)")
    }
}
