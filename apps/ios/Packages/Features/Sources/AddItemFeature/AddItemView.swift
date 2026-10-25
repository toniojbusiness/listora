import DesignSystem
import PhotosUI
import SwiftUI

/// The Add Item tab: start a new item from the camera or the photo library, and the drafts saved
/// on this iPhone with their upload status.
public struct AddItemView: View {
    private let environment: AddItemEnvironment
    @State private var model: AddItemModel?

    public init(environment: AddItemEnvironment) {
        self.environment = environment
        if case let .ready(store, uploader) = environment.state {
            _model = State(initialValue: AddItemModel(store: store, uploader: uploader, activity: environment.activity))
        }
    }

    public var body: some View {
        if let model {
            DraftListView(model: model, environment: environment)
        } else if case let .unavailable(message) = environment.state {
            NavigationStack {
                EmptyStateView(systemImage: "exclamationmark.triangle", title: "Drafts unavailable", message: message)
                    .navigationTitle("Add Item")
            }
        }
    }
}

/// New-item actions above the list of drafts.
struct DraftListView: View {
    let model: AddItemModel
    let environment: AddItemEnvironment
    @State private var path: [String] = []
    @State private var isCapturing = false
    @State private var unloadedPhotos: PickedPhotos<PhotosPickerItem>?

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    newItemCard
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(
                    top: Spacing.xs,
                    leading: Spacing.md,
                    bottom: Spacing.xs,
                    trailing: Spacing.md,
                ))
                if !model.drafts.isEmpty {
                    Section("Drafts") {
                        ForEach(model.drafts) { draft in
                            NavigationLink(value: draft.id) {
                                DraftRow(draft: draft, activity: model.activity, fileURL: model.store.fileURL(for:))
                            }
                            .accessibilityIdentifier("draft.row")
                        }
                        .onDelete { offsets in
                            for index in offsets {
                                model.deleteDraft(model.drafts[index].id)
                            }
                        }
                    }
                    .listRowBackground(Palette.surface.color)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.background)
            .navigationTitle("Add Item")
            .navigationDestination(for: String.self) { draftID in
                DraftEditorView(draftID: draftID, model: model, environment: environment)
            }
            .task { await model.observeDrafts() }
            .fullScreenCover(isPresented: $isCapturing) {
                CameraCaptureView { shots in
                    isCapturing = false
                    if let id = await model.save(shots) {
                        path.append(id)
                    }
                }
            }
            .alert("Couldn't save", isPresented: errorBinding) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(model.errorMessage ?? "")
            }
        }
    }

    private var newItemCard: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text("Take photos once")
                    .font(Typography.title)
                    .foregroundStyle(Palette.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                Text("Front, back, tag, and any flaws. Listora saves the draft here and uploads it in the background.")
                    .font(Typography.callout)
                    .foregroundStyle(Palette.textSecondary)
            }
            if environment.isCameraAvailable {
                Button {
                    isCapturing = true
                } label: {
                    Label("Take photos", systemImage: "camera.fill")
                }
                .buttonStyle(.listoraPrimary)
                .accessibilityIdentifier("addItem.takePhotos")
            }
            importButton
            UnloadedPhotosNotice(picked: $unloadedPhotos, onPicked: importPhotos)
            if model.isPreparingPhotos {
                ProgressView("Preparing photos")
                    .foregroundStyle(Palette.textSecondary)
                    .frame(maxWidth: .infinity)
            }
        }
        .cardStyle()
    }

    @ViewBuilder
    private var importButton: some View {
        let button = PhotoLibraryButton(
            maxCount: DraftStore.maxPhotosPerDraft,
            fixturePhotosDirectory: environment.fixturePhotosDirectory,
            unloaded: $unloadedPhotos,
            onPicked: importPhotos,
            title: "Import photos",
            systemImage: "photo.on.rectangle",
        )
        .disabled(model.isPreparingPhotos)
        .accessibilityIdentifier("addItem.importPhotos")
        if environment.isCameraAvailable {
            button.buttonStyle(.listoraSecondary)
        } else {
            button.buttonStyle(.listoraPrimary)
        }
    }

    private func importPhotos(_ images: [Data]) async {
        if let id = await model.addPhotos(images) {
            path.append(id)
        }
    }

    private var errorBinding: Binding<Bool> {
        Binding(
            get: { model.errorMessage != nil },
            set: {
                if !$0 {
                    model.errorMessage = nil
                }
            },
        )
    }
}

/// One draft in the list: cover photo, SKU once the server assigned it, and the upload summary.
struct DraftRow: View {
    let draft: Draft
    let activity: UploadActivity
    let fileURL: (DraftPhotoRecord) -> URL

    var body: some View {
        let summary = DraftUploadSummary(
            draft: draft,
            transferring: activity.transferring,
            isSignedIn: activity.isSignedIn,
        )
        HStack(spacing: Spacing.sm) {
            Group {
                if let cover = draft.photos.first {
                    PhotoThumbnail(url: fileURL(cover), pointSize: 56)
                } else {
                    Palette.surfaceSecondary.color
                }
            }
            .frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(draft.record.sku ?? "New draft")
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                Text(
                    "\(photoCount) · \(draft.record.createdAt, format: .relative(presentation: .named))",
                )
                .font(Typography.caption)
                .foregroundStyle(Palette.textSecondary)
                Text(summary.text)
                    .font(Typography.caption)
                    .foregroundStyle(summary.tone.color)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, Spacing.xxs)
        .accessibilityElement(children: .combine)
    }

    private var photoCount: String {
        draft.photos.count == 1 ? "1 photo" : "\(draft.photos.count) photos"
    }
}

extension DraftUploadSummary.Tone {
    var color: ColorToken {
        switch self {
        case .neutral, .empty: Palette.textSecondary
        case .success: Palette.success
        case .warning: Palette.warning
        case .danger: Palette.danger
        }
    }
}
