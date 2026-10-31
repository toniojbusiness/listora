import Core
import DesignSystem
import SwiftUI

/// Where the saved items go (docs/features/storage-bins.md): "Put in a bin", which scans the
/// bin's sticker or picks one, then "In bin B-12" with Change. Shows nothing without a picker.
struct BinPutAwayView: View {
    let itemIDs: [String]
    @State private var bin: BinChoice?
    @State private var request: BinRequest?
    @Environment(\.binPicking) private var picking

    init(itemIDs: [String], bin: BinChoice?) {
        self.itemIDs = itemIDs
        _bin = State(initialValue: bin)
    }

    var body: some View {
        if let picking, !itemIDs.isEmpty {
            content
                .sheet(item: $request) { request in
                    picking.screen(request) { choice in
                        bin = choice
                        self.request = nil
                    }
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let bin {
            HStack(spacing: Spacing.sm) {
                Label(itemIDs.count == 1 ? "In bin \(bin.code)" : "All in bin \(bin.code)", systemImage: "archivebox.fill")
                    .font(Typography.emphasis)
                    .foregroundStyle(Palette.textPrimary)
                    .accessibilityIdentifier("putAway.bin")
                Spacer(minLength: Spacing.sm)
                Button("Change") { request = BinRequest(itemIDs: itemIDs, current: bin) }
                    .buttonStyle(.listora(.tertiary, size: .compact))
                    .accessibilityIdentifier("putAway.change")
            }
            .cardStyle(.flat)
        } else {
            Button(
                itemIDs.count == 1 ? "Put in a bin" : "Put all \(itemIDs.count) in a bin",
                systemImage: "archivebox",
            ) {
                request = BinRequest(itemIDs: itemIDs)
            }
            .buttonStyle(.listoraSecondary)
            .accessibilityIdentifier("putAway.choose")
        }
    }
}
