import APIClient
import Core
import DesignSystem
import SwiftUI

/// Link accounts: Poshmark, Mercari, Depop, and eBay (until its API is connected), each with the
/// server's status, a one-tap Link or Relink that opens the marketplace's own sign-in page, and
/// Unlink (after a confirmation), which deletes what Listora holds for that marketplace; then the
/// sale emails section (the forwarding address that catches their sold emails).
public struct LinkAccountsView: View {
    @Bindable private var model: LinkAccountsModel

    public init(model: LinkAccountsModel) {
        self.model = model
    }

    public var body: some View {
        List {
            switch model.loadState {
            case .loading where model.links.isEmpty:
                Section {
                    ForEach(0 ..< 4, id: \.self) { _ in
                        SkeletonRow()
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Loading your marketplaces")
            case let .failed(error) where model.links.isEmpty:
                loadFailure(error)
            case .loading, .loaded, .failed:
                Section {
                    ForEach(model.links) { link in
                        LinkAccountRow(
                            link: link,
                            installationID: model.installationID,
                            progress: model.progress[link.marketplace],
                            onLink: { model.startLinking(link) },
                            onCheckAgain: { Task { await model.checkAgain(link) } },
                            onRetry: { Task { await model.retry(link.marketplace) } },
                            onUnlink: { model.requestUnlink(link) },
                            onRetryUnlink: { Task { await model.retryUnlink(link.marketplace) } },
                            confirmingUnlink: Binding(
                                get: { model.confirmingUnlink == link },
                                set: {
                                    if !$0 {
                                        model.cancelUnlink()
                                    }
                                },
                            ),
                            onConfirmUnlink: { Task { await model.confirmUnlink(link) } },
                        )
                    }
                } footer: {
                    Text(
                        "You sign in on each marketplace's own page. Listora keeps the sign-in "
                            + "session to list and update your items, never your password.",
                    )
                }
                .listRowBackground(Palette.surface.color)
                if let saleEmails = model.saleEmails {
                    SaleEmailsSection(model: saleEmails)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Palette.background)
        .foregroundStyle(Palette.textPrimary)
        .navigationTitle("Link accounts")
        .task { await model.load() }
        .task { await model.saleEmails?.load() }
        .onReceive(NotificationCenter.default.publisher(for: .phoneWorkFinished)) { _ in
            Task { await model.refresh() }
        }
        .refreshable {
            async let links: Void = model.load()
            async let emails: Void? = model.saleEmails?.load()
            _ = await (links, emails)
        }
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
    let installationID: String
    let progress: LinkAccountsModel.LinkProgress?
    let onLink: () -> Void
    let onCheckAgain: () -> Void
    let onRetry: () -> Void
    let onUnlink: () -> Void
    let onRetryUnlink: () -> Void
    /// The confirmation, attached to this row's Unlink button so it opens next to it.
    @Binding var confirmingUnlink: Bool
    let onConfirmUnlink: () -> Void

    private var busy: Bool {
        progress == .sending || progress == .requestingCheck || progress == .unlinking
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
            if let runsOn = link.runsOn {
                RunsOnLabel(runsOn: runsOn, installationID: installationID)
                    .accessibilityIdentifier("linkAccounts.runsOn.\(link.marketplace)")
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
            case .unlinking:
                Label("Unlinking \(link.name)...", systemImage: "minus.circle")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityIdentifier("linkAccounts.unlinking.\(link.marketplace)")
            case let .unlinkFailed(error):
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text(error.message)
                        .font(Typography.caption)
                        .foregroundStyle(Palette.danger)
                        .accessibilityIdentifier("linkAccounts.unlinkError.\(link.marketplace)")
                    if error.retryable {
                        Button("Try again", action: onRetryUnlink)
                            .font(Typography.caption)
                            .accessibilityIdentifier("linkAccounts.retryUnlink.\(link.marketplace)")
                    }
                }
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
            if link.canUnlink, !busy {
                Button("Unlink", role: .destructive, action: onUnlink)
                    .buttonStyle(.listora(.destructiveText, size: .compact))
                    // A text-only button: line its text up with the row's, not its padding.
                    .padding(.leading, -Spacing.sm)
                    .accessibilityIdentifier("linkAccounts.unlink.\(link.marketplace)")
                    .confirmationDialog(
                        "Unlink \(link.name)?",
                        isPresented: $confirmingUnlink,
                        titleVisibility: .visible,
                    ) {
                        Button("Unlink \(link.name)", role: .destructive, action: onConfirmUnlink)
                            .accessibilityIdentifier("linkAccounts.confirmUnlink")
                        Button("Cancel", role: .cancel) { confirmingUnlink = false }
                    } message: {
                        Text(
                            "Listora deletes its \(link.name) sign-in and what it read from \(link.name), "
                                + "and asks \(link.name) to end its access. Your items, listings, and sales stay. "
                                + "Listings stay on \(link.name), but Listora can't update them until you link "
                                + "it again.",
                        )
                    }
            }
        }
        .padding(.vertical, Spacing.xxs)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("linkAccounts.row.\(link.marketplace)")
    }
}

/// Where a marketplace's automated steps run, and what waits for this phone.
struct RunsOnLabel: View {
    let runsOn: RunsOn
    let installationID: String

    var body: some View {
        let waiting = runsOn.waiting == 1 ? "1 waiting" : "\(runsOn.waiting) waiting"
        let text = runsOn.text(thisInstallation: installationID)
        let shown = runsOn.waiting > 0 ? "\(text) · \(waiting)" : text
        Label(shown, systemImage: runsOn.phone ? "iphone" : "cloud")
            .font(Typography.caption)
            .foregroundStyle(Palette.textSecondary)
            // One element that reads the words, not the symbol's name.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(shown)
    }
}
