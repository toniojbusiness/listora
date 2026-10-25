import DesignSystem
import PhotosUI
import SwiftUI

/// One draft's photos: their order (the first is the cover), roles, and upload status. Tap a
/// photo to change its role, crop it, make it the cover, or remove it; drag photos to reorder.
/// Adding photos sits at the bottom, within thumb reach.
struct DraftEditorView: View {
    let draftID: String
    let model: AddItemModel
    let environment: AddItemEnvironment

    @State private var draft: Draft?
    @State private var selection: PhotoSelection?
    @State private var isCapturing = false
    @State private var isConfirmingDelete = false
    @State private var unloadedPhotos: PickedPhotos<PhotosPickerItem>?
    @Namespace private var photoTransition
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var columns: [GridItem] {
        let count = dynamicTypeSize.isAccessibilitySize ? 2 : 3
        return Array(repeating: GridItem(.flexible(), spacing: Spacing.xs), count: count)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.md) {
                if let draft {
                    let summary = DraftUploadSummary(
                        draft: draft,
                        transferring: model.activity.transferring,
                        isSignedIn: model.activity.isSignedIn,
                    )
                    Banner(
                        summary.text,
                        tone: summary.tone.statusTone,
                        systemImage: summary.tone.systemImage,
                        action: summary.canRetry
                            ? Banner.Action("Retry", identifier: "draft.retry") { model.retry(draftID) }
                            : nil,
                        identifier: "draft.uploadSummary",
                    )
                    .motion(value: summary)
                    .sensoryFeedback(trigger: summary.tone) { _, tone in
                        switch tone {
                        case .success: .success
                        case .danger: .error
                        case .neutral, .empty, .warning: nil
                        }
                    }
                    photoGrid(draft)
                    Label(
                        "Tap a photo to set what it shows, crop, or remove it. Drag to reorder; the first is "
                            + "the cover.",
                        systemImage: "hand.tap",
                    )
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                }
            }
            .padding(Spacing.md)
        }
        .background(Palette.background)
        .navigationTitle(draft?.record.sku ?? "New draft")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Delete draft", systemImage: "trash", role: .destructive) { isConfirmingDelete = true }
                } label: {
                    Label("More", systemImage: "ellipsis")
                }
                .accessibilityIdentifier("draft.more")
            }
        }
        .bottomActionBar {
            if let draft {
                addPhotoButtons(draft)
            }
        }
        .confirmationDialog("Delete this draft?", isPresented: $isConfirmingDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { model.deleteDraft(draftID) }
        } message: {
            Text("Its photos are removed from this iPhone and from Listora.")
        }
        .sheet(item: $selection) { selection in
            Group {
                if let photo = draft?.photos.first(where: { $0.id == selection.id }) {
                    PhotoDetailView(photo: photo, model: model)
                } else {
                    // The photo was removed or replaced (cropped) while open.
                    Color.clear.onAppear { self.selection = nil }
                }
            }
            .navigationTransition(.zoom(sourceID: selection.id, in: photoTransition))
        }
        .fullScreenCover(isPresented: $isCapturing) {
            CameraCaptureView(
                camera: environment.makeCamera(),
                capacity: DraftStore.maxPhotosPerDraft - (draft?.photos.count ?? 0),
            ) { shots in
                isCapturing = false
                _ = await model.save(shots, to: draftID)
            }
        }
        .task(id: draftID) {
            do {
                for try await draft in model.store.observeDraft(id: draftID) {
                    self.draft = draft
                    if draft == nil {
                        dismiss()
                    }
                }
            } catch {
                dismiss()
            }
        }
    }

    private func photoGrid(_ draft: Draft) -> some View {
        LazyVGrid(columns: columns, spacing: Spacing.xs) {
            ForEach(Array(draft.photos.enumerated()), id: \.element.id) { index, photo in
                Button {
                    selection = PhotoSelection(id: photo.id)
                } label: {
                    PhotoTile(
                        photo: photo,
                        index: index,
                        url: model.store.fileURL(for: photo),
                        status: PhotoUploadStatus(
                            photo: photo,
                            isTransferring: model.activity.transferring.contains(photo.id),
                            isSignedIn: model.activity.isSignedIn,
                        ),
                    )
                }
                .buttonStyle(.plain)
                .matchedTransitionSource(id: photo.id, in: photoTransition)
                .accessibilityIdentifier("photo.tile.\(index)")
                .draggable(photo.id)
                .dropDestination(for: String.self) { items, _ in
                    guard let moved = items.first, moved != photo.id else { return false }
                    Motion.perform(Motion.gentle) {
                        model.movePhoto(moved, to: index)
                    }
                    return true
                }
            }
        }
        .motion(Motion.gentle, value: draft.photos.map(\.id))
    }

    @ViewBuilder
    private func addPhotoButtons(_ draft: Draft) -> some View {
        let remaining = DraftStore.maxPhotosPerDraft - draft.photos.count
        UnloadedPhotosNotice(picked: $unloadedPhotos, onPicked: addPhotos)
        AdaptiveStack { addButtons(remaining: remaining) }
        if remaining <= 0 {
            Text("This draft has the most photos an item can have (\(DraftStore.maxPhotosPerDraft)).")
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
        }
    }

    @ViewBuilder
    private func addButtons(remaining: Int) -> some View {
        if environment.isCameraAvailable {
            Button {
                isCapturing = true
            } label: {
                Label("Camera", systemImage: "camera.fill")
            }
            .buttonStyle(.listoraSecondary)
            .disabled(remaining <= 0)
            .accessibilityIdentifier("draft.camera")
        }
        PhotoLibraryButton(
            maxCount: remaining,
            fixturePhotosDirectory: environment.fixturePhotosDirectory,
            unloaded: $unloadedPhotos,
            onPicked: addPhotos,
            title: "Add photos",
            systemImage: "photo.badge.plus",
        )
        .buttonStyle(.listoraSecondary)
        .disabled(remaining <= 0 || model.isPreparingPhotos)
        .loading(model.isPreparingPhotos)
        .accessibilityIdentifier("draft.addPhotos")
    }

    private func addPhotos(_ images: [Data]) async {
        _ = await model.addPhotos(images, to: draftID)
    }
}

struct PhotoSelection: Identifiable {
    let id: String
}

extension DraftUploadSummary.Tone {
    var systemImage: String {
        switch self {
        case .neutral: "arrow.up.circle.fill"
        case .empty: "photo.badge.plus"
        case .success: "checkmark.circle.fill"
        case .warning: "person.crop.circle.badge.exclamationmark"
        case .danger: "exclamationmark.triangle.fill"
        }
    }
}

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
