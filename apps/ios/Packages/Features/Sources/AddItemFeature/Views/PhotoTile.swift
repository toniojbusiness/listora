import DesignSystem
import SwiftUI

extension PhotoUploadStatus {
    var tone: StatusTone {
        switch self {
        case .uploaded: .success
        case .failed: .failed
        case .waitingForSignIn: .actionNeeded
        case .retrying, .uploading, .readingTag: .inProgress
        case .waiting: .neutral
        }
    }
}

/// A photo in the editor grid: the image, its role, whether it is the cover, and its upload state.
struct PhotoTile: View {
    let photo: DraftPhotoRecord
    let index: Int
    let url: URL
    let status: PhotoUploadStatus
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        // At accessibility text sizes the labels move below the photo, where they can grow without
        // covering it; over the photo only icons remain.
        let labelsBelow = dynamicTypeSize.isAccessibilitySize
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            photoSquare(labelsBelow: labelsBelow)
            if labelsBelow {
                Text(photo.role.title)
                    .font(Typography.label)
                    .foregroundStyle(Palette.textPrimary)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityAddTraits(.isButton)
    }

    private func photoSquare(labelsBelow: Bool) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
        return Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay { PhotoThumbnail(url: url, pointSize: 160) }
            .clipShape(shape)
            .overlay(shape.strokeBorder(
                index == 0 ? Palette.brand.color : Palette.separator.color,
                lineWidth: index == 0 ? 2 : 1,
            ))
            .overlay(alignment: .topLeading) {
                if index == 0 {
                    Group {
                        if labelsBelow {
                            Image(systemName: "star.fill")
                                .font(Typography.label)
                                .foregroundStyle(Palette.onBrand)
                                .frame(width: 24, height: 24)
                                .background(Palette.brand, in: Circle())
                        } else {
                            Chip("Cover", systemImage: "star.fill", prominent: true)
                        }
                    }
                    .padding(Spacing.xxs + 2)
                }
            }
            .overlay(alignment: .topTrailing) {
                // Waiting photos say nothing of their own: the banner above the grid explains why.
                if status != .waiting, status != .waitingForSignIn {
                    statusBadge
                }
            }
            .overlay(alignment: .bottomLeading) {
                HStack(spacing: Spacing.xxs) {
                    if !labelsBelow {
                        Chip(photo.role.title)
                    }
                    if photo.looksBlurry {
                        Image(systemName: "drop.triangle.fill")
                            .font(Typography.label)
                            .foregroundStyle(Palette.warning)
                            .frame(width: 24, height: 24)
                            .background(Palette.surface, in: Circle())
                    }
                }
                .padding(Spacing.xxs + 2)
            }
            // Icons over the photo keep their size so the photo stays visible.
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    private var accessibilityText: String {
        var parts = ["Photo \(index + 1)", photo.role.title]
        if index == 0 {
            parts.append("Cover")
        }
        if photo.looksBlurry {
            parts.append("Looks blurry")
        }
        parts.append(status.label)
        return parts.joined(separator: ", ")
    }

    private var statusBadge: some View {
        Group {
            if status == .uploading || status == .readingTag {
                ProgressView()
                    .controlSize(.mini)
                    .tint(status.tone.color.color)
            } else {
                Image(systemName: status.systemImage)
                    .font(Typography.label)
                    .foregroundStyle(status.tone.color)
            }
        }
        .frame(width: 24, height: 24)
        .background(Palette.surface, in: Circle())
        .padding(Spacing.xxs + 2)
    }
}
