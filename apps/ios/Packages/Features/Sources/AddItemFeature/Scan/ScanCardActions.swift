import DesignSystem
import SwiftUI

/// The read card's actions (docs/features/thrift-scan.md, "On the iPhone"): the shot's tag
/// close-up and the marketplace's search on a small line, then the seller's two answers, big and
/// side by side at the bottom of the card, closest to the thumb: **Put back** and **Keep**. Either
/// one closes the card at once, back to the live camera for the next item. A card opened again
/// from the tray once its item was kept says so, with **Close**.
struct ScanCardActions: View {
    let entry: ScanEntry
    /// The read was unsure of the brand, or there is no read yet: the tag close-up helps most.
    let wantsTag: Bool
    /// The marketplace's own search, once the item is read.
    let link: ScanCard.Link?
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

    /// Once a tag close-up is read with the item, the button offers to take it again.
    private var tagLabel: String {
        if entry.tagJPEG != nil {
            return "Retake the tag"
        }
        return wantsTag ? "Shoot the tag?" : "Shoot the tag"
    }

    private var isDeciding: Bool {
        switch entry.decision {
        case .open, .keepFailed: true
        case .keeping, .kept, .keepWhenRead: false
        }
    }

    /// The tag close-up and the marketplace's search: help with the decision, not the decision.
    private var tools: some View {
        HStack(spacing: Spacing.xs) {
            Button(action: onTag) {
                Label(tagLabel, systemImage: entry.tagJPEG == nil ? "tag" : "tag.fill")
            }
            .font(Typography.footnote)
            .buttonStyle(.plain)
            .foregroundStyle(wantsTag ? Palette.brand : Palette.textSecondary)
            .frame(minHeight: Layout.minimumTapTarget)
            .accessibilityHint("The card steps aside for a close-up of this item's tag, then comes back read with it.")
            .accessibilityIdentifier("scan.tag")
            Spacer(minLength: 0)
            if let link {
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
            // Their icons go before their words do, at a large text size on a small iPhone.
            ViewThatFits(in: .horizontal) {
                decide(.titleAndIcon)
                decide(.titleOnly)
            }
        case .keeping, .kept, .keepWhenRead:
            HStack(spacing: Spacing.xs) {
                keptLabel
                    .font(Typography.emphasis)
                    .frame(maxWidth: .infinity, minHeight: Layout.buttonHeight, alignment: .leading)
                Button("Close", action: onClose)
                    .buttonStyle(.listora(.secondary, size: .large))
                    .accessibilityHint("Goes back to the camera.")
                    .accessibilityIdentifier("scan.close")
            }
        }
    }
}

extension ScanCardActions {
    private func decide(_ style: some LabelStyle) -> some View {
        HStack(spacing: Spacing.xs) {
            Button(action: onPutBack) {
                Label("Put back", systemImage: "arrow.uturn.backward").fixedSize()
            }
            .buttonStyle(.listora(.secondary, size: .large))
            .accessibilityHint("Passes on this item and goes back to the camera.")
            .accessibilityIdentifier("scan.putBack")
            Button(action: onKeep) {
                Label("Keep", systemImage: "plus").fixedSize()
            }
            .buttonStyle(.listora(.primary, size: .large))
            .accessibilityHint("Saves it as a draft and goes back to the camera.")
            .accessibilityIdentifier("scan.keep")
        }
        .labelStyle(style)
    }

    /// What a card opened again from the tray says once its item was kept.
    @ViewBuilder
    private var keptLabel: some View {
        switch entry.decision {
        case .kept:
            Label("Kept as a draft", systemImage: "checkmark")
                .foregroundStyle(Palette.success)
                .accessibilityIdentifier("scan.kept")
        case .keepWhenRead:
            Label("Kept: saved once it's read", systemImage: "checkmark")
                .foregroundStyle(Palette.success)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Kept: saved once it's read")
                .accessibilityIdentifier("scan.keptWaiting")
        case .open, .keeping, .keepFailed:
            Label("Keeping", systemImage: "arrow.down.circle")
                .foregroundStyle(Palette.textSecondary)
                .accessibilityIdentifier("scan.keeping")
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
