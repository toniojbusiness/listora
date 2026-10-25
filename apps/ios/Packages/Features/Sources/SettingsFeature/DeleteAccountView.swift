import DesignSystem
import SwiftUI

/// Settings > Delete account: what deleting removes and what it leaves, a confirmation, and
/// then the result, including the marketplaces whose access the seller must still remove.
struct DeleteAccountView: View {
    @Bindable var model: AccountDeletionModel
    @State private var isConfirming = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                switch model.phase {
                case let .deleted(revokeManually):
                    deleted(revokeManually)
                case .ready, .deleting, .failed:
                    explanation
                }
            }
            .padding(Spacing.md)
            .frame(maxWidth: Layout.readableWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Palette.background)
        .navigationTitle("Delete account")
        .navigationBarTitleDisplayMode(.inline)
        .bottomActionBar {
            if case .deleted = model.phase {
                EmptyView()
            } else {
                Button("Delete my account", systemImage: "trash", role: .destructive) { isConfirming = true }
                    .buttonStyle(.listora(.destructive, size: .large))
                    .loading(model.phase == .deleting)
                    .disabled(model.phase == .deleting)
                    .accessibilityIdentifier("account.delete")
                    .confirmationDialog(
                        "Delete your Listora account?",
                        isPresented: $isConfirming,
                        titleVisibility: .visible,
                    ) {
                        Button("Delete my account", role: .destructive) { Task { await model.delete() } }
                            .accessibilityIdentifier("account.delete.confirm")
                        Button("Keep my account", role: .cancel) {}
                    } message: {
                        Text("This can't be undone.")
                    }
            }
        }
        .onDisappear {
            if case .failed = model.phase {
                model.reset()
            }
        }
    }

    private var explanation: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text("Deleting your account removes your items, photos, listing records, sales, and history from "
                + "Listora, and signs you out. It can't be undone.")
                .font(Typography.body)
                .foregroundStyle(Palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Text("Listings that are live stay on the marketplaces: end them there if you want them gone. Listora "
                + "asks each connected marketplace to remove its access.")
                .font(Typography.subheadline)
                .foregroundStyle(Palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            if case let .failed(message) = model.phase {
                Banner("Your account wasn't deleted", message: message, tone: .failed, identifier: "account.failed")
            }
        }
    }

    private func deleted(_ revokeManually: [String]) -> some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Banner(
                "Your account is deleted",
                message: "Your data is gone from Listora and you're signed out.",
                tone: .success,
                identifier: "account.deleted",
            )
            if !revokeManually.isEmpty {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Text("Remove Listora's access on these marketplaces")
                        .font(Typography.headline)
                        .foregroundStyle(Palette.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                    Text("They hadn't confirmed it yet. Open each one's connected apps settings and remove Listora.")
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(revokeManually, id: \.self) { name in
                        Label(name, systemImage: "link.badge.plus")
                            .font(Typography.body)
                            .foregroundStyle(Palette.textPrimary)
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("account.revokeManually")
            }
        }
    }
}
