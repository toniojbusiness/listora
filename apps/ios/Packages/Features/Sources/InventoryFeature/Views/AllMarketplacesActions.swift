import DesignSystem
import SwiftUI

/// List everywhere, Relist all, and End all: the same change on every marketplace where it
/// applies, once two or more can take it. Each listing then shows how its own change goes.
struct AllMarketplacesActions: View {
    let rows: [MarketplaceRowState]
    let isBusy: Bool
    let isEnabled: Bool
    let relistAll: (([MarketplaceRowState]) -> Void)?
    let endAll: ((EndReason, [MarketplaceRowState]) -> Void)?
    var listEverywhere: (() -> Void)?
    @State private var isConfirmingEnd = false

    /// The marketplaces the item is not on yet and can be listed on from here.
    static func listableCount(_ rows: [MarketplaceRowState]) -> Int {
        rows.count(where: { $0.actions.contains(.list) })
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
        if let listEverywhere, listable >= 2 {
            Button("List everywhere (\(listable))", systemImage: "tag.fill", action: listEverywhere)
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
