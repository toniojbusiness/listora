import Core
import DesignSystem
import SwiftUI

/// What a new item needs, shown before the first draft: the guided shots in order.
struct NewItemGuide: View {
    let isCameraAvailable: Bool
    let isSignedIn: Bool

    private static let cameraIntro =
        "Listora guides you through each shot, saves the draft on this iPhone, and uploads it in the background."
    private static let importIntro =
        "Import the item's photos. Listora saves the draft on this iPhone and uploads it in the background."

    /// What happens to the photos: signed out, they wait on this iPhone.
    nonisolated static func privacyNote(isSignedIn: Bool) -> String {
        isSignedIn
            ? "Each photo's location is removed before it's uploaded."
            : "Photos stay on this iPhone until you sign in, and their location is removed before upload."
    }

    private struct Shot {
        let title: String
        let detail: String
        let systemImage: String
    }

    private static let shots = [
        Shot(title: "Front", detail: "Lay it flat or hang it", systemImage: "tshirt"),
        Shot(title: "Back", detail: "Turn it over", systemImage: "arrow.uturn.left"),
        Shot(title: "Tag", detail: "Brand and care labels, up close", systemImage: "tag"),
        Shot(title: "Flaws & details", detail: "Anything a buyer should see", systemImage: "magnifyingglass"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text("Take photos once")
                    .font(Typography.title)
                    .foregroundStyle(Palette.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                Text(isCameraAvailable ? Self.cameraIntro : Self.importIntro)
                    .font(Typography.body)
                    .foregroundStyle(Palette.textSecondary)
            }
            VStack(spacing: 0) {
                ForEach(Array(Self.shots.enumerated()), id: \.offset) { index, shot in
                    if index > 0 {
                        Divider().overlay(Palette.separator.color).padding(.leading, 36 + Spacing.sm)
                    }
                    ListRow(shot.title, subtitle: shot.detail, systemImage: shot.systemImage)
                        .padding(.vertical, Spacing.xs)
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("Shot \(index + 1): \(shot.title). \(shot.detail)")
                }
            }
            .cardStyle()
            Label(Self.privacyNote(isSignedIn: isSignedIn), systemImage: "lock.shield")
                .labelStyle(.titleAndIcon)
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
        }
        .frame(maxWidth: Layout.readableWidth, alignment: .leading)
        .frame(maxWidth: .infinity)
    }
}

/// One draft in the list: cover photo, SKU once the server assigned it, and the upload status.
struct DraftRow: View {
    let draft: Draft
    let activity: UploadActivity
    let fileURL: (DraftPhotoRecord) -> URL
    @ScaledMetric(relativeTo: .headline) private var thumbnailSize: CGFloat = 64

    var body: some View {
        let summary = DraftUploadSummary(
            draft: draft,
            transferring: activity.transferring,
            isSignedIn: activity.isSignedIn,
        )
        HStack(spacing: Spacing.sm) {
            Group {
                if let cover = draft.photos.first {
                    PhotoThumbnail(url: fileURL(cover), pointSize: thumbnailSize)
                } else {
                    Palette.surfaceSecondary.color
                        .overlay(Image(systemName: "photo").foregroundStyle(Palette.textSecondary))
                }
            }
            .frame(width: min(thumbnailSize, 96), height: min(thumbnailSize, 96))
            .clipShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(draft.record.sku ?? "New draft")
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                Text(
                    "\(photoCount) · \(draft.record.createdAt, format: .relative(presentation: .named))",
                )
                .font(Typography.subheadline)
                .foregroundStyle(Palette.textSecondary)
                StatusBadge(summary.badge, tone: summary.tone.statusTone)
                    .padding(.top, 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, Spacing.xs)
        .accessibilityElement(children: .combine)
    }

    private var photoCount: String {
        draft.photos.count == 1 ? "1 photo" : "\(draft.photos.count) photos"
    }
}

extension DraftUploadSummary.Tone {
    var statusTone: StatusTone {
        switch self {
        case .neutral: .inProgress
        case .empty: .neutral
        case .success: .success
        case .warning: .actionNeeded
        case .danger: .failed
        }
    }
}
