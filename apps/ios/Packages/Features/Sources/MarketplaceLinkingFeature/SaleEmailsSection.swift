import DesignSystem
import SwiftUI
import UIKit

/// Link accounts' sale emails section: the account's forwarding address with one-tap copy, the
/// setup steps and the forwarding filter, the email provider's confirmation (its code to copy,
/// and its link to open on a tap), the server's status, and "Ask before delisting".
struct SaleEmailsSection: View {
    let model: SaleEmailsModel
    @State private var copied: String?
    @Environment(\.openURL) private var openURL

    var body: some View {
        Section {
            if let forwarding = model.forwarding {
                content(forwarding)
            } else if let problem = model.problem {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Text(problem.message)
                        .font(Typography.callout)
                        .foregroundStyle(Palette.danger)
                        .accessibilityIdentifier("saleEmails.loadError")
                    Button("Try again") { Task { await model.load() } }
                        .font(Typography.callout)
                        .accessibilityIdentifier("saleEmails.reload")
                }
            } else {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    SkeletonBlock(width: 220, height: 16)
                    SkeletonBlock(height: 12)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Loading the forwarding address")
            }
        } header: {
            Text("Sale emails")
        } footer: {
            Text(
                "Listora reads only the Poshmark, Mercari, and Depop sold emails sent to this address, "
                    + "checks they really come from the marketplace, and keeps only what sold.",
            )
        }
        .listRowBackground(Palette.surface.color)
    }

    @ViewBuilder
    private func content(_ forwarding: SaleEmailForwarding) -> some View {
        status(forwarding)
        if let address = forwarding.address {
            copyRow(label: "Your Listora address", value: address, identifier: "address")
            if let confirmation = forwarding.confirmation {
                confirmationRow(confirmation)
            }
            setupSteps(forwarding)
            askBeforeDelisting(forwarding)
            if let problem = model.problem {
                Text(problem.message)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.danger)
                    .accessibilityIdentifier("saleEmails.error")
            }
        }
    }

    /// The server's status, and when the latest sale email arrived.
    private func status(_ forwarding: SaleEmailForwarding) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            StatusLabel(forwarding.statusLabel, tone: forwarding.statusTone)
                .accessibilityIdentifier("saleEmails.status")
            if let detail = forwarding.statusDetail {
                Text(detail)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let last = forwarding.lastSaleEmailAt {
                Text("Last sale email \(last.formatted(date: .abbreviated, time: .shortened))")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityIdentifier("saleEmails.lastSale")
            }
        }
        .padding(.vertical, Spacing.xxs)
    }

    private func setupSteps(_ forwarding: SaleEmailForwarding) -> some View {
        DisclosureGroup("How to set it up") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                ForEach(Array(forwarding.steps.enumerated()), id: \.offset) { index, step in
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                        Text("\(index + 1).")
                            .font(Typography.callout)
                            .foregroundStyle(Palette.brand)
                        Text(step)
                            .font(Typography.callout)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                copyRow(label: "Filter", value: forwarding.filter, identifier: "filter")
            }
            .padding(.vertical, Spacing.xxs)
        }
        .accessibilityIdentifier("saleEmails.steps")
    }

    private func askBeforeDelisting(_ forwarding: SaleEmailForwarding) -> some View {
        Toggle(isOn: Binding(
            get: { forwarding.askBeforeDelist },
            set: { ask in Task { await model.setAskBeforeDelist(ask) } },
        )) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text("Ask before delisting")
                Text("A sale email makes a task for you to confirm before Listora delists the item elsewhere.")
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .tint(Palette.brand.color)
        .disabled(model.isSaving)
        .accessibilityIdentifier("saleEmails.askBeforeDelist")
    }

    private func copyRow(label: String, value: String, identifier: String) -> some View {
        HStack(alignment: .center, spacing: Spacing.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.textSecondary)
                Text(value)
                    .font(Typography.code)
                    .foregroundStyle(Palette.textPrimary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("saleEmails.\(identifier)")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            let isCopied = copied == identifier
            Button(isCopied ? "Copied" : "Copy", systemImage: isCopied ? "checkmark" : "doc.on.doc") {
                UIPasteboard.general.string = value
                copied = identifier
            }
            .buttonStyle(.listora(.secondary, size: .compact))
            .accessibilityLabel(isCopied ? "\(label) copied" : "Copy \(label.lowercased())")
            .accessibilityIdentifier("saleEmails.copy.\(identifier)")
        }
        .padding(.vertical, Spacing.xxs)
    }

    @ViewBuilder
    private func confirmationRow(_ confirmation: SaleEmailForwarding.Confirmation) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Label("\(confirmation.provider) sent a confirmation", systemImage: "envelope.badge")
                .font(Typography.headline)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(confirmation.provider) sent a confirmation")
                .accessibilityIdentifier("saleEmails.confirmation")
            Text("Confirm the forwarding in \(confirmation.provider) to start: enter the code there, or open the link.")
                .font(Typography.caption)
                .foregroundStyle(Palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, Spacing.xxs)
        if let code = confirmation.code {
            copyRow(label: "Confirmation code", value: code, identifier: "code")
        }
        if let url = confirmation.url {
            Button("Open \(confirmation.provider)'s link", systemImage: "arrow.up.right.square") {
                openURL(url)
            }
            .accessibilityIdentifier("saleEmails.confirmationLink")
        }
    }
}
