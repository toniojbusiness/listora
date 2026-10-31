import Core
import DesignSystem
import SwiftUI

/// A thrift run's kept drafts in the drafts list (docs/features/thrift-scan.md, "Upgrading
/// drafts"): Shoot this run to take the real photos item after item, and the rapid review of the
/// items whose photos are on the server, above the drafts, each marked "Needs photos" until its
/// real photos are taken.
struct KeptRunSection: View {
    let run: KeptScanRun
    let model: AddItemModel
    let canShoot: Bool
    let onShoot: () -> Void
    let onReview: (BatchReviewRequest) -> Void

    var body: some View {
        let transferring = model.activity.transferring
        let isSignedIn = model.activity.isSignedIn
        let review = run.reviewRequest(transferring: transferring, isSignedIn: isSignedIn)
        let needing = run.needingPhotos.count
        let uploading = run.drafts.count(where: { !$0.needsPhotos }) - (review?.items.count ?? 0)
        Section {
            // The run's next step first, so a run of 23 drafts never hides it under them.
            if needing > 0, canShoot {
                Button(action: onShoot) {
                    Label("Shoot this run", systemImage: "camera.fill")
                }
                .buttonStyle(.listoraPrimary)
                .accessibilityIdentifier("keptRun.shoot")
                .listRowSeparator(.hidden)
            }
            if let review {
                Button {
                    onReview(review)
                } label: {
                    Label(
                        review.items.count == 1 ? "Review 1 item" : "Review \(review.items.count) items",
                        systemImage: "sparkles",
                    )
                }
                .buttonStyle(.listoraSecondary)
                .accessibilityIdentifier("keptRun.review")
                .listRowSeparator(.hidden)
            }
            if uploading > 0 {
                Label(
                    uploading == 1
                        ? "1 item uploading its photos, then ready to review"
                        : "\(uploading) items uploading their photos, then ready to review",
                    systemImage: "arrow.up.circle",
                )
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
                .accessibilityIdentifier("keptRun.uploading")
                .listRowSeparator(.hidden)
            }
            ForEach(run.drafts) { draft in
                NavigationLink(value: AddItemRoute.draft(draft.id)) {
                    DraftRow(draft: draft, activity: model.activity, fileURL: model.store.fileURL(for:))
                }
                .accessibilityIdentifier("draft.row")
            }
            .onDelete { offsets in
                for index in offsets {
                    model.deleteDraft(run.drafts[index].id)
                }
            }
        } header: {
            SectionHeader("Kept at the store", subtitle: Self.subtitle(kept: run.drafts.count, needing: needing))
                .padding(.bottom, Spacing.xxs)
                .accessibilityIdentifier("keptRun.header")
        }
        .listRowBackground(Palette.surface.color)
        .listSectionSeparatorTint(Palette.separator.color)
    }

    /// "5 kept · 4 need photos", or "3 kept, all with photos".
    nonisolated static func subtitle(kept: Int, needing: Int) -> String {
        let keptText = "\(kept) kept"
        switch needing {
        case 0: return "\(keptText), all with photos"
        case 1: return "\(keptText) · 1 needs photos"
        default: return "\(keptText) · \(needing) need photos"
        }
    }
}
