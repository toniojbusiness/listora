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
            }
        }
        .frame(maxWidth: Layout.readableWidth, alignment: .leading)
        .tagStyle(padding: Spacing.sm)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("scan.card")
    }

    private var reading: some View {
        HStack(spacing: Spacing.sm) {
            BrandSpinner()
            VStack(alignment: .leading, spacing: 2) {
                Text("Reading item \(entry.number)").font(Typography.headline)
                Text("Shoot the next one any time.")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
            }
        }
        .padding(.leading, Spacing.md)
        .accessibilityElement(children: .combine)
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
            actions(card)
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
        ForEach(card.comparisons, id: \.marketplace) { comparison in
            ComparisonLine(comparison: comparison)
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
        ForEach(card.listedSignals, id: \.label) { signal in
            Text("\(Text(signal.label).font(Typography.smallEmphasis)) · \(signal.shortBasedOn)")
                .font(Typography.caption)
                .foregroundStyle(Palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("\(signal.label), \(signal.basedOn)")
                .accessibilityIdentifier("scan.signal")
        }
    }

    private func actions(_ card: ScanCard) -> some View {
        HStack(spacing: Spacing.xs) {
            keepButton
            if entry.decision == .open {
                Button(action: onTag) {
                    Label(card.wantsTag ? "Tag?" : "Tag", systemImage: "tag")
                }
                .buttonStyle(.listora(card.wantsTag ? .secondary : .tertiary, size: .compact))
                .accessibilityLabel("Shoot the tag")
                .accessibilityIdentifier("scan.tag")
            }
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
        }
    }
}

/// One marketplace's comparisons on the card: what close matches sold for (eBay) or ask there,
/// always under their label, and the demand; or why there are none, in words.
private struct ComparisonLine: View {
    let comparison: ScanComparisonLine

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: Spacing.xxs) {
                if comparison.status == .checking {
                    BrandSpinner().controlSize(.mini)
                }
                Text(comparison.label)
                    .font(Typography.footnote)
                    .foregroundStyle(comparison.status == .read ? Palette.textPrimary : Palette.textSecondary)
            }
            // The label of the numbers the row shows: sold listings where it has them, else asking.
            if let source = comparison.soldLabel ?? comparison.askingLabel {
                Text(source).font(Typography.caption).foregroundStyle(Palette.textSecondary)
            }
            if let demand = comparison.demand {
                Text("\(Text(demand).font(Typography.smallEmphasis)) · \(comparison.demandBasedOn ?? "")")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("scan.comparison.\(comparison.marketplace.lowercased())")
    }
}

/// The run's tray: every card of the run along the bottom, newest last, so a skipped item can
/// still be opened and kept until the run ends.
struct ScanTray: View {
    let entries: [ScanEntry]
    let currentID: String?
    let onSelect: (String) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: Spacing.xs) {
                    ForEach(entries) { entry in
                        Button {
                            onSelect(entry.id)
                        } label: {
                            ScanTrayTile(entry: entry, isCurrent: entry.id == currentID)
                        }
                        .buttonStyle(.plain)
                        .id(entry.id)
                        .accessibilityLabel(Self.label(entry))
                        .accessibilityIdentifier("scan.tray.\(entry.number)")
                    }
                }
                .padding(.horizontal, Spacing.md)
            }
            .frame(height: 64)
            .onChange(of: entries.count) {
                if let last = entries.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .trailing) }
                }
            }
        }
    }

    static func label(_ entry: ScanEntry) -> String {
        let state = switch entry.state {
        case .reading: "reading"
        case let .read(card): card.callLabel
        case .failed: "couldn't read"
        }
        return "Item \(entry.number), \(state)\(entry.isKept ? ", kept" : "")"
    }
}

private struct ScanTrayTile: View {
    let entry: ScanEntry
    let isCurrent: Bool

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let image = UIImage(data: entry.itemJPEG) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 52, height: 52)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                    .opacity(entry.isKept || isCurrent ? 1 : 0.7)
            }
            badge.padding(2)
        }
        .frame(width: 56, height: 56)
        .overlay {
            RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
                .strokeBorder(isCurrent ? Palette.onMedia.color : .clear, lineWidth: 2)
        }
    }

    @ViewBuilder
    private var badge: some View {
        if entry.isKept {
            Image(systemName: "checkmark.circle.fill")
                .font(Typography.caption)
                .foregroundStyle(Palette.success)
                .background(Palette.surface, in: Circle())
        } else if let card = entry.card {
            Text(card.callLabel)
                .font(Typography.stamp)
                .textCase(.uppercase)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .padding(.horizontal, 3)
                .foregroundStyle(card.tone.color)
                .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.tight))
        } else if case .failed = entry.state {
            Image(systemName: "exclamationmark.circle.fill")
                .font(Typography.caption)
                .foregroundStyle(Palette.danger)
                .background(Palette.surface, in: Circle())
        }
    }
}
