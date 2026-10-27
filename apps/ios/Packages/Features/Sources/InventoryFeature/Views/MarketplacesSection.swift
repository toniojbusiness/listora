import Core
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
    /// The work this iPhone runs now, shown on the card of the listing it is for.
    var phoneProgress: PhoneWorkProgress?
    let perform: (MarketplaceRowState.Action, MarketplaceRowState) -> Void
    /// Ends the row's listing, once the seller confirmed it and said why.
    let end: (EndReason, MarketplaceRowState) -> Void
    /// Relists every row that can be relisted, at once.
    var relistAll: (([MarketplaceRowState]) -> Void)?
    /// Ends every row's listing that can be ended, at once, once the seller said why.
    var endAll: ((EndReason, [MarketplaceRowState]) -> Void)?
    /// Lists the item on every marketplace it can go on, at once (the bulk List sheet).
    var listEverywhere: (() -> Void)?
    let loadEvents: (String) async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            SectionHeader(
                "Marketplaces",
                subtitle: "A change shows as done only once the marketplace confirms it, or you do.",
            )
            AllMarketplacesActions(
                rows: rows,
                isBusy: busyMarketplace == ItemDetailModel.allMarketplaces,
                isEnabled: busyMarketplace == nil,
                relistAll: relistAll,
                endAll: endAll,
                listEverywhere: listEverywhere,
            )
            ForEach(rows) { row in
                MarketplaceCard(
                    row: row,
                    // With List everywhere at the top, each card's List is a smaller button.
                    listIsSecondary: listEverywhere != nil && AllMarketplacesActions.listableCount(rows) >= 2,
                    history: row.listing.flatMap { histories[$0.id] } ?? [],
                    events: events,
                    isBusy: busyMarketplace == row.id,
                    isEnabled: busyMarketplace == nil,
                    progress: phoneProgress.flatMap { progress in
                        progress.operationID != nil && progress.operationID == row.latestOperation?.id
                            ? progress : nil
                    },
                    perform: { action in perform(action, row) },
                    end: { reason in end(reason, row) },
                    loadEvents: loadEvents,
                )
            }
        }
    }
}

private struct MarketplaceCard: View {
    let row: MarketplaceRowState
    let listIsSecondary: Bool
    let history: [Operation]
    let events: [String: [OperationEvent]]
    let isBusy: Bool
    let isEnabled: Bool
    let progress: PhoneWorkProgress?
    let perform: (MarketplaceRowState.Action) -> Void
    let end: (EndReason) -> Void
    let loadEvents: (String) async -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        // The price under the name at accessibility sizes, so neither breaks mid-word.
        let heading = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Spacing.xs))
            : AnyLayout(HStackLayout(alignment: .center, spacing: Spacing.sm))
        VStack(alignment: .leading, spacing: Spacing.sm) {
            heading {
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
                .frame(maxWidth: .infinity, alignment: .leading)
                if let price = row.priceLabel {
                    Text(price)
                        .font(Typography.price)
                        .foregroundStyle(Palette.textPrimary)
                        .fixedSize()
                        .accessibilityLabel("Listed at \(price)")
                        .accessibilityIdentifier("marketplace.\(row.id).price")
                }
            }
            HStack(spacing: Spacing.xs) {
                StatusBadge(row.statusLabel, tone: StatusTone(row.tone))
                    .accessibilityIdentifier("marketplace.\(row.id).status")
                if row.isWorking, progress == nil {
                    BrandSpinner(color: Palette.info)
                        .controlSize(.small)
                        .accessibilityLabel("Working on it")
                }
            }
            if let progress {
                PhoneProgressView(progress: progress, marketplace: row.id)
            }
            if let schedule = row.scheduleLabel {
                Label(schedule, systemImage: "clock")
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityIdentifier("marketplace.\(row.id).schedule")
            }
            if let detail = row.statusDetail {
                Text(detail)
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("marketplace.\(row.id).detail")
            }
            if let lastChange = row.lastChange {
                Text(lastChange)
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("marketplace.\(row.id).lastChange")
            }
            if !row.actions.isEmpty {
                ActionButtons(
                    row: row,
                    listIsSecondary: listIsSecondary,
                    isBusy: isBusy,
                    isEnabled: isEnabled,
                    perform: perform,
                    end: end,
                )
            }
            if let url = row.externalURL {
                ListingLinks(url: url, row: row)
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
    let listIsSecondary: Bool
    let isBusy: Bool
    let isEnabled: Bool
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

    private func secondary(_ actions: [MarketplaceRowState.Action]) -> some View {
        ForEach(actions, id: \.self) { action in
            button(action)
                .buttonStyle(.listora(action == .end ? .destructive : .secondary, size: .compact))
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

/// "View on eBay" and Share, for a listing with its marketplace link.
private struct ListingLinks: View {
    let url: URL
    let row: MarketplaceRowState

    var body: some View {
        HStack(spacing: Spacing.xs) {
            Link(destination: url) {
                Label("View on \(row.name)", systemImage: "arrow.up.right.square")
            }
            .buttonStyle(.listora(.tertiary, size: .compact))
            .accessibilityIdentifier("marketplace.\(row.id).view")
            ShareLink(item: url) {
                Label("Share", systemImage: "square.and.arrow.up")
            }
            .buttonStyle(.listora(.tertiary, size: .compact))
            .accessibilityIdentifier("marketplace.\(row.id).share")
        }
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
        case .tryNow: "play.fill"
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
                .font(Typography.emphasis)
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
                            .font(Typography.metadata)
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
