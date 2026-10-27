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
                    ProgressView()
                        .controlSize(.small)
                        .tint(Palette.info.color)
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
            if !row.actions.isEmpty {
                ActionButtons(row: row, isBusy: isBusy, isEnabled: isEnabled, perform: perform, end: end)
            }
            if !history.isEmpty {
                HistoryView(marketplace: row.id, operations: history, events: events, loadEvents: loadEvents)
            }
        }
        .cardStyle(row.tone == .failed ? .tinted(.failed) : .elevated)
        .accessibilityElement(children: .contain)
    }
}

/// The listing change this iPhone works on now: the step in plain words, its number, and about
/// how long the run has left (from the same work's earlier runs here), counting down.
private struct PhoneProgressView: View {
    let progress: PhoneWorkProgress
    let marketplace: String

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            VStack(alignment: .leading, spacing: Spacing.xs) {
                HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
                    Text(progress.step ?? "Starting")
                        .font(Typography.emphasis)
                        .foregroundStyle(Palette.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let count = progress.stepText {
                        Text(count)
                            .font(Typography.footnote.monospacedDigit())
                            .foregroundStyle(Palette.textSecondary)
                            .fixedSize()
                    }
                }
                if let fraction = progress.fractionDone {
                    ProgressView(value: fraction)
                        .tint(Palette.info.color)
                } else {
                    ProgressView()
                        .progressViewStyle(.linear)
                        .tint(Palette.info.color)
                }
                Text(progress.timeLeftText(at: context.date))
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                [progress.step ?? "Starting", progress.stepText, progress.timeLeftText(at: context.date)]
                    .compactMap(\.self).joined(separator: ", "),
            )
        }
        .padding(Spacing.sm)
        .background(Palette.infoSoft.color, in: RoundedRectangle(cornerRadius: Radius.small))
        .accessibilityIdentifier("marketplace.\(marketplace).progress")
    }
}

extension PhoneWorkProgress {
    /// "Step 4 of 9", or "Step 4" before the work ran to the end once on this phone.
    var stepText: String? {
        guard stepNumber > 0 else { return nil }
        guard let stepCount else { return "Step \(stepNumber)" }
        return "Step \(stepNumber) of \(max(stepCount, stepNumber))"
    }

    /// "Working on your iPhone, about 40 seconds left. Keep Listora open until it's done."
    func timeLeftText(at now: Date) -> String {
        let keepOpen = "Keep Listora open until it's done."
        guard let seconds = secondsLeft(at: now) else { return "Working on your iPhone. \(keepOpen)" }
        let left = seconds < 60
            ? "about \(seconds) second\(seconds == 1 ? "" : "s") left"
            : "about \(Int((Double(seconds) / 60).rounded(.up))) min left"
        return "Working on your iPhone, \(left). \(keepOpen)"
    }
}

/// The card's actions: the first is the primary one (List, or Retry after a failure), the rest
/// are compact buttons beside each other, or stacked when they do not fit.
private struct ActionButtons: View {
    let row: MarketplaceRowState
    let isBusy: Bool
    let isEnabled: Bool
    let perform: (MarketplaceRowState.Action) -> Void
    let end: (EndReason) -> Void
    @State private var isConfirmingEnd = false

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
