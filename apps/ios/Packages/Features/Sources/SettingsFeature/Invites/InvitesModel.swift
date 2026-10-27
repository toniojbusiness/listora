import APIClient
import Foundation
import ListoraAPI
import Observation

/// Settings > People (docs/features/invites.md): the owner's invites and the people who joined
/// through them. Inviting creates a one-time code to share; each person who signs up with it gets
/// their own, separate Listora account. Revoking an invite stops it, or turns off the person's
/// access (their data is kept, and Restore gives it back). Every state shown is the server's.
@MainActor
@Observable
public final class InvitesModel {
    public enum Phase: Equatable {
        case idle
        case loading
        case loaded
        /// The list could not be read; `message` is safe to show.
        case failed(message: String)
    }

    /// How long a new invite works before someone redeems it; nil never expires.
    public enum Expiry: Int, CaseIterable, Identifiable, Sendable {
        case oneDay = 1
        case oneWeek = 7
        case oneMonth = 30
        case never = 0

        public var id: Int {
            rawValue
        }

        public var label: String {
            switch self {
            case .oneDay: "1 day"
            case .oneWeek: "7 days"
            case .oneMonth: "30 days"
            case .never: "Never"
            }
        }

        var days: Int32? {
            self == .never ? nil : Int32(rawValue)
        }
    }

    public private(set) var phase: Phase = .idle
    /// Only the account that set up this Listora may invite; Settings shows People only then.
    public private(set) var canInvite = false
    public private(set) var invites: [Components.Schemas.Invite] = []
    /// The invite just created, with its code: shown once, to share.
    public private(set) var created: Components.Schemas.CreatedInvite?
    public private(set) var isCreating = false
    public private(set) var createProblem: String?
    /// The invites whose revoke or restore is in flight.
    public private(set) var working: Set<String> = []
    /// Why the last revoke or restore did not work; nothing changed.
    public private(set) var actionProblem: String?

    private let service: any InvitesService
    /// Reused until a create succeeds, so a retry after a lost answer makes no second invite.
    private var createKey: String?

    public init(service: any InvitesService) {
        self.service = service
    }

    /// The people who joined (redeemed or signed in), for the Settings row.
    public var peopleCount: Int {
        invites.count { $0.email != nil && $0.status.value1 != .revoked }
    }

    public func load() async {
        if phase != .loaded {
            phase = .loading
        }
        do {
            let list = try await service.list()
            canInvite = list.canInvite
            invites = list.data
            phase = .loaded
        } catch {
            phase = .failed(message: error.message)
        }
    }

    public func create(label: String, expiry: Expiry) async {
        guard !isCreating else { return }
        isCreating = true
        createProblem = nil
        defer { isCreating = false }
        let key = createKey ?? UUID().uuidString
        createKey = key
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let invite = try await service.create(
                .init(label: trimmed.isEmpty ? nil : String(trimmed.prefix(100)), expiresInDays: expiry.days),
                idempotencyKey: key,
            )
            createKey = nil
            created = invite
            invites.insert(invite.invite, at: 0)
        } catch {
            createProblem = error.message
        }
    }

    /// Forgets the last person's invites when they sign out.
    public func signedOut() {
        phase = .idle
        canInvite = false
        invites = []
        actionProblem = nil
        finishCreating()
    }

    /// Done with the code; a new invite starts afresh.
    public func finishCreating() {
        created = nil
        createProblem = nil
        createKey = nil
    }

    public func revoke(_ invite: Components.Schemas.Invite) async {
        await act(on: invite) { key throws(APIFailure) in try await self.service.revoke(
            id: invite.id,
            idempotencyKey: key,
        ) }
    }

    public func restore(_ invite: Components.Schemas.Invite) async {
        await act(on: invite) { key throws(APIFailure) in try await self.service.restore(
            id: invite.id,
            idempotencyKey: key,
        ) }
    }

    public func can(_ action: Components.Schemas.KnownInviteAction, _ invite: Components.Schemas.Invite) -> Bool {
        invite.availableActions.contains { $0.value1 == action }
    }

    private func act(
        on invite: Components.Schemas.Invite,
        _ call: @escaping @MainActor (String) async throws(APIFailure) -> Components.Schemas.Invite,
    ) async {
        guard !working.contains(invite.id) else { return }
        working.insert(invite.id)
        actionProblem = nil
        defer { working.remove(invite.id) }
        do {
            let updated = try await call(UUID().uuidString)
            if let index = invites.firstIndex(where: { $0.id == updated.id }) {
                invites[index] = updated
            }
        } catch {
            actionProblem = error.message
        }
    }
}

extension Components.Schemas.Invite {
    /// "Maria", or "Invite …H8RA" when it has no label.
    public var title: String {
        label ?? "Invite …\(codeHint)"
    }
}
