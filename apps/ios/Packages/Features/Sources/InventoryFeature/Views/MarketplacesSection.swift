import DesignSystem
import ListoraAPI
import SwiftUI

/// One row per marketplace: the listing's status as the server words it, how Listora works
/// with the marketplace, the actions allowed now, and the listing's history.
struct MarketplacesSection: View {
    let rows: [MarketplaceRowState]
    let histories: [String: [Operation]]
    let events: [String: [OperationEvent]]
    let busyMarketplace: String?
    let perform: (MarketplaceRowState.Action, MarketplaceRowState) -> Void
    let loadEvents: (String) async -> Void

    var body: some View {
        SectionCard(title: "Marketplaces") {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                if index > 0 {
                    Divider().overlay(Palette.separator.color)
                }
                MarketplaceRowView(
                    row: row,
                    history: row.listing.flatMap { histories[$0.id] } ?? [],
                    events: events,
                    isBusy: busyMarketplace == row.id,
                    isEnabled: busyMarketplace == nil,
                    perform: { action in perform(action, row) },
                    loadEvents: loadEvents,
                )
            }
        }
    }
}

private struct MarketplaceRowView: View {
    let row: MarketplaceRowState
    let history: [Operation]
    let events: [String: [OperationEvent]]
    let isBusy: Bool
    let isEnabled: Bool
    let perform: (MarketplaceRowState.Action) -> Void
    let loadEvents: (String) async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.name)
                        .font(Typography.headline)
                        .foregroundStyle(Palette.textPrimary)
                    Text(row.modeLabel)
                        .font(Typography.caption)
                        .foregroundStyle(Palette.textSecondary)
                }
                Spacer(minLength: Spacing.xs)
                if let price = row.priceLabel {
                    Text(price)
                        .font(Typography.callout.weight(.semibold).monospacedDigit())
                        .foregroundStyle(Palette.textPrimary)
                        .accessibilityLabel("Listed at \(price)")
                        .accessibilityIdentifier("marketplace.\(row.id).price")
                }
            }
            HStack(spacing: Spacing.xs) {
                StatusLabel(row.statusLabel, tone: StatusLabel.Tone(row.tone))
                    .accessibilityIdentifier("marketplace.\(row.id).status")
                if row.isWorking || isBusy {
                    ProgressView().controlSize(.small)
                }
            }
            if let detail = row.statusDetail {
                Text(detail)
                    .font(Typography.callout)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("marketplace.\(row.id).detail")
            }
            if !row.actions.isEmpty {
                ActionButtons(row: row, isEnabled: isEnabled && !isBusy, perform: perform)
            }
            if !history.isEmpty {
                HistoryView(marketplace: row.id, operations: history, events: events, loadEvents: loadEvents)
            }
        }
        .padding(.vertical, Spacing.xs)
        .accessibilityElement(children: .contain)
    }
}

/// The row's actions: the first is the primary one (List, or Retry after a failure), the rest
/// sit side by side below it when they fit.
private struct ActionButtons: View {
    let row: MarketplaceRowState
    let isEnabled: Bool
    let perform: (MarketplaceRowState.Action) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            if let primary = row.actions.first {
                button(primary).buttonStyle(.listoraPrimary)
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

    private func secondary(_ actions: [MarketplaceRowState.Action]) -> some View {
        ForEach(actions, id: \.self) { action in
            button(action).buttonStyle(.listoraSecondary)
        }
    }

    private func button(_ action: MarketplaceRowState.Action) -> some View {
        Button(action.title) { perform(action) }
            .disabled(!isEnabled)
            .accessibilityIdentifier("marketplace.\(row.id).action.\(action.identifier)")
    }
}

/// Every operation on the listing, newest first; opening one shows its steps.
private struct HistoryView: View {
    let marketplace: String
    let operations: [Operation]
    let events: [String: [OperationEvent]]
    let loadEvents: (String) async -> Void
    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                ForEach(operations, id: \.id) { operation in
                    OperationRow(operation: operation, events: events[operation.id], loadEvents: loadEvents)
                }
            }
            .padding(.top, Spacing.xs)
        } label: {
            Text("History (\(operations.count))")
                .font(Typography.callout.weight(.semibold))
                .foregroundStyle(Palette.textSecondary)
        }
        .tint(Palette.textSecondary.color)
        .accessibilityIdentifier("marketplace.\(marketplace).history")
    }
}

private struct OperationRow: View {
    let operation: Operation
    let events: [OperationEvent]?
    let loadEvents: (String) async -> Void
    @State private var showsSteps = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            Button {
                showsSteps.toggle()
                if showsSteps, events == nil {
                    Task { await loadEvents(operation.id) }
                }
            } label: {
                HStack(alignment: .firstTextBaseline) {
                    StatusLabel(operation.statusDisplay.label, tone: StatusLabel.Tone(operation.statusDisplay.tone))
                    Spacer(minLength: Spacing.xs)
                    Text(Formatting.timestamp(operation.createdAt))
                        .font(Typography.caption)
                        .foregroundStyle(Palette.textSecondary)
                }
            }
            .buttonStyle(.plain)
            .accessibilityHint(showsSteps ? "Hides the steps" : "Shows the steps")
            if let detail = operation.statusDisplay.detail {
                Text(detail)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if showsSteps {
                if let events {
                    ForEach(events, id: \.id) { event in
                        HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                            Text(Formatting.timestamp(event.occurredAt))
                                .font(Typography.caption.monospacedDigit())
                                .foregroundStyle(Palette.textSecondary)
                            Text(event.message ?? "")
                                .font(Typography.caption)
                                .foregroundStyle(Palette.textPrimary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                } else {
                    ProgressView().controlSize(.small)
                }
            }
        }
    }
}

extension StatusLabel.Tone {
    init(_ tone: MarketplaceRowState.Tone) {
        switch tone {
        case .success: self = .success
        case .inProgress: self = .inProgress
        case .checking: self = .checking
        case .failed: self = .failed
        case .actionNeeded: self = .actionNeeded
        case .neutral: self = .neutral
        }
    }
}
