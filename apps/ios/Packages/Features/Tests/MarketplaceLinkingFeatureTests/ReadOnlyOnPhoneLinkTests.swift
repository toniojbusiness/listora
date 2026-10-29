import APIClient
import Core
import Foundation
import Testing
@testable import MarketplaceLinkingFeature

/// Link accounts and the accounts this phone holds read only (docs/features/read-only.md#on-the-phone):
/// the phone learns each read-only account, shows it read only whatever the server says later, and
/// lets it go only when the seller turns Read only off here.
@MainActor
struct ReadOnlyOnPhoneLinkTests {
    @Test
    func `an account the server shows read only stays read only on this phone`() async {
        let sessions = InMemoryMarketplaceSessionStore()
        let readOnly = MarketplaceLink.depop(.linked).with(readOnly: true)
        let model = makeModel(FakeSessionService(list: [readOnly], link: readOnly, polls: []), sessions)

        await model.load()

        #expect(sessions.isReadOnly("depop"))
        #expect(!sessions.isReadOnly("mercari"))
    }

    @Test
    func `shows read only an account this phone holds so, when the server no longer says it`() async {
        let sessions = InMemoryMarketplaceSessionStore()
        sessions.setReadOnly(true, for: "depop")
        let model = makeModel(FakeSessionService(list: [.depop(.linked)], link: .depop(.linked), polls: []), sessions)

        await model.load()

        #expect(model.links.first?.readOnly == true)
        #expect(sessions.isReadOnly("depop"))
    }

    @Test
    func `turning Read only on holds it on this phone at once`() async throws {
        let sessions = InMemoryMarketplaceSessionStore()
        let service = FakeSessionService(
            list: [.depop(.linked)],
            link: .depop(.linked),
            polls: [MarketplaceLink.depop(.linked).with(readOnly: true)],
        )
        let model = makeModel(service, sessions)
        await model.load()

        try await model.requestReadOnly(#require(model.links.first), true)

        #expect(sessions.isReadOnly("depop"))
    }

    @Test
    func `only turning Read only off here lets this phone change the account again`() async throws {
        let sessions = InMemoryMarketplaceSessionStore()
        sessions.setReadOnly(true, for: "depop")
        let service = FakeSessionService(list: [.depop(.linked)], link: .depop(.linked), polls: [.depop(.linked)])
        let model = makeModel(service, sessions)
        await model.load()
        let depop = try #require(model.links.first)

        await model.requestReadOnly(depop, false)
        #expect(sessions.isReadOnly("depop"), "asking is not turning it off")
        await model.confirmWritable(depop)

        #expect(await service.readOnlyChanges == [.init(marketplace: "depop", readOnly: false)])
        #expect(!sessions.isReadOnly("depop"))
        #expect(model.links.first?.readOnly == false)
    }

    @Test
    func `keeps it held when turning it off did not go through`() async throws {
        let sessions = InMemoryMarketplaceSessionStore()
        let readOnly = MarketplaceLink.depop(.linked).with(readOnly: true)
        let service = FakeSessionService(
            list: [readOnly],
            link: readOnly,
            polls: [],
            readOnlyFailure: .networkUnavailable,
        )
        let model = makeModel(service, sessions)
        await model.load()
        let depop = try #require(model.links.first)

        await model.requestReadOnly(depop, false)
        await model.confirmWritable(depop)

        #expect(model.progress["depop"] == .readOnlyFailed(.networkUnavailable))
        #expect(sessions.isReadOnly("depop"))
    }

    private func makeModel(
        _ service: FakeSessionService,
        _ sessions: InMemoryMarketplaceSessionStore,
    ) -> LinkAccountsModel {
        LinkAccountsModel(
            service: service,
            sessions: sessions,
            installationID: "installation-1",
            makeIdempotencyKey: { UUID().uuidString },
            pollInterval: .zero,
            maxPolls: 1,
            sleep: { _ in },
        )
    }
}
