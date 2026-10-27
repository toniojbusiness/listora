import APIClient
import Foundation
import ListoraAPI
import Testing
@testable import SettingsFeature

/// Settings > People: the owner's invites, creating one to share, and revoking or restoring it;
/// every state shown is the server's.
@MainActor
struct InvitesModelTests {
    private final class FakeService: InvitesService, @unchecked Sendable {
        var list: Result<Components.Schemas.InviteList, APIFailure>
        var created: Result<Components.Schemas.CreatedInvite, APIFailure>
        var changed: Result<Components.Schemas.Invite, APIFailure>
        var createKeys: [String] = []
        var calls: [String] = []

        init(
            list: Result<Components.Schemas.InviteList, APIFailure>,
            created: Result<Components.Schemas.CreatedInvite, APIFailure> = .failure(.networkUnavailable),
            changed: Result<Components.Schemas.Invite, APIFailure> = .failure(.networkUnavailable),
        ) {
            self.list = list
            self.created = created
            self.changed = changed
        }

        func list() async throws(APIFailure) -> Components.Schemas.InviteList {
            try list.get()
        }

        func create(
            _ invite: Components.Schemas.InviteCreate,
            idempotencyKey: String,
        ) async throws(APIFailure) -> Components.Schemas.CreatedInvite {
            createKeys.append(idempotencyKey)
            calls.append("create \(invite.label ?? "-") \(invite.expiresInDays.map(String.init) ?? "never")")
            return try created.get()
        }

        func revoke(id: String, idempotencyKey _: String) async throws(APIFailure) -> Components.Schemas.Invite {
            calls.append("revoke \(id)")
            return try changed.get()
        }

        func restore(id: String, idempotencyKey _: String) async throws(APIFailure) -> Components.Schemas.Invite {
            calls.append("restore \(id)")
            return try changed.get()
        }
    }

    private static func invite(
        _ id: String,
        _ status: Components.Schemas.KnownInviteStatus,
        email: String? = nil,
        actions: [Components.Schemas.KnownInviteAction] = [.revoke],
    ) -> Components.Schemas.Invite {
        .init(
            id: id,
            label: "Maria",
            codeHint: "H8RA",
            status: .init(value1: status),
            statusDisplay: .init(tone: .init(value1: .neutral), label: "\(status)"),
            email: email,
            availableActions: actions.map { .init(value1: $0) },
            createdAt: Date(),
        )
    }

    private static let offline = APIFailure(
        statusCode: nil, code: "network_unavailable", message: "Can't reach Listora.", retryable: true,
    )

    @Test
    func `loads the invites, and whether this account may invite`() async {
        let service = FakeService(list: .success(.init(
            canInvite: true,
            data: [Self.invite("a", .active, email: "maria@example.com"), Self.invite("b", .open)],
        )))
        let model = InvitesModel(service: service)
        await model.load()
        #expect(model.phase == .loaded)
        #expect(model.canInvite)
        #expect(model.invites.map(\.id) == ["a", "b"])
        #expect(model.peopleCount == 1)

        service.list = .failure(Self.offline)
        let failing = InvitesModel(service: service)
        await failing.load()
        #expect(failing.phase == .failed(message: "Can't reach Listora."))
        #expect(!failing.canInvite)
    }

    @Test
    func `creates an invite once, retrying with the same key after a failure`() async {
        let service = FakeService(
            list: .success(.init(canInvite: true, data: [])),
            created: .failure(Self.offline),
        )
        let model = InvitesModel(service: service)
        await model.load()

        await model.create(label: "  Maria ", expiry: .oneWeek)
        #expect(model.createProblem == "Can't reach Listora.")
        #expect(model.created == nil)

        let created = Components.Schemas.CreatedInvite(
            invite: Self.invite("new", .open),
            code: "K7QD-3M9P-XW2T-H8RA",
            link: "listora://invite/K7QD-3M9P-XW2T-H8RA",
            message: "Hi Maria! ...",
        )
        service.created = .success(created)
        await model.create(label: "  Maria ", expiry: .oneWeek)
        #expect(model.created == created)
        #expect(model.invites.map(\.id) == ["new"])
        #expect(service.createKeys.count == 2)
        #expect(service.createKeys[0] == service.createKeys[1])
        #expect(service.calls == ["create Maria 7", "create Maria 7"])

        model.finishCreating()
        #expect(model.created == nil)
        await model.create(label: "", expiry: .never)
        #expect(service.calls.last == "create - never")
        #expect(service.createKeys.last != service.createKeys.first)
    }

    @Test
    func `shows the server's state after revoking or restoring, and nothing changed on a failure`() async {
        let active = Self.invite("a", .active, email: "maria@example.com")
        let service = FakeService(list: .success(.init(canInvite: true, data: [active])))
        let model = InvitesModel(service: service)
        await model.load()
        #expect(model.can(.revoke, active))
        #expect(!model.can(.restore, active))

        await model.revoke(active)
        #expect(model.actionProblem == "Can't reach Listora.")
        #expect(model.invites == [active])

        let revoked = Self.invite("a", .revoked, email: "maria@example.com", actions: [.restore])
        service.changed = .success(revoked)
        await model.revoke(active)
        #expect(model.actionProblem == nil)
        #expect(model.invites == [revoked])
        #expect(model.peopleCount == 0)

        service.changed = .success(active)
        await model.restore(revoked)
        #expect(model.invites == [active])
        #expect(service.calls == ["revoke a", "revoke a", "restore a"])
        #expect(model.working.isEmpty)
    }

    @Test
    func `forgets the last person's invites at sign-out`() async {
        let service = FakeService(list: .success(.init(canInvite: true, data: [Self.invite("a", .open)])))
        let model = InvitesModel(service: service)
        await model.load()
        model.signedOut()
        #expect(model.phase == .idle)
        #expect(!model.canInvite)
        #expect(model.invites.isEmpty)
    }
}
