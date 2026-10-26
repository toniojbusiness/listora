import APIClient
import DesignSystem
import SwiftUI

/// Link accounts: Poshmark, Mercari, Depop, and eBay (until its API is connected), each with the
/// server's status and a one-tap Link or Relink that opens the marketplace's own sign-in page.
public struct LinkAccountsView: View {
    @Bindable private var model: LinkAccountsModel

    public init(model: LinkAccountsModel) {
        self.model = model
    }

    public var body: some View {
        List {
            switch model.loadState {
            case .loading where model.links.isEmpty:
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
            case let .failed(error) where model.links.isEmpty:
                loadFailure(error)
            case .loading, .loaded, .failed:
                Section {
                    ForEach(model.links) { link in
                        LinkAccountRow(
                            link: link,
                            progress: model.progress[link.marketplace],
                            onLink: { model.startLinking(link) },
                            onCheckAgain: { Task { await model.checkAgain(link) } },
                            onRetry: { Task { await model.retry(link.marketplace) } },
                        )
                    }
                } footer: {
                    Text(
                        "You sign in on each marketplace's own page. Listora keeps the sign-in "
                            + "session to list and update your items, never your password.",
                    )
                }
                .listRowBackground(Palette.surface.color)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Palette.background)
        .foregroundStyle(Palette.textPrimary)
        .navigationTitle("Link accounts")
        .task { await model.load() }
        .refreshable { await model.load() }
        .sheet(item: $model.signingIn) { link in
            MarketplaceSignInView(
                link: link,
                onCancel: { model.cancelSignIn() },
                onSignedIn: { cookies in Task { await model.finishSignIn(link, cookies: cookies) } },
            )
            .interactiveDismissDisabled()
        }
    }

    private func loadFailure(_ error: APIFailure) -> some View {
        VStack(spacing: Spacing.sm) {
            Text(error.message)
                .foregroundStyle(Palette.danger)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("linkAccounts.loadError")
            if error.retryable {
                Button("Try again") { Task { await model.load() } }
                    .accessibilityIdentifier("linkAccounts.reload")
            }
        }
        .frame(maxWidth: .infinity)
        .listRowBackground(Color.clear)
    }
}

private struct LinkAccountRow: View {
    let link: MarketplaceLink
    let progress: LinkAccountsModel.LinkProgress?
    let onLink: () -> Void
    let onCheckAgain: () -> Void
    let onRetry: () -> Void

    private var busy: Bool {
        progress == .sending || progress == .requestingCheck
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(link.name)
                        .font(Typography.headline)
                    if let displayName = link.displayName {
                        Text(displayName)
                            .font(Typography.caption)
                            .foregroundStyle(Palette.textSecondary)
                    }
                }
                Spacer()
                if link.canCheckAgain, !busy {
                    // The session Listora holds may be fine: checking it again needs no sign-in.
                    Button("Check again", action: onCheckAgain)
                        .buttonStyle(.borderedProminent)
                        .tint(Palette.brand.color)
                        // The list's text color would otherwise override the filled label's.
                        .foregroundStyle(Palette.onBrand)
                        .accessibilityIdentifier("linkAccounts.checkAgain.\(link.marketplace)")
                }
                if link.canLink, !busy {
                    Button(link.linkActionTitle, action: onLink)
                        .buttonStyle(.bordered)
                        .tint(Palette.brand.color)
                        .accessibilityIdentifier("linkAccounts.link.\(link.marketplace)")
                }
            }
            StatusLabel(link.statusLabel, tone: link.statusTone)
                .accessibilityIdentifier("linkAccounts.status.\(link.marketplace)")
            if let detail = link.statusDetail, detail != link.statusLabel {
                Text(detail)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityIdentifier("linkAccounts.detail.\(link.marketplace)")
            }
            switch progress {
            case .sending:
                Label("Sending your sign-in to Listora...", systemImage: "arrow.up.circle")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityIdentifier("linkAccounts.sending.\(link.marketplace)")
            case .requestingCheck:
                Label("Asking Listora to check again...", systemImage: "arrow.clockwise")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityIdentifier("linkAccounts.requestingCheck.\(link.marketplace)")
            case let .checkFailed(error):
                Text(error.message)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.danger)
                    .accessibilityIdentifier("linkAccounts.checkError.\(link.marketplace)")
            case let .failed(error):
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(error.message)
                        .font(Typography.caption)
                        .foregroundStyle(Palette.danger)
                        .accessibilityIdentifier("linkAccounts.error.\(link.marketplace)")
                    if error.retryable {
                        Button("Try again", action: onRetry)
                            .font(Typography.caption)
                            .accessibilityIdentifier("linkAccounts.retry.\(link.marketplace)")
                    }
                }
            case nil:
                EmptyView()
            }
        }
        .padding(.vertical, Spacing.xxs)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("linkAccounts.row.\(link.marketplace)")
    }
}
