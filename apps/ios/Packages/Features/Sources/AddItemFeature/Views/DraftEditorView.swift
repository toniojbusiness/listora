import DesignSystem
import PhotosUI
import SwiftUI

/// One draft's photos: their order (the first is the cover), roles, and upload status. Tap a
/// photo to change its role, crop it, make it the cover, or remove it; drag photos to reorder.
struct DraftEditorView: View {
    let draftID: String
    let model: AddItemModel
    let environment: AddItemEnvironment

    @State private var draft: Draft?
    @State private var selection: PhotoSelection?
    @State private var isCapturing = false
    @State private var isConfirmingDelete = false
    @State private var unloadedPhotos: PickedPhotos<PhotosPickerItem>?
    @Environment(\.dismiss) private var dismiss

    private let columns = Array(repeating: GridItem(.flexible(), spacing: Spacing.xs), count: 3)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.md) {
                if let draft {
                    UploadSummaryBanner(
                        summary: DraftUploadSummary(
                            draft: draft,
                            transferring: model.activity.transferring,
                            isSignedIn: model.activity.isSignedIn,
                        ),
                        onRetry: { model.retry(draftID) },
                    )
                    photoGrid(draft)
                    Text(
                        "Tap a photo to set its role, crop, or remove it. Drag to reorder; the first is the cover.",
                    )
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                    addPhotoButtons(draft)
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
                    Label("More", systemImage: "ellipsis.circle")
                }
                .accessibilityIdentifier("draft.more")
            }
        }
        .confirmationDialog("Delete this draft?", isPresented: $isConfirmingDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { model.deleteDraft(draftID) }
        } message: {
            Text("Its photos are removed from this iPhone and from Listora.")
        }
        .sheet(item: $selection) { selection in
            if let photo = draft?.photos.first(where: { $0.id == selection.id }) {
                PhotoDetailView(photo: photo, model: model)
            } else {
                // The photo was removed or replaced (cropped) while open.
                Color.clear.onAppear { self.selection = nil }
            }
        }
        .fullScreenCover(isPresented: $isCapturing) {
            CameraCaptureView(capacity: DraftStore.maxPhotosPerDraft - (draft?.photos.count ?? 0)) { shots in
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
                .accessibilityIdentifier("photo.tile.\(index)")
                .draggable(photo.id)
                .dropDestination(for: String.self) { items, _ in
                    guard let moved = items.first, moved != photo.id else { return false }
                    model.movePhoto(moved, to: index)
                    return true
                }
            }
        }
    }

    private func addPhotoButtons(_ draft: Draft) -> some View {
        let remaining = DraftStore.maxPhotosPerDraft - draft.photos.count
        return VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(spacing: Spacing.sm) {
                if environment.isCameraAvailable {
                    Button {
                        isCapturing = true
                    } label: {
                        Label("Camera", systemImage: "camera")
                    }
                    .buttonStyle(.listoraSecondary)
                    .disabled(remaining <= 0)
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
                .accessibilityIdentifier("draft.addPhotos")
            }
            UnloadedPhotosNotice(picked: $unloadedPhotos, onPicked: addPhotos)
        }
    }

    private func addPhotos(_ images: [Data]) async {
        _ = await model.addPhotos(images, to: draftID)
    }
}

struct PhotoSelection: Identifiable {
    let id: String
}

/// The draft's upload state in one line, with Retry when retries stopped.
struct UploadSummaryBanner: View {
    let summary: DraftUploadSummary
    let onRetry: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
            Image(systemName: icon)
                .foregroundStyle(summary.tone.color)
                .accessibilityHidden(true)
            Text(summary.text)
                .font(Typography.callout)
                .foregroundStyle(Palette.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("draft.uploadSummary")
            if summary.canRetry {
                Button("Retry", action: onRetry)
                    .font(Typography.headline)
                    .foregroundStyle(Palette.brand)
                    .frame(minHeight: Layout.minimumTapTarget)
                    .accessibilityIdentifier("draft.retry")
            }
        }
        .cardStyle()
    }

    private var icon: String {
        switch summary.tone {
        case .neutral: "arrow.up.circle"
        case .empty: "photo.badge.plus"
        case .success: "checkmark.circle.fill"
        case .warning: "person.crop.circle.badge.exclamationmark"
        case .danger: "exclamationmark.triangle.fill"
        }
    }
}

/// A photo in the editor grid: the image, its role, whether it is the cover, and its upload state.
struct PhotoTile: View {
    let photo: DraftPhotoRecord
    let index: Int
    let url: URL
    let status: PhotoUploadStatus

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay { PhotoThumbnail(url: url, pointSize: 130) }
            .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .overlay(alignment: .topLeading) {
                if index == 0 {
                    chip("Cover")
                }
            }
            .overlay(alignment: .topTrailing) {
                statusBadge
            }
            .overlay(alignment: .bottomLeading) {
                HStack(spacing: Spacing.xxs) {
                    chip(photo.role.title)
                    if photo.looksBlurry {
                        Image(systemName: "drop.triangle.fill")
                            .font(Typography.caption)
                            .foregroundStyle(Palette.warning)
                            .padding(Spacing.xxs)
                            .background(Palette.surface, in: Circle())
                    }
                }
                .padding(Spacing.xxs)
            }
            .contentShape(Rectangle())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText)
            .accessibilityAddTraits(.isButton)
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

    private func chip(_ text: String) -> some View {
        Text(text)
            .font(Typography.caption.weight(.semibold))
            .foregroundStyle(Palette.textPrimary)
            .padding(.horizontal, Spacing.xs)
            .padding(.vertical, Spacing.xxs)
            .background(Palette.surface, in: Capsule())
            .padding(Spacing.xxs)
    }

    private var statusBadge: some View {
        Group {
            if status == .uploading || status == .readingTag {
                ProgressView()
                    .controlSize(.small)
            } else {
                Image(systemName: status.systemImage)
                    .font(Typography.caption)
                    .foregroundStyle(statusColor)
            }
        }
        .frame(width: 24, height: 24)
        .background(Palette.surface, in: Circle())
        .padding(Spacing.xxs)
    }

    private var statusColor: ColorToken {
        switch status {
        case .uploaded: Palette.success
        case .failed: Palette.danger
        case .waitingForSignIn, .retrying: Palette.warning
        case .waiting, .uploading, .readingTag: Palette.textSecondary
        }
    }
}
