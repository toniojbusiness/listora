import DesignSystem
import SwiftUI

/// The read card's actions (docs/features/thrift-scan.md, "On the iPhone"): the shot's tag
/// close-up and the marketplace's search on a small line, then the seller's two answers, big and
/// side by side at the bottom of the card, closest to the thumb: **Put back** and **Keep**. Either
/// one closes the card at once, back to the live camera for the next item. A card opened again
/// from the tray once its item was kept says so, with **Close**.
struct ScanCardActions: View {
    let entry: ScanEntry
    let card: ScanCard
    let onKeep: () -> Void
    let onPutBack: () -> Void
    let onClose: () -> Void
    let onTag: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            if isDeciding {
                tools
            }
            if case let .keepFailed(message) = entry.decision {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.danger)
                    .accessibilityIdentifier("scan.keepFailed")
            }
            answers
        }
        .padding(.top, Spacing.xxs)
    }

    private var isDeciding: Bool {
        switch entry.decision {
        case .open, .keepFailed: true
        case .keeping, .kept: false
        }
    }

    /// The tag close-up and the marketplace's search: help with the decision, not the decision.
    private var tools: some View {
        HStack(spacing: Spacing.xs) {
            Button(action: onTag) {
                Label(card.wantsTag ? "Shoot the tag?" : "Shoot the tag", systemImage: "tag")
            }
            .font(Typography.footnote)
            .buttonStyle(.plain)
            .foregroundStyle(card.wantsTag ? Palette.brand : Palette.textSecondary)
            .frame(minHeight: Layout.minimumTapTarget)
            .accessibilityHint("The next shot is a close-up of this item's tag, read with it.")
            .accessibilityIdentifier("scan.tag")
            Spacer(minLength: 0)
            if let link = card.links.first {
                Button {
                    openURL(link.url)
                } label: {
                    Label(link.label, systemImage: "arrow.up.right.square")
                        .labelStyle(.titleAndIcon)
                }
                .font(Typography.footnote)
                .buttonStyle(.plain)
                .foregroundStyle(Palette.brand)
                .frame(minHeight: Layout.minimumTapTarget)
                .accessibilityHint("Opens the marketplace's search to look at prices yourself.")
                .accessibilityIdentifier("scan.search")
            }
        }
    }

    @ViewBuilder
    private var answers: some View {
        switch entry.decision {
        case .open, .keepFailed:
            HStack(spacing: Spacing.xs) {
                Button(action: onPutBack) {
                    Label("Put back", systemImage: "arrow.uturn.backward")
                }
                .buttonStyle(.listora(.secondary, size: .large))
                .accessibilityHint("Passes on this item and goes back to the camera.")
                .accessibilityIdentifier("scan.putBack")
                Button(action: onKeep) {
                    Label("Keep", systemImage: "plus")
                }
                .buttonStyle(.listora(.primary, size: .large))
                .accessibilityHint("Saves it as a draft and goes back to the camera.")
                .accessibilityIdentifier("scan.keep")
            }
        case .keeping, .kept:
            HStack(spacing: Spacing.xs) {
                Group {
                    if entry.isKept {
                        Label("Kept as a draft", systemImage: "checkmark")
                            .foregroundStyle(Palette.success)
                    } else {
                        Label("Keeping", systemImage: "arrow.down.circle")
                            .foregroundStyle(Palette.textSecondary)
                    }
                }
                .font(Typography.emphasis)
                .frame(maxWidth: .infinity, minHeight: Layout.buttonHeight, alignment: .leading)
                .accessibilityIdentifier(entry.isKept ? "scan.kept" : "scan.keeping")
                Button("Close", action: onClose)
                    .buttonStyle(.listora(.secondary, size: .large))
                    .accessibilityHint("Goes back to the camera.")
                    .accessibilityIdentifier("scan.close")
            }
        }
    }
}

/// Put back on a card that is still reading or could not be read: the seller can pass on the
/// item without waiting.
struct ScanPutBackButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label("Put back", systemImage: "arrow.uturn.backward")
        }
        .buttonStyle(.listora(.secondary, size: .compact))
        .fixedSize()
        .accessibilityHint("Passes on this item and goes back to the camera.")
        .accessibilityIdentifier("scan.putBack")
    }
}
