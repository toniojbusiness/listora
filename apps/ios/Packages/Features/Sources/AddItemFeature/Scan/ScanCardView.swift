import DesignSystem
import SwiftUI
import UIKit

/// The scan's card over the bottom of the live camera (Hang Tag), easy to follow at a glance like
/// a friend's answer at the bins: the verdict stamped big (Grab, Maybe, Leave) with its one-line
/// why, what the item is, the three prices, and a short reality check of what they rest on.
/// While the prices wait for what they rest on, what the item is and a quiet "Checking prices"
/// line. Its answers are Keep and Put back (`ScanCardActions`), there the whole time; shooting
/// the next item puts this one back too.
struct ScanCardView: View {
    let entry: ScanEntry
    let onKeep: () -> Void
    let onPutBack: () -> Void
    let onClose: () -> Void
    let onTag: () -> Void
    let onRetry: () -> Void
    var onRetryPrices: () -> Void = {}

    var body: some View {
        Group {
            switch entry.state {
            case .reading:
                reading
            case let .read(card):
                read(card)
            case let .failed(message, retryable):
                ScanReadFailed(
                    number: entry.number,
                    message: message,
                    retryable: retryable,
                    onRetry: onRetry,
                    onPutBack: onPutBack,
                )
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
                .accessibilityElement(children: .combine)
                Spacer(minLength: Spacing.xs)
                ScanPutBackButton(action: onPutBack)
            }
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
            ScanCardActions(
                entry: entry,
                wantsTag: entry.instant == nil,
                link: nil,
                onKeep: onKeep,
                onPutBack: onPutBack,
                onClose: onClose,
                onTag: onTag,
            )
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

    private func read(_ card: ScanCard) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            if card.pricesPending {
                checkingHeader(card)
            } else {
                verdict(card)
            }
            identity(card)
            if !card.pricesPending {
                prices(card)
                realityCheck(card)
            }
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
            ScanCardActions(
                entry: entry,
                wantsTag: card.wantsTag,
                link: card.links.first,
                onKeep: onKeep,
                onPutBack: onPutBack,
                onClose: onClose,
                onTag: onTag,
            )
        }
        .padding(.leading, Spacing.md)
    }

    /// The verdict, stamped big in its color, "Your call" under a Maybe, and its one-line why.
    private func verdict(_ card: ScanCard) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            HStack(alignment: .center, spacing: Spacing.xs) {
                ScanVerdictStamp(text: card.callLabel, tone: card.tone)
                    .accessibilityIdentifier("scan.call")
                if let note = card.verdictNote {
                    Text(note)
                        .font(Typography.smallEmphasis)
                        .foregroundStyle(Palette.textSecondary)
                        .accessibilityIdentifier("scan.verdictNote")
                }
                Spacer(minLength: 0)
                Text("Item \(entry.number)").font(Typography.metadata).foregroundStyle(Palette.textSecondary)
            }
            if let why = card.why {
                Text(why)
                    .font(Typography.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("scan.why")
            }
        }
    }

    /// While the prices wait: one quiet line of what is being checked, never a spinner wall.
    private func checkingHeader(_ card: ScanCard) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
            if entry.research == .failed {
                Label("Couldn't get the prices", systemImage: "exclamationmark.triangle")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.warning)
                    .accessibilityIdentifier("scan.pricesFailed")
                Button("Retry", action: onRetryPrices)
                    .buttonStyle(.listora(.secondary, size: .compact))
                    .accessibilityIdentifier("scan.retryPrices")
            } else {
                BrandSpinner().controlSize(.mini)
                Text(card.pricingLabel ?? "Checking prices")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityIdentifier("scan.checkingPrices")
            }
            Spacer(minLength: 0)
            Text("Item \(entry.number)").font(Typography.metadata).foregroundStyle(Palette.textSecondary)
        }
    }

    /// What the item is: the brand and item, its size, material, era, and condition, and how
    /// sure the read is.
    @ViewBuilder
    private func identity(_ card: ScanCard) -> some View {
        Text(card.title)
            .font(Typography.headline)
            .lineLimit(2)
            .accessibilityIdentifier("scan.title")
        if let subtitle = card.subtitle {
            Text(subtitle).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
        }
        if card.pricesPending {
            Text(card.readConfidence)
                .font(Typography.caption)
                .foregroundStyle(Palette.textSecondary)
                .accessibilityIdentifier("scan.readConfidence")
        }
    }

    /// The three prices, or the range from a server without them, then the call's confidence
    /// and what it rests on.
    @ViewBuilder
    private func prices(_ card: ScanCard) -> some View {
        if let prices = card.prices {
            ScanThreePrices(prices: prices)
        } else if let range = card.range {
            Text(range).font(Typography.price).accessibilityIdentifier("scan.range")
        }
        Text("\(card.confidence) · \(card.basedOn)")
            .font(Typography.caption)
            .foregroundStyle(Palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("scan.basedOn")
    }

    /// What the prices rest on, a short line each, from the server's verified data; from a
    /// server without the reality check, the call's signals instead.
    @ViewBuilder
    private func realityCheck(_ card: ScanCard) -> some View {
        if card.realityCheck.isEmpty {
            ForEach(card.listedSignals, id: \.label) { signal in
                Text("\(Text(signal.label).font(Typography.smallEmphasis)) · \(signal.shortBasedOn)")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("\(signal.label), \(signal.basedOn)")
                    .accessibilityIdentifier("scan.signal")
            }
        } else {
            VStack(alignment: .leading, spacing: 2) {
                Text("Reality check")
                    .font(Typography.eyebrow)
                    .textCase(.uppercase)
                    .foregroundStyle(Palette.textSecondary)
                ForEach(Array(card.realityCheck.enumerated()), id: \.offset) { _, line in
                    ScanRealityRow(line: line)
                }
            }
            .padding(.top, Spacing.xxs)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("scan.reality")
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

/// A read that failed, with why and, when it may pass, Retry.
private struct ScanReadFailed: View {
    let number: Int
    let message: String
    let retryable: Bool
    let onRetry: () -> Void
    let onPutBack: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Label("Couldn't read item \(number)", systemImage: "exclamationmark.triangle.fill")
                .font(Typography.headline)
                .foregroundStyle(Palette.danger)
            Text(message).font(Typography.footnote).foregroundStyle(Palette.textSecondary)
            HStack(spacing: Spacing.xs) {
                if retryable {
                    Button("Retry", action: onRetry)
                        .buttonStyle(.listora(.primary, size: .compact))
                        .accessibilityIdentifier("scan.retry")
                }
                ScanPutBackButton(action: onPutBack)
            }
        }
        .padding(.leading, Spacing.md)
    }
}
