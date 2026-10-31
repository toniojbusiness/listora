import DesignSystem
import SwiftUI
import UIKit

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
        case .waiting: entry.instant.map { "\(OfflineScanCard($0).callLabel), waiting for signal" }
            ?? "waiting for signal"
        }
        return "Item \(entry.number), \(state)\(entry.isKeptOrPending ? ", kept" : "")"
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
        if entry.isKeptOrPending {
            Image(systemName: "checkmark.circle.fill")
                .font(Typography.caption)
                .foregroundStyle(Palette.success)
                .background(Palette.surface, in: Circle())
        } else if entry.isWaiting {
            Image(systemName: "wifi.slash")
                .font(Typography.caption)
                .foregroundStyle(Palette.textSecondary)
                .padding(2)
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
