import DesignSystem
import SwiftUI
import UIKit

/// The scan's card over the bottom of the live camera (Hang Tag): a tag lying on its side with
/// the call stamped on it, what the item is, the price range in the tag's print, what the call
/// rests on, the household's own sales, and the AI estimate under its label. Keep is the one
/// action; shooting the next item skips this one.
struct ScanCardView: View {
    let entry: ScanEntry
    let onKeep: () -> Void
    let onTag: () -> Void
    let onRetry: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        Group {
            switch entry.state {
            case .reading:
                reading
            case let .read(card):
                read(card)
            case let .failed(message, retryable):
                failed(message, retryable: retryable)
            case .waiting:
                waiting
            }
        }
        .frame(maxWidth: Layout.readableWidth, alignment: .leading)
        .tagStyle(padding: Spacing.sm)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("scan.card")
    }

    private var reading: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(spacing: Spacing.sm) {
                BrandSpinner()
                VStack(alignment: .leading, spacing: 2) {
                    Text("Reading item \(entry.number)").font(Typography.headline)
                    Text("Shoot the next one any time.")
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                }
            }
            .accessibilityElement(children: .combine)
            // The instant read from the household's own sales, while the full read runs.
            if let instant = entry.instant.map(OfflineScanCard.init) {
                Text("\(instant.label): \(instant.callLabel) · \(instant.range ?? instant.basedOn)")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityIdentifier("scan.instant")
            }
            warnings
        }
        .padding(.leading, Spacing.md)
    }

    /// No signal: the instant read from the household's own sales, while the read waits.
    private var waiting: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            if let instant = entry.instant.map(OfflineScanCard.init) {
                ScanInstantRead(instant: instant, number: entry.number)
            } else {
                Text("Item \(entry.number)").font(Typography.headline)
                Text("No brand you've sold is on the tag.")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
            }
            warnings
            Label("No signal: read when you have it", systemImage: "wifi.slash")
                .font(Typography.caption)
                .foregroundStyle(Palette.textSecondary)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("No signal: read when you have it")
                .accessibilityIdentifier("scan.waiting")
            actions(wantsTag: entry.instant == nil)
        }
        .padding(.leading, Spacing.md)
    }

    /// The run's earlier item it looks like.
    @ViewBuilder
    private var warnings: some View {
        if let earlier = entry.duplicateOf {
            ScanDuplicateWarning(earlier: earlier)
        }
    }

    private func failed(_ message: String, retryable: Bool) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Label("Couldn't read item \(entry.number)", systemImage: "exclamationmark.triangle.fill")
                .font(Typography.headline)
                .foregroundStyle(Palette.danger)
            Text(message).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
            if retryable {
                Button("Retry", action: onRetry)
                    .buttonStyle(.listora(.secondary, size: .compact))
                    .accessibilityIdentifier("scan.retry")
            }
        }
        .padding(.leading, Spacing.md)
    }

    private func read(_ card: ScanCard) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                Stamp(card.callLabel, tone: card.tone, angle: .degrees(-3))
                    .accessibilityIdentifier("scan.call")
                Text(card.confidence)
                    .font(Typography.smallEmphasis)
                    .foregroundStyle(Palette.textSecondary)
                Spacer(minLength: 0)
                Text("Item \(entry.number)").font(Typography.metadata).foregroundStyle(Palette.textSecondary)
            }
            Text(card.title)
                .font(Typography.headline)
                .lineLimit(2)
                .accessibilityIdentifier("scan.title")
            if let subtitle = card.subtitle {
                Text(subtitle).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
            }
            priceLines(card)
            signalLines(card)
            if !card.flags.isEmpty {
                Label(card.flags.joined(separator: " · "), systemImage: "exclamationmark.triangle")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.warning)
            }
            warnings
            if entry.readLate {
                Label("Read when you had signal", systemImage: "clock.arrow.circlepath")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Read when you had signal")
                    .accessibilityIdentifier("scan.readLate")
            }
            actions(wantsTag: card.wantsTag, link: card.links.first)
        }
        .padding(.leading, Spacing.md)
    }

    @ViewBuilder
    private func priceLines(_ card: ScanCard) -> some View {
        if let range = card.range {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                Text(range).font(Typography.price).accessibilityIdentifier("scan.range")
                Text(card.basedOn).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
            }
        } else {
            Text(card.basedOn).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
        }
        if let payout = card.payout {
            Text(payout).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
        }
        ForEach(card.ownSales, id: \.marketplace) { line in
            Text("Your sales on \(line.marketplace): \(line.summary)")
                .font(Typography.footnote)
                .accessibilityLabel(line.label + ", " + line.summary)
        }
        // Shown under its label whenever it is there, even when own sales lead the call.
        if let estimate = card.aiEstimate, let label = card.aiEstimateLabel, card.range != estimate {
            Text("\(estimate) · \(label)")
                .font(Typography.caption)
                .foregroundStyle(Palette.textSecondary)
                .accessibilityIdentifier("scan.aiEstimate")
        }
    }

    /// The web research, under its label once, then the call's other signals. A signal that
    /// rests on web info names only its site here: the label above already says what it is.
    @ViewBuilder
    private func signalLines(_ card: ScanCard) -> some View {
        switch entry.research {
        case .checking:
            HStack(spacing: Spacing.xxs) {
                BrandSpinner().controlSize(.mini)
                Text("Checking the web for its retail price").font(Typography.caption)
            }
            .foregroundStyle(Palette.textSecondary)
            .accessibilityIdentifier("scan.checkingWeb")
        case .done:
            if let web = card.web, web.found {
                VStack(alignment: .leading, spacing: 2) {
                    Text(web.label).font(Typography.eyebrow).textCase(.uppercase)
                    if let resale = web.resale {
                        Text(resale).font(Typography.caption)
                    }
                    if let models = web.models {
                        Text(models).font(Typography.caption)
                    }
                    if let summary = web.summary {
                        Text(summary).font(Typography.caption).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .foregroundStyle(Palette.textSecondary)
                .padding(.top, Spacing.xxs)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("scan.webInfo")
            }
        case .none, .failed:
            EmptyView()
        }
        ForEach(card.signals, id: \.label) { signal in
            Text("\(Text(signal.label).font(Typography.smallEmphasis)) · \(signal.shortBasedOn)")
                .font(Typography.caption)
                .foregroundStyle(Palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("\(signal.label), \(signal.basedOn)")
                .accessibilityIdentifier("scan.signal")
        }
    }

    private func actions(wantsTag: Bool, link: ScanCard.Link? = nil) -> some View {
        HStack(spacing: Spacing.xs) {
            keepButton
            if entry.decision == .open {
                Button(action: onTag) {
                    Label(wantsTag ? "Tag?" : "Tag", systemImage: "tag")
                }
                .buttonStyle(.listora(wantsTag ? .secondary : .tertiary, size: .compact))
                .accessibilityLabel("Shoot the tag")
                .accessibilityIdentifier("scan.tag")
            }
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
        .padding(.top, Spacing.xxs)
    }

    @ViewBuilder
    private var keepButton: some View {
        switch entry.decision {
        case .open, .keepFailed:
            Button(action: onKeep) {
                Label("Keep", systemImage: "plus")
            }
            .buttonStyle(.listora(.primary, size: .compact))
            .accessibilityIdentifier("scan.keep")
        case .keeping:
            Button("Keep", action: {})
                .buttonStyle(.listora(.primary, size: .compact))
                .loading(true)
                .disabled(true)
        case .kept:
            Label("Kept as a draft", systemImage: "checkmark")
                .font(Typography.emphasis)
                .foregroundStyle(Palette.success)
                .frame(minHeight: Layout.compactButtonHeight)
                .accessibilityIdentifier("scan.kept")
        case .keepWhenRead:
            Label("Kept: saved once it's read", systemImage: "checkmark")
                .font(Typography.emphasis)
                .foregroundStyle(Palette.success)
                .frame(minHeight: Layout.compactButtonHeight)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Kept: saved once it's read")
                .accessibilityIdentifier("scan.keptWaiting")
        }
    }
}

/// The instant read on a card waiting for signal: the call from the household's own sales of the
/// brand on the tag, under its label.
private struct ScanInstantRead: View {
    let instant: OfflineScanCard
    let number: Int

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
            Stamp(instant.callLabel, tone: instant.tone, angle: .degrees(-3))
                .accessibilityIdentifier("scan.call")
            Text(instant.confidence)
                .font(Typography.smallEmphasis)
                .foregroundStyle(Palette.textSecondary)
            Spacer(minLength: 0)
            Text("Item \(number)").font(Typography.metadata).foregroundStyle(Palette.textSecondary)
        }
        Text(instant.label)
            .font(Typography.eyebrow)
            .textCase(.uppercase)
            .foregroundStyle(Palette.textSecondary)
            .accessibilityIdentifier("scan.offlineLabel")
        Text(instant.brand).font(Typography.headline).accessibilityIdentifier("scan.title")
        if let range = instant.range {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                Text(range).font(Typography.price).accessibilityIdentifier("scan.range")
                Text(instant.basedOn).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
            }
        } else {
            Text(instant.basedOn).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
        }
        if let payout = instant.payout {
            Text(payout).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
        }
        if let unsold = instant.unsold {
            Label(unsold, systemImage: "shippingbox")
                .font(Typography.footnote)
                .foregroundStyle(Palette.warning)
                .accessibilityIdentifier("scan.unsold")
        }
    }
}

/// "Looks like item 3, already scanned": the shot's feature print is close to an earlier one's.
private struct ScanDuplicateWarning: View {
    let earlier: Int

    var body: some View {
        Label("Looks like item \(earlier), already scanned", systemImage: "square.on.square")
            .font(Typography.footnote)
            .foregroundStyle(Palette.warning)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Looks like item \(earlier), already scanned")
            .accessibilityIdentifier("scan.duplicate")
    }
}
