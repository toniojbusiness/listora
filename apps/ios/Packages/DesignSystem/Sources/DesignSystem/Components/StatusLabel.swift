import SwiftUI

/// A server-rendered status (`Active (you confirmed)`, `Delist failed - Retry`) as an icon and
/// text in its tone's color, for places where a pill would be too heavy. The label is shown
/// exactly as given; the tone only styles it. ``StatusBadge`` is the woven-label form.
public struct StatusLabel: View {
    public typealias Tone = StatusTone

    private let label: String
    private let tone: Tone

    public init(_ label: String, tone: Tone) {
        self.label = label
        self.tone = tone
    }

    public var body: some View {
        Label {
            Text(label)
        } icon: {
            Image(systemName: tone.systemImage)
        }
        .font(Typography.emphasis)
        .foregroundStyle(tone.color)
        // VoiceOver reads the status once, as given; the icon only repeats the tone.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }
}

/// A status as a woven label sewn onto the tag: the tone's icon and the server's label on the
/// tone's soft color, with a nearly square edge and a stitched line just inside it. Use it for
/// marketplace, listing, and upload states. The label is shown exactly as given, never cut short.
/// A mark that is not a status, such as how urgent a card is, is a ``Stamp``.
public struct StatusBadge: View {
    private let label: String
    private let tone: StatusTone
    private let showsIcon: Bool

    public init(_ label: String, tone: StatusTone, showsIcon: Bool = true) {
        self.label = label
        self.tone = tone
        self.showsIcon = showsIcon
    }

    private static let shape = RoundedRectangle(cornerRadius: Radius.tight, style: .continuous)

    public var body: some View {
        HStack(spacing: Spacing.xxs) {
            if showsIcon {
                Image(systemName: tone.systemImage)
                    .imageScale(.small)
            }
            // Never truncated: the label is the server's honest status, read in full.
            Text(label)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(Typography.label)
        .foregroundStyle(tone.color)
        .padding(.horizontal, Spacing.xs)
        .padding(.vertical, Spacing.xxs + 2)
        .background(tone.softColor, in: Self.shape)
        .stitchedEdge(Self.shape, color: tone.color.color.opacity(0.35), inset: 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }
}

#Preview {
    VStack(alignment: .leading, spacing: Spacing.sm) {
        StatusLabel("Active (confirmed by eBay)", tone: .success)
        StatusLabel("Delist failed - Retry", tone: .failed)
        StatusBadge("Connected", tone: .success)
        StatusBadge("Uploading", tone: .inProgress)
        StatusBadge("Checking...", tone: .checking)
        StatusBadge("Upload failed", tone: .failed)
        StatusBadge("Reconnect needed", tone: .actionNeeded)
        StatusBadge("Assisted", tone: .neutral)
    }
    .padding()
    .background(Palette.background)
}
