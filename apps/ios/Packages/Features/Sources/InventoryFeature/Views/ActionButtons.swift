import Core
import DesignSystem
import ListoraAPI
import SwiftUI

/// The card's actions: the first is the primary one (List, or Retry after a failure), the rest
/// are compact buttons beside each other, or stacked when they do not fit.
struct ActionButtons: View {
    let row: MarketplaceRowState
    let listIsSecondary: Bool
    let isBusy: Bool
    let isEnabled: Bool
    let isTesting: (MarketplaceRowState.Action) -> Bool
    let perform: (MarketplaceRowState.Action) -> Void
    let end: (EndReason) -> Void
    @State private var isConfirmingEnd = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            if let primary = row.actions.first {
                if primary == .list, listIsSecondary {
                    button(primary)
                        .buttonStyle(.listora(.secondary, size: .compact))
                        .loading(isBusy)
                } else {
                    button(primary)
                        .buttonStyle(.listoraPrimary)
                        .loading(isBusy)
                }
            }
            let others = Array(row.actions.dropFirst())
            if !others.isEmpty {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: Spacing.xs) { secondary(others) }
                    VStack(spacing: Spacing.xs) { secondary(others) }
                }
            }
        }
        .padding(.top, Spacing.xxs)
    }

    /// The other actions, one slot each, never a ForEach: ViewThatFits builds the rows it measures
    /// while it measures them, which SwiftUI does on its own render thread when the main thread is
    /// busy during an animation, and a ForEach there runs its main-actor content off the main
    /// thread, which stops the app (CI crash reports, October 2026). A row has at most eight other
    /// actions, one of each kind after the first.
    @ViewBuilder
    private func secondary(_ actions: [MarketplaceRowState.Action]) -> some View {
        slot(0, of: actions)
        slot(1, of: actions)
        slot(2, of: actions)
        slot(3, of: actions)
        slot(4, of: actions)
        slot(5, of: actions)
        slot(6, of: actions)
        slot(7, of: actions)
    }

    @ViewBuilder
    private func slot(_ index: Int, of actions: [MarketplaceRowState.Action]) -> some View {
        if actions.indices.contains(index) {
            let action = actions[index]
            button(action)
                .buttonStyle(.listora(action == .end ? .destructive : .secondary, size: .compact))
            if isTesting(action) {
                TestingTag()
            }
        }
    }

    @ViewBuilder
    private func button(_ action: MarketplaceRowState.Action) -> some View {
        if action == .end {
            // The confirmation hangs off the End button itself, so it opens where it was tapped.
            Button(action.title, systemImage: action.systemImage) { isConfirmingEnd = true }
                .disabled(!isEnabled)
                .accessibilityIdentifier("marketplace.\(row.id).action.\(action.identifier)")
                .confirmationDialog(
                    "End the \(row.name) listing?",
                    isPresented: $isConfirmingEnd,
                    titleVisibility: .visible,
                ) {
                    ForEach(EndReason.allCases) { reason in
                        Button(reason.title, role: .destructive) { end(reason) }
                            .accessibilityIdentifier("end.\(reason.rawValue)")
                    }
                    Button("Keep it listed", role: .cancel) {}
                } message: {
                    if row.listing?.mode.value1 == .api || row.listing?.mode.value1 == .automation {
                        Text("Listora ends it on \(row.name) and shows it as delisted once \(row.name) confirms.")
                    } else {
                        Text("You end it in the \(row.name) app: Listora adds a task with a link to the listing.")
                    }
                }
        } else {
            Button(action.title, systemImage: action.systemImage) { perform(action) }
                .disabled(!isEnabled)
                .accessibilityIdentifier("marketplace.\(row.id).action.\(action.identifier)")
        }
    }
}
