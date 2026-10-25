import Core
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
            _model = State(initialValue: AddItemModel(
                store: store,
                uploader: uploader,
                activity: environment.activity,
                meter: environment.meter,
            ))
        }
    }

    public var body: some View {
        if let model {
            DraftListView(model: model, environment: environment)
        } else if case let .unavailable(message) = environment.state {
            NavigationStack {
                EmptyStateView(
                    systemImage: "externaldrive.badge.exclamationmark",
                    tone: .failed,
                    title: "Drafts unavailable",
                    message: message,
                )
                .navigationTitle("Add Item")
            }
        }
    }
}

/// A screen of the Add Item tab's navigation stack.
enum AddItemRoute: Hashable {
    case draft(String)
    /// The review of a draft's server item (the review feature's flow).
    case review(ItemReviewRequest)
}

/// The drafts on this iPhone, with the new-item actions pinned at the bottom within thumb reach.
/// With no drafts yet, the screen explains the guided shots instead.
struct DraftListView: View {
    let model: AddItemModel
    let environment: AddItemEnvironment
    @State private var path: [AddItemRoute] = []
    @State private var isCapturing = false
    @State private var unloadedPhotos: PickedPhotos<PhotosPickerItem>?

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if model.drafts.isEmpty {
                    ScrollView {
                        NewItemGuide(isCameraAvailable: environment.isCameraAvailable)
                            .padding(Spacing.md)
                    }
                } else {
                    draftList
                }
            }
            .background(Palette.background)
            .navigationTitle("Add Item")
            .bottomActionBar { actions }
            .navigationDestination(for: AddItemRoute.self) { route in
                switch route {
                case let .draft(draftID):
                    DraftEditorView(draftID: draftID, model: model, environment: environment) { request in
                        path.append(.review(request))
                    }
                case let .review(request):
                    environment.reviewDestination?(request) { outcome in
                        finishReview(request, outcome)
                    }
                }
            }
            .task { await model.observeDrafts() }
            .motion(value: model.drafts.map(\.id))
            .fullScreenCover(isPresented: $isCapturing) {
                CameraCaptureView(camera: environment.makeCamera()) { shots in
                    isCapturing = false
                    if let id = await model.save(shots) {
                        path.append(.draft(id))
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

    private var draftList: some View {
        List {
            Section {
                ForEach(model.drafts) { draft in
                    NavigationLink(value: AddItemRoute.draft(draft.id)) {
                        DraftRow(draft: draft, activity: model.activity, fileURL: model.store.fileURL(for:))
                    }
                    .accessibilityIdentifier("draft.row")
                }
                .onDelete { offsets in
                    for index in offsets {
                        model.deleteDraft(model.drafts[index].id)
                    }
                }
            } header: {
                SectionHeader(
                    model.drafts.count == 1 ? "1 draft" : "\(model.drafts.count) drafts",
                    subtitle: "Saved on this iPhone. Uploads keep going in the background.",
                )
                .padding(.bottom, Spacing.xxs)
            }
            .listRowBackground(Palette.surface.color)
            .listSectionSeparatorTint(Palette.separator.color)
        }
        .scrollContentBackground(.hidden)
    }

    @ViewBuilder
    private var actions: some View {
        UnloadedPhotosNotice(picked: $unloadedPhotos, onPicked: importPhotos)
        if environment.isCameraAvailable {
            Button {
                model.beginNewItem()
                isCapturing = true
            } label: {
                Label("Take photos", systemImage: "camera.fill")
            }
            .buttonStyle(.listoraPrimary)
            .accessibilityIdentifier("addItem.takePhotos")
        }
        importButton
    }

    @ViewBuilder
    private var importButton: some View {
        let button = PhotoLibraryButton(
            maxCount: DraftStore.maxPhotosPerDraft,
            fixturePhotosDirectory: environment.fixturePhotosDirectory,
            unloaded: $unloadedPhotos,
            onPicked: importPhotos,
            title: environment.isCameraAvailable ? "Import from library" : "Import photos",
            systemImage: "photo.on.rectangle",
        )
        .disabled(model.isPreparingPhotos)
        .loading(model.isPreparingPhotos)
        .accessibilityIdentifier("addItem.importPhotos")
        if environment.isCameraAvailable {
            button.buttonStyle(.listora(.tertiary, size: .large))
        } else {
            button.buttonStyle(.listoraPrimary)
        }
    }

    private func importPhotos(_ images: [Data]) async {
        if let id = await model.addPhotos(images) {
            path.append(.draft(id))
        }
    }

    /// A saved item's draft is done: back to the list, without it. Changing the photos, or leaving
    /// the review, goes back to the draft.
    private func finishReview(_ request: ItemReviewRequest, _ outcome: ItemReviewOutcome) {
        switch outcome {
        case .saved:
            path = []
            model.completeDraft(request.sessionID)
        case .editPhotos, .back:
            if case .review = path.last {
                path.removeLast()
            }
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

/// What a new item needs, shown before the first draft: the guided shots in order.
struct NewItemGuide: View {
    let isCameraAvailable: Bool

    private static let cameraIntro =
        "Listora guides you through each shot, saves the draft on this iPhone, and uploads it in the background."
    private static let importIntro =
        "Import the item's photos. Listora saves the draft on this iPhone and uploads it in the background."

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
            Label(
                "Photos stay on this iPhone until you sign in, and their location is removed before upload.",
                systemImage: "lock.shield",
            )
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
