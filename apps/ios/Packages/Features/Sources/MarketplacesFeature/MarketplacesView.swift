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
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading where model.rows.isEmpty:
            ProgressView("Loading marketplaces")
                .foregroundStyle(Palette.textSecondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message) where model.rows.isEmpty:
            EmptyStateView(
                systemImage: "link.badge.plus",
                title: "Marketplaces unavailable",
                message: message,
                action: .init("Try again") { Task { await model.load() } },
            )
        default:
            list
        }
    }

    private static let footer = """
    Connected marketplaces: Listora makes each change through the marketplace's API and \
    checks it there. Assisted marketplaces: Listora prepares each step, and you finish it in \
    the marketplace's app.
    """

    private var list: some View {
        List {
            if let notice = model.notice {
                NoticeRow(notice: notice) { model.dismissNotice() }
                    .listRowBackground(Palette.surface.color)
            }
            Section {
                ForEach(model.rows) { row in
                    MarketplaceRowView(
                        row: row,
                        isConnecting: model.connecting == row.id,
                        isEnabled: model.connecting == nil,
                    ) {
                        let authenticate = webAuthenticationSession.authenticator()
                        Task { await model.connect(row, authenticate: authenticate) }
                    }
                    .listRowBackground(Palette.surface.color)
                }
            } footer: {
                Text(Self.footer)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
            }
        }
        .scrollContentBackground(.hidden)
        .refreshable { await model.load() }
    }
}

/// One marketplace: its name, the server's status, and its connect or reconnect button.
struct MarketplaceRowView: View {
    let row: MarketplaceRow
    let isConnecting: Bool
    let isEnabled: Bool
    let connect: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(row.name)
                .font(Typography.headline)
                .foregroundStyle(Palette.textPrimary)
            HStack(spacing: Spacing.xs) {
                Image(systemName: row.tone.systemImage)
                    .accessibilityHidden(true)
                Text(row.statusLabel)
                    .accessibilityIdentifier("marketplaces.\(row.id).status")
            }
            .font(Typography.callout.weight(.semibold))
            .foregroundStyle(row.tone.color)
            if let detail = row.statusDetail {
                Text(detail)
                    .font(Typography.callout)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let title = row.actionTitle {
                Button(action: connect) {
                    HStack(spacing: Spacing.xs) {
                        if isConnecting {
                            ProgressView().tint(Palette.onBrand.color)
                        }
                        Text(isConnecting ? "Connecting..." : title)
                    }
                }
                .buttonStyle(.listoraPrimary)
                .disabled(!isEnabled)
                .padding(.top, Spacing.xxs)
                .accessibilityIdentifier("marketplaces.\(row.id).connect")
            }
        }
        .padding(.vertical, Spacing.xs)
        .accessibilityElement(children: .contain)
    }
}

/// The last connection attempt's outcome.
struct NoticeRow: View {
    let notice: ConnectionNotice
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            Image(systemName: notice.tone.systemImage)
                .foregroundStyle(notice.tone.color)
                .accessibilityHidden(true)
            Text(notice.message)
                .font(Typography.callout)
                .foregroundStyle(Palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("marketplaces.notice")
            Spacer(minLength: 0)
            Button("Dismiss", systemImage: "xmark", action: dismiss)
                .labelStyle(.iconOnly)
                .foregroundStyle(Palette.textSecondary)
                .frame(minWidth: Layout.minimumTapTarget, minHeight: Layout.minimumTapTarget)
                .buttonStyle(.borderless)
        }
    }
}

extension MarketplaceRow.Tone {
    var color: ColorToken {
        switch self {
        case .success: Palette.success
        case .failed: Palette.danger
        case .actionNeeded, .checking: Palette.warning
        case .inProgress, .neutral: Palette.textSecondary
        }
    }

    var systemImage: String {
        switch self {
        case .success: "checkmark.circle.fill"
        case .failed: "xmark.octagon.fill"
        case .actionNeeded: "exclamationmark.triangle.fill"
        case .checking: "arrow.triangle.2.circlepath"
        case .inProgress: "clock"
        case .neutral: "info.circle"
        }
    }
}

extension ConnectionNotice.Tone {
    var color: ColorToken {
        switch self {
        case .success: Palette.success
        case .info: Palette.textSecondary
        case .failure: Palette.danger
        }
    }

    var systemImage: String {
        switch self {
        case .success: "checkmark.circle.fill"
        case .info: "info.circle"
        case .failure: "exclamationmark.triangle.fill"
        }
    }
}
