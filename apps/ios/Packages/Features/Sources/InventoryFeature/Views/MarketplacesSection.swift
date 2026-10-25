import DesignSystem
import ListoraAPI
import SwiftUI

/// One card per marketplace: the listing's status as the server words it, how Listora works
/// with the marketplace, the actions allowed now, and the listing's history.
struct MarketplacesSection: View {
    let rows: [MarketplaceRowState]
    let histories: [String: [Operation]]
    let events: [String: [OperationEvent]]
    let busyMarketplace: String?
    let perform: (MarketplaceRowState.Action, MarketplaceRowState) -> Void
    let loadEvents: (String) async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            SectionHeader(
                "Marketplaces",
                subtitle: "A change shows as done only once the marketplace confirms it, or you do.",
            )
            ForEach(rows) { row in
                MarketplaceCard(
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

private struct MarketplaceCard: View {
    let row: MarketplaceRowState
    let history: [Operation]
    let events: [String: [OperationEvent]]
    let isBusy: Bool
    let isEnabled: Bool
    let perform: (MarketplaceRowState.Action) -> Void
    let loadEvents: (String) async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .center, spacing: Spacing.sm) {
                IconTile(
                    monogram: String(row.name.prefix(1)),
                    tone: row.tone == .success ? .success : nil,
                    size: .card,
                )
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(row.name)
                        .font(Typography.title3)
                        .foregroundStyle(Palette.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                    Text(row.modeLabel)
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                }
                Spacer(minLength: Spacing.xs)
                if let price = row.priceLabel {
                    Text(price)
                        .font(Typography.price)
                        .foregroundStyle(Palette.textPrimary)
                        .accessibilityLabel("Listed at \(price)")
                        .accessibilityIdentifier("marketplace.\(row.id).price")
                }
            }
            HStack(spacing: Spacing.xs) {
                StatusBadge(row.statusLabel, tone: StatusTone(row.tone))
                    .accessibilityIdentifier("marketplace.\(row.id).status")
                if row.isWorking {
                    ProgressView()
                        .controlSize(.small)
                        .tint(Palette.info.color)
                        .accessibilityLabel("Working on it")
                }
            }
            if let detail = row.statusDetail {
                Text(detail)
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("marketplace.\(row.id).detail")
            }
            if !row.actions.isEmpty {
                ActionButtons(row: row, isBusy: isBusy, isEnabled: isEnabled, perform: perform)
            }
            if !history.isEmpty {
                HistoryView(marketplace: row.id, operations: history, events: events, loadEvents: loadEvents)
            }
        }
        .cardStyle(row.tone == .failed ? .tinted(.failed) : .elevated)
        .accessibilityElement(children: .contain)
    }
}

/// The card's actions: the first is the primary one (List, or Retry after a failure), the rest
/// are compact buttons beside each other, or stacked when they do not fit.
private struct ActionButtons: View {
    let row: MarketplaceRowState
    let isBusy: Bool
    let isEnabled: Bool
    let perform: (MarketplaceRowState.Action) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            if let primary = row.actions.first {
                button(primary)
                    .buttonStyle(.listoraPrimary)
                    .loading(isBusy)
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
            button(action)
                .buttonStyle(.listora(action == .end ? .destructive : .secondary, size: .compact))
        }
    }

    private func button(_ action: MarketplaceRowState.Action) -> some View {
        Button(action.title, systemImage: action.systemImage) { perform(action) }
            .disabled(!isEnabled)
            .accessibilityIdentifier("marketplace.\(row.id).action.\(action.identifier)")
    }
}

extension MarketplaceRowState.Action {
    var systemImage: String {
        switch self {
        case .list: "tag.fill"
        case .changePrice: "dollarsign.circle"
        case .end: "xmark.circle"
        case .relist: "arrow.counterclockwise"
        case .check: "magnifyingglass"
        case .retry: "arrow.clockwise"
        case .openTask: "checklist"
        }
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
                .font(Typography.subheadline.weight(.semibold))
                .foregroundStyle(Palette.textSecondary)
        }
        .tint(Palette.textSecondary.color)
        .padding(.top, Spacing.xxs)
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
                    StatusLabel(operation.statusDisplay.label, tone: StatusTone(operation.statusDisplay.tone))
                    Spacer(minLength: Spacing.xs)
                    Text(Formatting.timestamp(operation.createdAt))
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                }
                .frame(minHeight: Layout.minimumTapTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(showsSteps ? "Hides the steps" : "Shows the steps")
            if let detail = operation.statusDisplay.detail {
                Text(detail)
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if showsSteps {
                steps
            }
        }
    }

    @ViewBuilder
    private var steps: some View {
        if let events {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                ForEach(events, id: \.id) { event in
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                        Text(Formatting.timestamp(event.occurredAt))
                            .font(Typography.caption.monospacedDigit())
                            .foregroundStyle(Palette.textSecondary)
                        Text(event.message ?? "")
                            .font(Typography.footnote)
                            .foregroundStyle(Palette.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(Spacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.surfaceSecondary, in: RoundedRectangle(cornerRadius: Radius.medium, style: .continuous))
        } else {
            SkeletonBlock(height: 12)
        }
    }
}
