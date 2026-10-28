import DesignSystem
import ListoraAPI
import SwiftUI
import UIKit

/// Settings > People: invite someone to their own Listora, and see and manage who joined.
struct InvitesView: View {
    @Bindable var model: InvitesModel
    @State private var isInviting = false
    @State private var confirmingRevoke: Components.Schemas.Invite?

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    Text("Each person you invite gets their own Listora: their own items, linked marketplaces, "
                        + "sales, and settings. They can't see yours, and you can't see theirs.")
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Invite someone", systemImage: "person.badge.plus") { isInviting = true }
                        .buttonStyle(.listoraPrimary)
                        .disabled(!model.canInvite)
                        .accessibilityIdentifier("invites.new")
                }
                .padding(.vertical, Spacing.xs)
            }
            .listRowBackground(Palette.surface.color)
            if let problem = model.actionProblem {
                Section {
                    Banner("That didn't work", message: problem, tone: .failed, identifier: "invites.actionProblem")
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            invitesSection
        }
        .scrollContentBackground(.hidden)
        .background(Palette.background)
        .navigationTitle("People")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load() }
        .task { await model.load() }
        .sheet(isPresented: $isInviting, onDismiss: { model.finishCreating() }, content: {
            NewInviteSheet(model: model) { isInviting = false }
        })
        .confirmationDialog(
            confirmingRevoke.map(revokeTitle) ?? "",
            isPresented: Binding(get: { confirmingRevoke != nil }, set: {
                if !$0 {
                    confirmingRevoke = nil
                }
            }),
            titleVisibility: .visible,
            presenting: confirmingRevoke,
        ) { invite in
            Button(invite.email == nil ? "Revoke invite" : "Turn off access", role: .destructive) {
                Task { await model.revoke(invite) }
            }
            .accessibilityIdentifier("invites.revoke.confirm")
            Button("Cancel", role: .cancel) {}
        } message: { invite in
            Text(invite.email == nil
                ? "The code stops working."
                : "\(invite.email ?? "") can't sign in to Listora any more. Their account and data are kept, "
                + "so you can restore their access later.")
        }
    }

    @ViewBuilder
    private var invitesSection: some View {
        switch model.phase {
        case .idle, .loading:
            Section {
                ProgressView()
                    .frame(maxWidth: .infinity)
            }
            .listRowBackground(Color.clear)
        case let .failed(message):
            Section {
                Banner(
                    "Couldn't load your invites",
                    message: message,
                    tone: .failed,
                    action: .init("Try again", identifier: "invites.retry") { Task { await model.load() } },
                    identifier: "invites.loadFailed",
                )
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        case .loaded where model.invites.isEmpty:
            Section {
                Text("No invites yet.")
                    .font(Typography.subheadline)
                    .foregroundStyle(Palette.textSecondary)
                    .accessibilityIdentifier("invites.empty")
            }
            .listRowBackground(Palette.surface.color)
        case .loaded:
            Section {
                ForEach(model.invites, id: \.id) { invite in
                    row(invite)
                }
            } header: {
                SectionHeader("Invites")
            }
            .listRowBackground(Palette.surface.color)
        }
    }

    private func row(_ invite: Components.Schemas.Invite) -> some View {
        HStack(alignment: .top, spacing: Spacing.md) {
            VStack(alignment: .leading, spacing: Spacing.xxs) {
                Text(invite.title)
                    .font(Typography.headline)
                    .foregroundStyle(Palette.textPrimary)
                if let email = invite.email {
                    Text(email)
                        .font(Typography.subheadline)
                        .foregroundStyle(Palette.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                StatusBadge(invite.statusDisplay.label, tone: StatusTone(invite.statusDisplay.tone))
                if let detail = invite.statusDisplay.detail {
                    Text(detail)
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let expiresAt = invite.expiresAt, invite.status.value1 == .open {
                    Text("Works until \(expiresAt.formatted(date: .abbreviated, time: .shortened))")
                        .font(Typography.footnote)
                        .foregroundStyle(Palette.textSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            actions(invite)
        }
        .padding(.vertical, Spacing.xxs)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("invites.row.\(invite.codeHint)")
    }

    @ViewBuilder
    private func actions(_ invite: Components.Schemas.Invite) -> some View {
        let busy = model.working.contains(invite.id)
        if model.can(.revoke, invite) {
            Button(invite.email == nil ? "Revoke" : "Turn off") { confirmingRevoke = invite }
                .buttonStyle(.listora(.destructiveText, size: .compact))
                .disabled(busy)
                .loading(busy)
                .accessibilityIdentifier("invites.revoke")
        } else if model.can(.restore, invite) {
            Button("Restore") { Task { await model.restore(invite) } }
                .buttonStyle(.listora(.secondary, size: .compact))
                .disabled(busy)
                .loading(busy)
                .accessibilityIdentifier("invites.restore")
        }
    }

    private func revokeTitle(_ invite: Components.Schemas.Invite) -> String {
        invite.email == nil ? "Revoke \(invite.title)?" : "Turn off \(invite.title)'s access?"
    }
}

/// A new invite: who it is for and how long it works, then its code to share, shown only now.
private struct NewInviteSheet: View {
    @Bindable var model: InvitesModel
    let onDone: () -> Void
    @State private var label = ""
    @State private var expiry: InvitesModel.Expiry = .oneWeek
    @State private var copied = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    if let created = model.created {
                        share(created)
                    } else {
                        form
                    }
                }
                .padding(Spacing.md)
                .frame(maxWidth: Layout.readableWidth, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .background(Palette.background)
            .navigationTitle(model.created == nil ? "Invite someone" : "Share the invite")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: model.created == nil ? .cancellationAction : .confirmationAction) {
                    Button(model.created == nil ? "Cancel" : "Done", action: onDone)
                        .accessibilityIdentifier("invites.sheet.done")
                }
            }
            .bottomActionBar {
                if let created = model.created {
                    ShareLink(item: created.message) {
                        Label("Share invite", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(.listoraPrimary)
                    .accessibilityIdentifier("invites.share")
                } else {
                    Button("Create invite") { Task { await model.create(label: label, expiry: expiry) } }
                        .buttonStyle(.listoraPrimary)
                        .loading(model.isCreating)
                        .disabled(model.isCreating)
                        .accessibilityIdentifier("invites.create")
                }
            }
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            ListoraTextField("Who is it for?", hint: "Optional. Only you see it, in your list of invites.") {
                TextField(
                    "Who is it for?",
                    text: $label,
                    prompt: Text(verbatim: "Maria").foregroundStyle(Palette.textSecondary),
                )
                .textInputAutocapitalization(.words)
                .accessibilityIdentifier("invites.label")
            }
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text("Code works for")
                    .font(Typography.label)
                    .foregroundStyle(Palette.textSecondary)
                Picker("Code works for", selection: $expiry) {
                    ForEach(InvitesModel.Expiry.allCases) { option in
                        Text(option.label).tag(option)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("invites.expiry")
                Text("Once they've used it, it no longer expires.")
                    .font(Typography.footnote)
                    .foregroundStyle(Palette.textSecondary)
            }
            if let problem = model.createProblem {
                Banner(
                    "The invite wasn't created",
                    message: problem,
                    tone: .failed,
                    identifier: "invites.createProblem",
                )
            }
        }
        .cardStyle(.elevated)
    }

    private func share(_ created: Components.Schemas.CreatedInvite) -> some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text("Send this code to \(created.invite.label ?? "the person you're inviting") only. They sign up in "
                + "the Listora app with it and their own email.")
                .font(Typography.body)
                .foregroundStyle(Palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            VStack(spacing: Spacing.sm) {
                Text(created.code)
                    .font(Typography.keypad.monospaced())
                    .foregroundStyle(Palette.textPrimary)
                    .textSelection(.enabled)
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                    .accessibilityLabel("Invite code")
                    .accessibilityValue(created.code.map(String.init).joined(separator: " "))
                    .accessibilityIdentifier("invites.code")
                Button(copied ? "Copied" : "Copy code", systemImage: copied ? "checkmark" : "doc.on.doc") {
                    UIPasteboard.general.string = created.code
                    copied = true
                }
                .buttonStyle(.listoraTertiary)
                .accessibilityIdentifier("invites.copy")
            }
            .frame(maxWidth: .infinity)
            .cardStyle(.elevated)
            Text("This is the only time Listora shows the code. If it's lost, revoke the invite and create a new one.")
                .font(Typography.footnote)
                .foregroundStyle(Palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

extension StatusTone {
    init(_ tone: Components.Schemas.StatusTone) {
        switch tone.value1 {
        case .success: self = .success
        case .inProgress: self = .inProgress
        case .checking: self = .checking
        case .failed: self = .failed
        case .actionNeeded: self = .actionNeeded
        case .neutral, nil: self = .neutral
        }
    }
}
