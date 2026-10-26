import AuthenticationServices
import Core
import DesignSystem
import SwiftUI

/// Every marketplace and how Listora works with it (API, automation, or assisted), with each
/// connection's health: its status in the server's words, when it last checked out, and what to
/// do next (Connect, Reconnect, Retry check). "Connect eBay" opens eBay's own sign-in in the
/// system's web authentication sheet; Listora never asks for a marketplace password.
public struct MarketplacesView: View {
    @State private var model: MarketplacesModel
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession

    public init(model: MarketplacesModel) {
        _model = State(initialValue: model)
    }

    public var body: some View {
        content
            .background(Palette.background)
            .navigationTitle("Marketplaces")
            .task { await model.load() }
            .sensoryFeedback(trigger: model.notice) { _, notice in
                switch notice?.tone {
                case .success: .success
                case .failure: .error
                case .info, nil: nil
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading where model.rows.isEmpty:
            loading
        case let .failed(message) where model.rows.isEmpty:
            EmptyStateView(
                systemImage: "link.badge.plus",
                tone: .failed,
                title: "Marketplaces unavailable",
                message: message,
                action: .init("Try again", systemImage: "arrow.clockwise") { Task { await model.load() } },
            )
        default:
            list
        }
    }

    private var loading: some View {
        ScrollView {
            VStack(spacing: Spacing.sm) {
                ForEach(0 ..< 4, id: \.self) { _ in
                    SkeletonRow().cardStyle()
                }
            }
            .padding(Spacing.md)
        }
        .scrollDisabled(true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading marketplaces")
    }

    private var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.md) {
                if let notice = model.notice {
                    Banner(
                        notice.message,
                        tone: notice.tone.statusTone,
                        onDismiss: { model.dismissNotice() },
                        identifier: "marketplaces.notice",
                    )
                    .transition(.rise)
                }
                HowItWorksCard()
                SectionHeader("Your marketplaces")
                    .padding(.top, Spacing.xs)
                ForEach(model.rows) { row in
                    MarketplaceRowView(
                        row: row,
                        busyAction: busyAction(for: row),
                        isEnabled: model.connecting == nil && model.requestingCheck == nil,
                        moving: model.moving == row.id,
                        onMove: { toPhone in Task { await model.move(row, toPhone: toPhone) } },
                        perform: { action in
                            switch action {
                            case .connect, .reconnect:
                                let authenticate = webAuthenticationSession.authenticator()
                                Task { await model.connect(row, authenticate: authenticate) }
                            case .check:
                                Task { await model.check(row) }
                            }
                        },
                    )
                }
                if let forwarding = model.saleForwarding {
                    SectionHeader("Sale emails")
                        .padding(.top, Spacing.xs)
                    SaleForwardingCard(row: forwarding)
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
            .motion(value: model.notice)
            .motion(value: model.rows)
        }
        .refreshable { await model.load() }
        .onReceive(NotificationCenter.default.publisher(for: .phoneWorkFinished)) { _ in
            Task { await model.load() }
        }
    }

    private func busyAction(for row: MarketplaceRow) -> MarketplaceRow.Action? {
        if model.connecting == row.id {
            return row.actions.first { $0 == .connect || $0 == .reconnect }
        }
        return model.requestingCheck == row.id ? .check : nil
    }
}

/// The ways Listora works with a marketplace, in plain words.
private struct HowItWorksCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            point(
                "API",
                "Listora makes each change through the marketplace's API and checks it there.",
                systemImage: "link",
            )
            point(
                "Assisted",
                "Listora prepares each step, and you finish it in the marketplace's app.",
                systemImage: "hand.tap",
            )
        }
        .cardStyle(.flat)
    }

    private func point(_ title: String, _ detail: String, systemImage: String) -> some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            IconTile(systemImage: systemImage)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Typography.emphasis)
                    .foregroundStyle(Palette.textPrimary)
                Text(detail)
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// One marketplace's card: its name and mode, the server's status, when it last checked out,
/// and its actions (the main one filled, a second one plain).
struct MarketplaceRowView: View {
    let row: MarketplaceRow
    /// The action running for this row right now.
    let busyAction: MarketplaceRow.Action?
    let isEnabled: Bool
    var moving = false
    /// Moves its automated steps to this phone (true) or to Listora's cloud.
    var onMove: (Bool) -> Void = { _ in }
    let perform: (MarketplaceRow.Action) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .center, spacing: Spacing.sm) {
                IconTile(
                    monogram: String(row.name.prefix(1)),
                    tone: row.tone.statusTone.looksDone ? .success : nil,
                    size: .card,
                )
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                        Text(row.name)
                            .font(Typography.title3)
                            .foregroundStyle(Palette.textPrimary)
                            .accessibilityAddTraits(.isHeader)
                        Spacer(minLength: 0)
                        if let mode = row.modeLabel {
                            Chip(mode, emphasis: .muted)
                                .accessibilityLabel("\(mode) mode")
                                .accessibilityIdentifier("marketplaces.\(row.id).mode")
                        }
                    }
                    StatusBadge(row.statusLabel, tone: row.tone.statusTone)
                        .accessibilityIdentifier("marketplaces.\(row.id).status")
                }
            }
            if let detail = row.statusDetail {
                Text(detail)
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("marketplaces.\(row.id).detail")
            }
            if let lastOkAt = row.lastOkAt {
                Label {
                    Text("Last checked OK \(lastOkAt, format: .relative(presentation: .named))")
                } icon: {
                    Image(systemName: "clock")
                }
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
                .accessibilityIdentifier("marketplaces.\(row.id).lastOk")
            }
            if let execution = row.execution {
                HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                    Label(execution.text, systemImage: execution.onPhone ? "iphone" : "cloud")
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(execution.text)
                        .accessibilityIdentifier("marketplaces.\(row.id).runsOn")
                    Spacer(minLength: 0)
                    Button(execution.onPhone ? "Run in the cloud" : "Run on this iPhone") {
                        onMove(!execution.onPhone)
                    }
                    .buttonStyle(.listoraTertiary)
                    .loading(moving)
                    .disabled(!isEnabled || moving)
                    .accessibilityIdentifier("marketplaces.\(row.id).move")
                }
            }
            if !row.actions.isEmpty {
                VStack(spacing: Spacing.xs) {
                    ForEach(Array(row.actions.enumerated()), id: \.offset) { index, action in
                        button(for: action, primary: index == 0)
                    }
                }
                .padding(.top, Spacing.xxs)
            }
        }
        .cardStyle()
        .accessibilityElement(children: .contain)
    }

    private func button(for action: MarketplaceRow.Action, primary: Bool) -> some View {
        let busy = busyAction == action
        return Button(busy ? busyTitle(for: action) : row.title(for: action), systemImage: systemImage(for: action)) {
            perform(action)
        }
        .buttonStyle(primary ? .listoraPrimary : .listoraSecondary)
        .loading(busy)
        .disabled(!isEnabled)
        .accessibilityIdentifier("marketplaces.\(row.id).\(identifier(for: action))")
    }

    private func busyTitle(for action: MarketplaceRow.Action) -> String {
        switch action {
        case .connect, .reconnect: "Connecting..."
        case .check: "Checking..."
        }
    }

    private func systemImage(for action: MarketplaceRow.Action) -> String {
        switch action {
        case .connect, .reconnect: "arrow.up.forward.app"
        case .check: "arrow.clockwise"
        }
    }

    /// `connect` for both connecting and reconnecting, as the UI tests have always found it.
    private func identifier(for action: MarketplaceRow.Action) -> String {
        switch action {
        case .connect, .reconnect: "connect"
        case .check: "check"
        }
    }
}

/// Sale email forwarding: the server's status, in its words.
struct SaleForwardingCard: View {
    let row: SaleForwardingRow

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .center, spacing: Spacing.sm) {
                IconTile(systemImage: "envelope", size: .card)
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text("Email sale forwarding")
                        .font(Typography.title3)
                        .foregroundStyle(Palette.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                    StatusBadge(row.statusLabel, tone: row.tone)
                        .accessibilityIdentifier("marketplaces.saleForwarding.status")
                }
                Spacer(minLength: 0)
            }
            if let detail = row.statusDetail {
                Text(detail)
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .cardStyle()
        .accessibilityElement(children: .contain)
    }
}

/// The app's banner while a marketplace connection needs attention; tapping "Open
/// Marketplaces" shows them. It reads the summary again each time it appears.
public struct ConnectionAttentionBanner: View {
    private let model: MarketplacesModel
    private let open: @MainActor () -> Void

    public init(model: MarketplacesModel, open: @escaping @MainActor () -> Void) {
        self.model = model
        self.open = open
    }

    public var body: some View {
        // Always laid out (zero height without a banner), so it reloads each time it appears.
        VStack(spacing: 0) {
            Color.clear.frame(height: 0)
            if let attention = model.attention {
                Banner(
                    attention.title,
                    message: attention.message,
                    tone: attention.needsAction ? .actionNeeded : .checking,
                    systemImage: "link.badge.plus",
                    action: .init("Open Marketplaces", identifier: "connectionAttention.open", handler: open),
                    identifier: "connectionAttention.banner",
                )
                .padding(.horizontal, Spacing.md)
                .padding(.top, Spacing.xs)
                .padding(.bottom, Spacing.xxs)
                .frame(maxWidth: Layout.readableWidth)
                .frame(maxWidth: .infinity)
                .transition(.rise)
            }
        }
        .motion(value: model.attention)
        .task { await model.refreshAttention() }
    }
}

extension MarketplaceRow.Tone {
    var statusTone: StatusTone {
        switch self {
        case .success: .success
        case .inProgress: .inProgress
        case .checking: .checking
        case .failed: .failed
        case .actionNeeded: .actionNeeded
        case .neutral: .neutral
        }
    }
}

extension ConnectionNotice.Tone {
    var statusTone: StatusTone {
        switch self {
        case .success: .success
        case .info: .neutral
        case .failure: .failed
        }
    }
}
