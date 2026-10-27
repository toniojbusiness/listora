import DesignSystem
import SwiftUI

/// List everywhere, Relist all, and End all: the same change on every marketplace where it
/// applies, once two or more can take it. An item already live somewhere (an imported listing)
/// gets "List on the others" for even one marketplace it is not on yet. Each listing then shows
/// how its own change goes.
struct AllMarketplacesActions: View {
    let rows: [MarketplaceRowState]
    let isBusy: Bool
    let isEnabled: Bool
    let relistAll: (([MarketplaceRowState]) -> Void)?
    let endAll: ((EndReason, [MarketplaceRowState]) -> Void)?
    var listEverywhere: (() -> Void)?
    @State private var isConfirmingEnd = false

    /// The marketplaces the item is not on yet and can be listed on from here.
    nonisolated static func listableCount(_ rows: [MarketplaceRowState]) -> Int {
        rows.count(where: { $0.actions.contains(.list) })
    }

    /// Whether the one-tap List shows: two or more marketplaces can take the item, or one can and
    /// the item is already live on another.
    nonisolated static func showsListAll(_ rows: [MarketplaceRowState]) -> Bool {
        let listable = listableCount(rows)
        return listable >= 2 || (listable >= 1 && rows.contains { $0.actions.contains(.end) })
    }

    /// "List on the others" once the item is live somewhere, else "List everywhere".
    nonisolated static func listTitle(listable: Int, listedSomewhere: Bool) -> String {
        listedSomewhere ? "List on the others (\(listable))" : "List everywhere (\(listable))"
    }

    private var relistable: [MarketplaceRowState] {
        rows.filter { $0.actions.contains(.relist) }
    }

    private var endable: [MarketplaceRowState] {
        rows.filter { $0.actions.contains(.end) }
    }

    var body: some View {
        let relistable = relistable
        let endable = endable
        let showsRelist = relistAll != nil && relistable.count >= 2
        let showsEnd = endAll != nil && endable.count >= 2
        let listable = Self.listableCount(rows)
        let listedSomewhere = !endable.isEmpty
        if let listEverywhere, Self.showsListAll(rows) {
            Button(
                Self.listTitle(listable: listable, listedSomewhere: listedSomewhere),
                systemImage: "tag.fill",
                action: listEverywhere,
            )
            .buttonStyle(.listoraPrimary)
            .disabled(!isEnabled)
            .accessibilityIdentifier("marketplaces.listEverywhere")
        }
        if showsRelist || showsEnd {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Spacing.xs) { buttons(showsRelist, relistable, showsEnd, endable) }
                VStack(spacing: Spacing.xs) { buttons(showsRelist, relistable, showsEnd, endable) }
            }
        }
    }

    @ViewBuilder
    private func buttons(
        _ showsRelist: Bool,
        _ relistable: [MarketplaceRowState],
        _ showsEnd: Bool,
        _ endable: [MarketplaceRowState],
    ) -> some View {
        if showsRelist, let relistAll {
            Button("Relist all (\(relistable.count))", systemImage: "arrow.counterclockwise") {
                relistAll(relistable)
            }
            .buttonStyle(.listora(.secondary, size: .compact))
            .loading(isBusy)
            .disabled(!isEnabled)
            .accessibilityIdentifier("marketplaces.relistAll")
        }
        if showsEnd, let endAll {
            Button("End all (\(endable.count))", systemImage: "xmark.circle") { isConfirmingEnd = true }
                .buttonStyle(.listora(.destructive, size: .compact))
                .disabled(!isEnabled)
                .accessibilityIdentifier("marketplaces.endAll")
                .confirmationDialog(
                    "End the listing on \(endable.map(\.name).joined(separator: ", "))?",
                    isPresented: $isConfirmingEnd,
                    titleVisibility: .visible,
                ) {
                    ForEach(EndReason.allCases) { reason in
                        Button(reason.title, role: .destructive) { endAll(reason, endable) }
                            .accessibilityIdentifier("endAll.\(reason.rawValue)")
                    }
                    Button("Keep them listed", role: .cancel) {}
                } message: {
                    Text("Listora ends each one and shows it as delisted once that marketplace confirms.")
                }
        }
    }
}
