import Core
import DesignSystem
import SwiftUI

/// A batch: every item with where it is (uploading on this iPhone, then the server's own words:
/// "Analyzing...", "Ready to review", "Saved"), the photos still to check, and the way on: review
/// the analyzed items, or shoot more of the haul while the rest upload and analyze.
struct BatchView: View {
    let model: BatchModel
    let onCheckGrouping: @MainActor () -> Void
    let onKeepShooting: @MainActor () -> Void
    let onReview: @MainActor (BatchReviewRequest) -> Void
    let onEditPhotos: @MainActor (String) -> Void
    let onDeleted: @MainActor () -> Void

    @State private var isConfirmingDelete = false
    @ScaledMetric(relativeTo: .headline) private var thumbnailSize: CGFloat = 56

    var body: some View {
        Group {
            if let batch = model.batch {
                content(batch)
            } else if model.isGone {
                EmptyStateView(
                    systemImage: "checkmark.circle",
                    tone: .success,
                    title: "Batch done",
                    message: "Its saved items are in your inventory.",
                    action: .init("Done") { onDeleted() },
                )
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Palette.background)
        .navigationTitle("Batch")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Delete batch", systemImage: "trash", role: .destructive) { isConfirmingDelete = true }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("More")
                .accessibilityIdentifier("batch.menu")
            }
        }
        .task { await model.observe() }
        .task(id: model.batch?.record.serverBatchID) { await model.poll() }
        .measuresInteraction(model.meter, session: BatchRecord.meterSession(model.batchID))
        .confirmationDialog("Delete this batch?", isPresented: $isConfirmingDelete, titleVisibility: .visible) {
            Button("Delete batch", role: .destructive) {
                model.deleteBatch()
                onDeleted()
            }
            Button("Keep it", role: .cancel) {}
        } message: {
            Text("Its photos and the items you haven't saved are deleted. Saved items stay in your inventory.")
        }
        .alert("Couldn't save", isPresented: errorBinding) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
    }

    private func content(_ batch: Batch) -> some View {
        let rows = model.rows
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: Spacing.lg) {
                summary(rows)
                if let problem = model.serverProblem {
                    Banner(problem, tone: .failed, action: .init("Try again") { Task { await model.refresh() } })
                }
                if batch.unconfirmedShotCount > 0 {
                    toCheck(batch)
                }
                if !rows.isEmpty {
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        SectionHeader(
                            rows.count == 1 ? "1 item" : "\(rows.count) items",
                            subtitle: "Each uploads and is analyzed on its own while you keep going.",
                        )
                        VStack(spacing: 0) {
                            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                                if index > 0 {
                                    Divider().overlay(Palette.separator.color)
                                }
                                rowView(row, index: index)
                            }
                        }
                        .cardStyle(.outlined, padding: 0)
                    }
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
        }
        .bottomActionBar {
            if let request = model.reviewRequest {
                Button {
                    onReview(request)
                } label: {
                    Label(reviewTitle, systemImage: "checklist")
                }
                .buttonStyle(.listoraPrimary)
                .accessibilityIdentifier("batch.review")
            }
            Button {
                onKeepShooting()
            } label: {
                Label("Keep shooting", systemImage: "camera.fill")
            }
            .buttonStyle(model.reviewRequest == nil ? .listoraPrimary : .listora(.tertiary, size: .large))
            .accessibilityIdentifier("batch.keepShooting")
        }
    }

    private var reviewTitle: String {
        let ready = model.rows.count { $0.isReviewable }
        return ready == 1 ? "Review 1 item" : "Review \(ready) items"
    }

    private func summary(_ rows: [BatchItemRow]) -> some View {
        let saved = rows.count(where: \.isSaved)
        let ready = rows.count(where: \.isAnalyzed)
        let total = max(rows.count, 1)
        return VStack(alignment: .leading, spacing: Spacing.sm) {
            Text(rows.isEmpty ? "No items yet" : "\(saved) of \(rows.count) saved")
                .font(Typography.title3)
                .foregroundStyle(Palette.textPrimary)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("batch.summary")
            ProgressView(value: Double(saved), total: Double(total))
                .tint(Palette.brand.color)
                .accessibilityHidden(true)
            Text(ready == 0 ? "Items show here as they're analyzed." : "\(ready) ready to review.")
                .font(Typography.callout)
                .foregroundStyle(Palette.textSecondary)
        }
        .cardStyle()
    }

    private func toCheck(_ batch: Batch) -> some View {
        let photos = batch.unconfirmedShotCount
        return VStack(alignment: .leading, spacing: Spacing.sm) {
            Label(
                photos == 1 ? "1 new photo to group" : "\(photos) new photos to group",
                systemImage: "square.stack.3d.up",
            )
            .font(Typography.headline)
            .foregroundStyle(Palette.textPrimary)
            Text("Check which photos belong together, then Listora creates the items.")
                .font(Typography.callout)
                .foregroundStyle(Palette.textSecondary)
            Button("Check the items", action: onCheckGrouping)
                .buttonStyle(.listora(.secondary, size: .compact))
                .accessibilityIdentifier("batch.checkGrouping")
        }
        .cardStyle(.tinted(.actionNeeded))
    }

    private func rowView(_ row: BatchItemRow, index: Int) -> some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            cover(row)
                .frame(width: thumbnailSize, height: thumbnailSize)
                .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(row.title)
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                StatusBadge(row.status, tone: Self.tone(row.tone))
                    .accessibilityIdentifier("batch.item.status.\(index)")
                if let detail = row.detail {
                    Text(detail)
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let action = row.action {
                    actionButton(action)
                        .padding(.top, Spacing.xxs)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(Spacing.sm)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("batch.item.\(index)")
    }

    @ViewBuilder
    private func cover(_ row: BatchItemRow) -> some View {
        if let file = row.coverFile {
            PhotoThumbnail(url: file, pointSize: thumbnailSize)
        } else {
            AsyncImage(url: row.coverURL) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFill()
                } else {
                    Palette.surfaceSecondary.color
                }
            }
        }
    }

    @ViewBuilder
    private func actionButton(_ action: BatchItemRow.Action) -> some View {
        switch action {
        case .retryUpload, .resubmit:
            Button("Retry") { model.perform(action) }
                .buttonStyle(.listora(.secondary, size: .compact))
                .accessibilityIdentifier("batch.item.retry")
        case let .editPhotos(draftID):
            Button("Edit photos") { onEditPhotos(draftID) }
                .buttonStyle(.listora(.secondary, size: .compact))
                .accessibilityIdentifier("batch.item.editPhotos")
        }
    }

    private static func tone(_ tone: BatchItemRow.Tone) -> StatusTone {
        switch tone {
        case .success: .success
        case .inProgress: .inProgress
        case .actionNeeded: .actionNeeded
        case .failed: .failed
        case .neutral: .neutral
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
