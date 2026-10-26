import Core
import DesignSystem
import PhotosUI
import SwiftUI

/// One draft's photos: their order (the first is the cover), roles, and upload status. Tap a
/// photo to change its role, crop it, make it the cover, or remove it; drag photos to reorder.
/// Review item and adding photos sit at the bottom, within thumb reach. "Review item" opens the
/// review once the server has every photo; tapped earlier, it waits for the upload and then opens
/// it.
struct DraftEditorView: View {
    let draftID: String
    let model: AddItemModel
    let environment: AddItemEnvironment
    let onReview: (ItemReviewRequest) -> Void

    @State private var draft: Draft?
    @State private var selection: PhotoSelection?
    @State private var isCapturing = false
    @State private var isConfirmingDelete = false
    @State private var unloadedPhotos: PickedPhotos<PhotosPickerItem>?
    /// "Review item" was tapped before the upload finished.
    @State private var isWaitingToReview = false
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
                if !draft.photos.isEmpty, environment.reviewDestination != nil {
                    reviewButton
                }
                addPhotoButtons(draft)
            }
        }
        .onAppear { model.meter.enter(draftID) }
        .onDisappear {
            isWaitingToReview = false
            model.meter.setWaiting(false, for: draftID)
            model.meter.leave(draftID)
        }
        .onChange(of: reviewRequest) { _, request in
            guard isWaitingToReview, let request else { return }
            openReview(request)
        }
        .onChange(of: canWaitForUpload) { _, canWait in
            if !canWait, isWaitingToReview {
                isWaitingToReview = false
                model.meter.setWaiting(false, for: draftID)
            }
        }
        .confirmationDialog("Delete this draft?", isPresented: $isConfirmingDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { model.deleteDraft(draftID) }
        } message: {
            Text("Its photos are removed from this iPhone and from Listora.")
        }
        .sheet(item: $selection) { selection in
            Group {
                // The observed draft can lag a moment behind a cleanup's new photo; the store has it.
                if let photo = draft?.photos.first(where: { $0.id == selection.photoID })
                    ?? (try? model.store.photo(id: selection.photoID))
                {
                    PhotoDetailView(photo: photo, model: model) { newID in
                        self.selection?.photoID = newID
                    }
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

    private func summary(_ draft: Draft) -> DraftUploadSummary {
        DraftUploadSummary(
            draft: draft,
            transferring: model.activity.transferring,
            isSignedIn: model.activity.isSignedIn,
        )
    }

    /// The review of the draft's item, once the server has all of its photos.
    private var reviewRequest: ItemReviewRequest? {
        guard let draft, summary(draft).isComplete, let itemID = draft.record.serverItemID else { return nil }
        return ItemReviewRequest(sessionID: draftID, itemID: itemID, sku: draft.record.sku)
    }

    /// The upload is still going (signed in, nothing stopped), so the review can wait for it.
    private var canWaitForUpload: Bool {
        guard let draft else { return false }
        let summary = summary(draft)
        return model.activity.isSignedIn && !summary.canRetry && summary.tone != .empty
    }

    private func openReview(_ request: ItemReviewRequest) {
        isWaitingToReview = false
        model.meter.setWaiting(false, for: draftID)
        onReview(request)
    }

    @ViewBuilder
    private var reviewButton: some View {
        Button {
            if let reviewRequest {
                openReview(reviewRequest)
            } else {
                isWaitingToReview = true
                model.meter.setWaiting(true, for: draftID)
            }
        } label: {
            if isWaitingToReview {
                HStack(spacing: Spacing.xs) {
                    ProgressView().tint(Palette.onBrand.color)
                    Text("Uploading, then review")
                }
            } else {
                Label("Review item", systemImage: "sparkles")
            }
        }
        .buttonStyle(.listoraPrimary)
        .disabled(isWaitingToReview || (reviewRequest == nil && !canWaitForUpload))
        .accessibilityIdentifier("draft.review")
        if reviewRequest == nil, !canWaitForUpload, !model.activity.isSignedIn {
            Text("Sign in to upload the photos, then review the item.")
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
        }
    }
}

extension DraftEditorView {
    private func photoGrid(_ draft: Draft) -> some View {
        LazyVGrid(columns: columns, spacing: Spacing.xs) {
            ForEach(Array(draft.photos.enumerated()), id: \.element.id) { index, photo in
                Button {
                    selection = PhotoSelection(id: photo.id, photoID: photo.id)
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
}

/// The photo open in the detail sheet. `id` stays the photo first opened, so the sheet stays up
/// when a background cleanup replaces the photo; `photoID` follows the replacement.
struct PhotoSelection: Identifiable {
    let id: String
    var photoID: String
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
