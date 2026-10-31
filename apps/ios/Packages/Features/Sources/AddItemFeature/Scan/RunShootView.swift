import DesignSystem
import SwiftUI

/// Shoot this run (docs/features/thrift-scan.md, "Upgrading drafts"): the guided camera walks
/// through the run's kept drafts that need photos, in the order they were kept, with each one's
/// scan shot and name on screen ("3 of 23: Patagonia green fleece"). It is the guided capture of
/// one item, item after item: each item's boundary is known, so there is no grouping step. Done
/// saves the item's photos and moves to the next; the scan shot goes unless the seller keeps it.
struct RunShootView: View {
    /// The drafts to shoot, by id, fixed when the shoot opened.
    let draftIDs: [String]
    let model: AddItemModel
    let environment: AddItemEnvironment
    let onClose: @MainActor () -> Void

    @State private var index = 0
    @State private var keepsScanShot = false

    var body: some View {
        if let draft = currentDraft {
            CameraCaptureView(
                camera: environment.makeCamera(),
                capacity: DraftStore.maxPhotosPerDraft - (keepsScanShot ? draft.photos.count : 0),
                header: AnyView(header(for: draft)),
            ) { shots in
                await finish(draft, shots)
            }
            // A fresh guide and camera for every item.
            .id(draft.id)
        } else {
            Palette.mediaBackground.color
                .ignoresSafeArea()
                .task { onClose() }
        }
    }

    /// The draft being shot: the next one still on this iPhone (a draft deleted meanwhile is left
    /// out).
    private var currentDraft: Draft? {
        draftIDs.indices.dropFirst(index).lazy
            .compactMap { position in model.drafts.first { $0.id == draftIDs[position] } }
            .first
    }

    private var currentNumber: Int {
        guard let draft = currentDraft, let position = draftIDs.firstIndex(of: draft.id) else { return index + 1 }
        return position + 1
    }

    private func header(for draft: Draft) -> some View {
        HStack(alignment: .center, spacing: Spacing.sm) {
            if let shot = draft.photos.first(where: \.isScanShot) {
                PhotoThumbnail(url: model.store.fileURL(for: shot), pointSize: 52)
                    .frame(width: 52, height: 52)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(KeptScanRun.shootTitle(draft, number: currentNumber, of: draftIDs.count))
                    .font(Typography.headline)
                    .lineLimit(2)
                    .accessibilityIdentifier("runShoot.title")
                HStack(spacing: Spacing.xs) {
                    ChoiceChip("Keep scan photo", systemImage: "camera.viewfinder", isSelected: keepsScanShot) {
                        keepsScanShot.toggle()
                    }
                    .accessibilityIdentifier("runShoot.keepScanShot")
                    Button("Skip item") { next() }
                        .font(Typography.emphasis)
                        .frame(minHeight: Layout.minimumTapTarget)
                        .accessibilityIdentifier("runShoot.skip")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(Palette.onMedia)
        .padding(Spacing.sm)
        .background(
            Palette.scrim.color.opacity(0.55),
            in: RoundedRectangle(cornerRadius: Radius.large, style: .continuous),
        )
        .accessibilityElement(children: .contain)
    }

    /// Done saves the item's photos and moves on; closing the camera ends the shoot, keeping the
    /// items already shot.
    private func finish(_ draft: Draft, _ shots: [(PreparedPhoto, PhotoRole)]) async {
        guard !shots.isEmpty else {
            onClose()
            return
        }
        guard await model.saveShoot(shots, to: draft.id, keepingScanShots: keepsScanShot) else {
            // The alert says why, on the drafts list; the item still needs its photos.
            onClose()
            return
        }
        next()
    }

    private func next() {
        keepsScanShot = false
        guard let draft = currentDraft, let position = draftIDs.firstIndex(of: draft.id) else {
            onClose()
            return
        }
        index = position + 1
        if currentDraft == nil {
            onClose()
        }
    }
}
