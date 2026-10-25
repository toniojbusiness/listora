import Core
import DesignSystem
import SwiftUI

/// The batch screen in the Add Item stack, with a model of its own.
struct BatchScreen: View {
    let onCheckGrouping: @MainActor () -> Void
    let onKeepShooting: @MainActor () -> Void
    let onReview: @MainActor (BatchReviewRequest) -> Void
    let onEditPhotos: @MainActor (String) -> Void
    let onDeleted: @MainActor () -> Void
    @State private var model: BatchModel

    init(
        batchID: String,
        model addItem: AddItemModel,
        environment: AddItemEnvironment,
        onCheckGrouping: @escaping @MainActor () -> Void,
        onKeepShooting: @escaping @MainActor () -> Void,
        onReview: @escaping @MainActor (BatchReviewRequest) -> Void,
        onEditPhotos: @escaping @MainActor (String) -> Void,
        onDeleted: @escaping @MainActor () -> Void,
    ) {
        self.onCheckGrouping = onCheckGrouping
        self.onKeepShooting = onKeepShooting
        self.onReview = onReview
        self.onEditPhotos = onEditPhotos
        self.onDeleted = onDeleted
        _model = State(initialValue: BatchModel(
            batchID: batchID,
            store: addItem.store,
            uploader: addItem.uploader,
            activity: addItem.activity,
            meter: addItem.meter,
            source: environment.batchProgress,
        ))
    }

    var body: some View {
        BatchView(
            model: model,
            onCheckGrouping: onCheckGrouping,
            onKeepShooting: onKeepShooting,
            onReview: onReview,
            onEditPhotos: onEditPhotos,
            onDeleted: onDeleted,
        )
    }
}

/// The grouping check in the Add Item stack, with a model of its own.
struct BatchGroupingScreen: View {
    let reader: any PhotoSignalReader
    let onConfirmed: @MainActor () -> Void
    let onKeepShooting: @MainActor () -> Void
    @State private var model: BatchModel

    init(
        batchID: String,
        model addItem: AddItemModel,
        environment: AddItemEnvironment,
        onConfirmed: @escaping @MainActor () -> Void,
        onKeepShooting: @escaping @MainActor () -> Void,
    ) {
        reader = environment.signalReader
        self.onConfirmed = onConfirmed
        self.onKeepShooting = onKeepShooting
        _model = State(initialValue: BatchModel(
            batchID: batchID,
            store: addItem.store,
            uploader: addItem.uploader,
            activity: addItem.activity,
            meter: addItem.meter,
            source: environment.batchProgress,
        ))
    }

    var body: some View {
        BatchGroupingView(model: model, reader: reader, onConfirmed: onConfirmed, onKeepShooting: onKeepShooting)
            .task { await model.observe() }
    }
}

/// One batch in the Add Item list: its cover, how many items and photos it has, and what needs
/// the seller.
struct BatchRow: View {
    let batch: Batch
    let fileURL: (BatchShotRecord) -> URL
    let draftFileURL: (DraftPhotoRecord) -> URL
    @ScaledMetric(relativeTo: .headline) private var thumbnailSize: CGFloat = 64

    var body: some View {
        HStack(spacing: Spacing.sm) {
            cover
                .frame(width: min(thumbnailSize, 96), height: min(thumbnailSize, 96))
                .clipShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text("Batch · \(itemCount)")
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                Text(batch.record.createdAt, format: .relative(presentation: .named))
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                if batch.unconfirmedShotCount > 0 {
                    StatusBadge(
                        batch
                            .unconfirmedShotCount == 1 ? "1 photo to group" :
                            "\(batch.unconfirmedShotCount) photos to group",
                        tone: .actionNeeded,
                    )
                    .padding(.top, 2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, Spacing.xs)
        .accessibilityElement(children: .combine)
    }

    private var itemCount: String {
        let items = batch.drafts.count + batch.stacks.count
        return items == 1 ? "1 item" : "\(items) items"
    }

    @ViewBuilder
    private var cover: some View {
        if let photo = batch.drafts.first?.photos.first {
            PhotoThumbnail(url: draftFileURL(photo), pointSize: thumbnailSize)
        } else if let shot = batch.stacks.first?.shots.first ?? batch.ungrouped.first {
            PhotoThumbnail(url: fileURL(shot), pointSize: thumbnailSize)
        } else {
            Palette.surfaceSecondary.color
                .overlay(Image(systemName: "square.stack.3d.up").foregroundStyle(Palette.textSecondary))
        }
    }
}

/// What batch mode does, shown before the first batch.
struct BatchGuide: View {
    let isCameraAvailable: Bool

    private struct Step {
        let title: String
        let detail: String
        let systemImage: String
    }

    private static let steps = [
        Step(
            title: "Shoot the whole haul",
            detail: "Front, back, then the tag of each item, one after another",
            systemImage: "camera.on.rectangle",
        ),
        Step(
            title: "Listora splits it into items",
            detail: "It sees where one item ends; tap Next item to start one yourself",
            systemImage: "square.stack.3d.up",
        ),
        Step(
            title: "Check the grouping",
            detail: "Drag a photo to move it; close calls are highlighted",
            systemImage: "hand.draw",
        ),
        Step(
            title: "Swipe through the review",
            detail: "Fix what Listora wasn't sure about, approve, next",
            systemImage: "checklist",
        ),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text("A whole haul at once")
                    .font(Typography.title)
                    .foregroundStyle(Palette.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                Text(
                    isCameraAvailable
                        ? "Shoot every item in one go. Each one uploads and is analyzed while you keep shooting."
                        : "Import a haul's photos in the order you took them. Listora splits them into items.",
                )
                .font(Typography.body)
                .foregroundStyle(Palette.textSecondary)
            }
            VStack(spacing: 0) {
                ForEach(Array(Self.steps.enumerated()), id: \.offset) { index, step in
                    if index > 0 {
                        Divider().overlay(Palette.separator.color).padding(.leading, 36 + Spacing.sm)
                    }
                    ListRow(step.title, subtitle: step.detail, systemImage: step.systemImage)
                        .padding(.vertical, Spacing.xs)
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("Step \(index + 1): \(step.title). \(step.detail)")
                }
            }
            .cardStyle()
        }
        .frame(maxWidth: Layout.readableWidth, alignment: .leading)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("addItem.batchGuide")
    }
}
