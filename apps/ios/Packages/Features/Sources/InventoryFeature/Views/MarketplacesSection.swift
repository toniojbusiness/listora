import Core
import DesignSystem
import ListoraAPI
import SwiftUI

/// The item's marketplaces on one string, a bead per marketplace: the listing's status as the
/// server words it, how Listora works with the marketplace, the actions allowed now, and the
/// listing's history. The string to a marketplace the item is not on yet is loose (dashed).
struct MarketplacesSection: View {
    let rows: [MarketplaceRowState]
    let histories: [String: [Operation]]
    let events: [String: [OperationEvent]]
    let busyMarketplace: String?
    /// The work this iPhone runs now (one per marketplace), each shown on the card of the
    /// listing it is for.
    var phoneProgress: [PhoneWorkProgress] = []
    /// An action that shows only because of the owner's Test mode (test-mode.md): tagged Testing.
    var isTesting: (MarketplaceRowState.Action, String) -> Bool = { _, _ in false }
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
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    marketplace(row, at: index)
                }
            }
        }
    }

    private func marketplace(_ row: MarketplaceRowState, at index: Int) -> some View {
        ThreadRow(
            position: .at(index, of: rows.count),
            above: Self.string(to: row),
            below: index + 1 < rows.count ? Self.string(to: rows[index + 1]) : .taut,
        ) {
            ThreadBead(monogram: String(row.name.prefix(1)), tone: StatusTone(row.tone))
        } content: {
            MarketplaceCard(
                row: row,
                // With List everywhere at the top, each card's List is a smaller button.
                listIsSecondary: listEverywhere != nil && AllMarketplacesActions.showsListAll(rows),
                history: row.listing.flatMap { histories[$0.id] } ?? [],
                events: events,
                isBusy: busyMarketplace == row.id,
                isEnabled: busyMarketplace == nil,
                progress: phoneProgress.first { progress in
                    progress.operationID != nil && progress.operationID == row.latestOperation?.id
                },
                isTesting: { action in isTesting(action, row.id) },
                perform: { action in perform(action, row) },
                end: { reason in end(reason, row) },
                loadEvents: loadEvents,
            )
            .padding(.bottom, index + 1 < rows.count ? Spacing.md : 0)
        }
    }

    /// The string to a marketplace, from the listing's confirmed state only: tied once the
    /// marketplace confirms the listing is live (or sold there), cut once it confirms the listing
    /// ended (a sale ends it everywhere else), and loose while the item is not on it or the work
    /// is still running or failed. A change animates: the knot ties, or the string is cut.
    static func string(to row: MarketplaceRowState) -> ThreadStyle {
        switch row.listing?.status.value1 {
        case .active, .ending, .sold: .taut
        case .ended: .cut
        case .draft, .queued, .publishing, .error, .unknown, .needsUserAction, nil: .loose
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
    let isTesting: (MarketplaceRowState.Action) -> Bool
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
            if let refresh = row.refreshLine {
                Label(refresh, systemImage: "arrow.clockwise")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("marketplace.\(row.id).refresh")
            }
            if !row.actions.isEmpty {
                ActionButtons(
                    row: row,
                    listIsSecondary: listIsSecondary,
                    isBusy: isBusy,
                    isEnabled: isEnabled,
                    isTesting: isTesting,
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
        // No box: the bead and the string carry the marketplace; a failure keeps its tint.
        .modifier(FailureTint(isFailed: row.tone == .failed))
        .accessibilityElement(children: .contain)
    }
}

/// A failed marketplace's content on the failure's soft color, so it stands out on the string.
private struct FailureTint: ViewModifier {
    let isFailed: Bool

    func body(content: Content) -> some View {
        if isFailed {
            content.cardStyle(.tinted(.failed), padding: Spacing.sm)
        } else {
            content
        }
    }
}

extension MarketplaceRowState.Action {
    var systemImage: String {
        switch self {
        case .list: "tag.fill"
        case .changePrice: "dollarsign.circle"
        case .revise: "pencil"
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
