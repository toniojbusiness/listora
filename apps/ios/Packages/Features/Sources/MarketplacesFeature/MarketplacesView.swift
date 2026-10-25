import AuthenticationServices
import DesignSystem
import SwiftUI

/// Every marketplace and how Listora works with it: eBay through its API once connected, the
/// others in assisted mode for now. "Connect eBay" opens eBay's own sign-in in the system's web
/// authentication sheet; Listora never asks for a marketplace password.
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
                        isConnecting: model.connecting == row.id,
                        isEnabled: model.connecting == nil,
                    ) {
                        let authenticate = webAuthenticationSession.authenticator()
                        Task { await model.connect(row, authenticate: authenticate) }
                    }
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
            .motion(value: model.notice)
            .motion(value: model.rows)
        }
        .refreshable { await model.load() }
    }
}

/// The two ways Listora works with a marketplace, in plain words.
private struct HowItWorksCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            point(
                "Connected",
                "Listora makes each change through the marketplace's API and checks it there.",
                systemImage: "link",
            )
            point(
                "Assisted",
                "Listora prepares each step, and you finish it in the marketplace's app.",
                systemImage: "hand.tap",
            )
        }
        .cardStyle(.outlined)
    }

    private func point(_ title: String, _ detail: String, systemImage: String) -> some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            IconTile(systemImage: systemImage)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Typography.subheadline.weight(.semibold))
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

/// One marketplace: its name, the server's status, and its connect or reconnect button.
struct MarketplaceRowView: View {
    let row: MarketplaceRow
    let isConnecting: Bool
    let isEnabled: Bool
    let connect: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(alignment: .center, spacing: Spacing.sm) {
                IconTile(
                    monogram: String(row.name.prefix(1)),
                    tone: row.tone.statusTone.looksDone ? .success : nil,
                    size: .card,
                )
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(row.name)
                        .font(Typography.title3)
                        .foregroundStyle(Palette.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                    StatusBadge(row.statusLabel, tone: row.tone.statusTone)
                        .accessibilityIdentifier("marketplaces.\(row.id).status")
                }
                Spacer(minLength: 0)
            }
            if let detail = row.statusDetail {
                Text(detail)
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let title = row.actionTitle {
                Button(isConnecting ? "Connecting..." : title, systemImage: "arrow.up.forward.app", action: connect)
                    .buttonStyle(.listoraPrimary)
                    .loading(isConnecting)
                    .disabled(!isEnabled)
                    .padding(.top, Spacing.xxs)
                    .accessibilityIdentifier("marketplaces.\(row.id).connect")
            }
        }
        .cardStyle()
        .accessibilityElement(children: .contain)
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
