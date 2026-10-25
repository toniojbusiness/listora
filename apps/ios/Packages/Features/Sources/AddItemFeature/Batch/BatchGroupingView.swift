import Core
import DesignSystem
import SwiftUI

/// The seller checks how Listora grouped the haul before the items are created: one card per
/// item with its photos. A photo drags onto another item; tapping it offers to start a new item
/// there, move it, or remove it; an item merges into the one before. Close calls are highlighted
/// and ask, so two items are never merged without the seller seeing it.
struct BatchGroupingView: View {
    let model: BatchModel
    let reader: any PhotoSignalReader
    /// Called after the items are created.
    let onConfirmed: @MainActor () -> Void
    /// Opens the camera again for more photos of this batch.
    let onKeepShooting: @MainActor () -> Void

    @State private var selectedShot: BatchShotRecord?
    @State private var isConfirming = false
    @State private var targetedStackID: String?

    var body: some View {
        Group {
            if let batch = model.batch {
                content(batch)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Palette.background)
        .navigationTitle("Check the items")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.groupNewPhotos(reader: reader) }
        .measuresInteraction(model.meter, session: BatchRecord.meterSession(model.batchID))
        .confirmationDialog(
            "Photo",
            isPresented: Binding(get: { selectedShot != nil }, set: {
                if !$0 {
                    selectedShot = nil
                }
            }),
            titleVisibility: .hidden,
            presenting: selectedShot,
        ) { shot in
            photoActions(shot)
        }
        .alert("Couldn't save", isPresented: errorBinding) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
    }

    private func content(_ batch: Batch) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Spacing.md) {
                header(batch)
                ForEach(Array(batch.stacks.enumerated()), id: \.element.id) { index, stack in
                    if stack.record.startNeedsReview {
                        closeCall(stack, index: index)
                    }
                    StackCard(
                        stack: stack,
                        index: index,
                        fileURL: model.store.fileURL(for:),
                        isTargeted: targetedStackID == stack.id,
                        canMerge: index > 0,
                        onSelect: { selectedShot = $0 },
                        onSplit: { model.split(at: $0.id) },
                        onKeep: { model.keepTogether($0.id) },
                        onMerge: { model.mergeIntoPrevious(stack.id) },
                    )
                    .dropDestination(for: String.self) { ids, _ in
                        for id in ids {
                            model.move(id, toStack: stack.id)
                        }
                        return !ids.isEmpty
                    } isTargeted: { targeted in
                        if targeted {
                            targetedStackID = stack.id
                        } else if targetedStackID == stack.id {
                            targetedStackID = nil
                        }
                    }
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
        }
        .motion(value: batch.stacks.map(\.shots))
        .bottomActionBar { actions(batch) }
    }

    @ViewBuilder
    private func actions(_ batch: Batch) -> some View {
        Button {
            Task {
                isConfirming = true
                defer { isConfirming = false }
                if await model.confirm() {
                    Haptics.play(.success)
                    onConfirmed()
                }
            }
        } label: {
            Label(confirmTitle(batch), systemImage: "checkmark.circle.fill")
        }
        .buttonStyle(.listoraPrimary)
        .loading(isConfirming)
        .disabled(batch.stacks.isEmpty || isConfirming)
        .accessibilityIdentifier("batchGrouping.confirm")
        Button {
            onKeepShooting()
        } label: {
            Label("Keep shooting", systemImage: "camera.fill")
        }
        .buttonStyle(.listora(.tertiary, size: .large))
        .accessibilityIdentifier("batchGrouping.keepShooting")
    }

    /// "1 photo", "3 photos".
    private static func count(_ count: Int, _ noun: String) -> String {
        count == 1 ? "1 \(noun)" : "\(count) \(noun)s"
    }

    private func confirmTitle(_ batch: Batch) -> String {
        batch.stacks.count == 1 ? "Create 1 item" : "Create \(batch.stacks.count) items"
    }

    private func header(_ batch: Batch) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            let photos = batch.unconfirmedShotCount
            Text(
                "\(Self.count(batch.stacks.count, "item")) from \(Self.count(photos, "photo"))",
            )
            .font(Typography.title3)
            .foregroundStyle(Palette.textPrimary)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("batchGrouping.summary")
            Text("Drag a photo onto another item to move it, or tap it for more.")
                .font(Typography.callout)
                .foregroundStyle(Palette.textSecondary)
            if batch.reviewCount > 0 {
                Banner(
                    batch.reviewCount == 1 ? "Check 1 close call" : "Check \(batch.reviewCount) close calls",
                    message: "Listora wasn't sure where one item ends and the next begins. They're highlighted below.",
                    tone: .actionNeeded,
                    identifier: "batchGrouping.closeCalls",
                )
            }
        }
    }

    /// The boundary before `stack` is a close call: one item, or two?
    private func closeCall(_ stack: Batch.Stack, index: Int) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Label("Item \(index + 1) may be the same item as item \(index)", systemImage: "questionmark.circle.fill")
                .font(Typography.subheadline.weight(.semibold))
                .foregroundStyle(Palette.textPrimary)
            AdaptiveStack {
                Button("Same item - merge") { model.mergeIntoPrevious(stack.id) }
                    .buttonStyle(.listora(.secondary, size: .compact))
                    .accessibilityIdentifier("batchGrouping.merge.\(index)")
                Button("Different items") { model.keepApart(stack.id) }
                    .buttonStyle(.listora(.tertiary, size: .compact))
                    .accessibilityIdentifier("batchGrouping.keepApart.\(index)")
            }
        }
        .cardStyle(.tinted(.actionNeeded), padding: Spacing.sm)
    }

    @ViewBuilder
    private func photoActions(_ shot: BatchShotRecord) -> some View {
        let stacks = model.batch?.stacks ?? []
        let index = stacks.firstIndex { $0.id == shot.stackID }
        if let index, stacks[index].shots.first?.id != shot.id {
            Button("Start a new item here") { model.split(at: shot.id) }
        }
        if let index, index > 0 {
            Button("Move to item \(index)") { model.move(shot.id, toStack: stacks[index - 1].id) }
        }
        if let index, index + 1 < stacks.count {
            Button("Move to item \(index + 2)") { model.move(shot.id, toStack: stacks[index + 1].id) }
        }
        if let index, stacks[index].shots.count > 1 {
            Button("Make it an item of its own") { model.moveToNewItem(shot.id) }
        }
        Button("Remove photo", role: .destructive) { model.remove(shot.id) }
        Button("Cancel", role: .cancel) {}
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

/// One proposed item: its number, its photos (draggable), and the photo the grouper was unsure
/// about, if any.
private struct StackCard: View {
    let stack: Batch.Stack
    let index: Int
    let fileURL: (BatchShotRecord) -> URL
    let isTargeted: Bool
    let canMerge: Bool
    let onSelect: (BatchShotRecord) -> Void
    let onSplit: (BatchShotRecord) -> Void
    let onKeep: (BatchShotRecord) -> Void
    let onMerge: () -> Void
    @ScaledMetric(relativeTo: .body) private var photoSize: CGFloat = 84

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack {
                Text("Item \(index + 1)")
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                Text(stack.shots.count == 1 ? "1 photo" : "\(stack.shots.count) photos")
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                Spacer()
                if canMerge {
                    Menu {
                        Button("Merge with item \(index)", action: onMerge)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(Typography.title3)
                            .foregroundStyle(Palette.brand)
                            .frame(width: Layout.minimumTapTarget, height: Layout.minimumTapTarget)
                    }
                    .accessibilityLabel("More for item \(index + 1)")
                    .accessibilityIdentifier("batchGrouping.stackMenu.\(index)")
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("batchGrouping.stack.\(index)")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.xs) {
                    ForEach(Array(stack.shots.enumerated()), id: \.element.id) { position, shot in
                        photo(shot, position: position)
                    }
                }
            }
            .scrollClipDisabled()
            if let uncertain = stack.shots.first(where: \.uncertain),
               let number = stack.shots.firstIndex(of: uncertain)
            {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Label("Photo \(number + 1) may start a new item", systemImage: "questionmark.circle.fill")
                        .font(Typography.subheadline.weight(.semibold))
                        .foregroundStyle(Palette.textPrimary)
                    AdaptiveStack {
                        Button("New item from here") { onSplit(uncertain) }
                            .buttonStyle(.listora(.secondary, size: .compact))
                            .accessibilityIdentifier("batchGrouping.split.\(index)")
                        Button("Same item") { onKeep(uncertain) }
                            .buttonStyle(.listora(.tertiary, size: .compact))
                            .accessibilityIdentifier("batchGrouping.keepTogether.\(index)")
                    }
                }
                .cardStyle(.tinted(.actionNeeded), padding: Spacing.sm)
            }
        }
        .cardStyle(isTargeted ? .tinted(.inProgress) : .elevated)
    }

    private func photo(_ shot: BatchShotRecord, position: Int) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
        return Button {
            onSelect(shot)
        } label: {
            PhotoThumbnail(url: fileURL(shot), pointSize: photoSize)
                .frame(width: photoSize, height: photoSize)
                .clipShape(shape)
                .overlay(shape.strokeBorder(
                    shot.uncertain ? Palette.warning : Palette.separator,
                    lineWidth: shot.uncertain ? 3 : 1,
                ))
                .overlay(alignment: .bottomLeading) {
                    if shot.signals?.looksLikeTag == true {
                        Chip("Tag", systemImage: "tag").padding(Spacing.xxs)
                    }
                }
        }
        .buttonStyle(.plain)
        .draggable(shot.id) {
            PhotoThumbnail(url: fileURL(shot), pointSize: 64)
                .frame(width: 64, height: 64)
                .clipShape(shape)
        }
        .accessibilityLabel(accessibilityLabel(shot, position: position))
        .accessibilityHint("Shows what you can do with this photo")
        .accessibilityIdentifier("batchGrouping.photo.\(index).\(position)")
    }

    private func accessibilityLabel(_ shot: BatchShotRecord, position: Int) -> String {
        var parts = ["Item \(index + 1), photo \(position + 1)"]
        if shot.signals?.looksLikeTag == true {
            parts.append("tag")
        }
        if shot.uncertain {
            parts.append("may start a new item")
        }
        return parts.joined(separator: ", ")
    }
}

extension View {
    /// Counts the screen's time and taps toward the interaction measurement of `session`.
    func measuresInteraction(_ meter: InteractionMeter, session: String) -> some View {
        onAppear { meter.enter(session) }
            .onDisappear { meter.leave(session) }
    }
}
