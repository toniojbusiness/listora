import APIClient
import Foundation
import Testing
@testable import MarketplaceLinkingFeature

/// The Read only switch on Link accounts (docs/features/read-only.md): it shows the server's
/// setting, makes an account read only at once, and asks before Listora may change it again.
@MainActor
struct ReadOnlyLinkTests {
    @Test
    func `makes a linked account read only at once and shows the server's setting`() async throws {
        let service = FakeSessionService(
            list: [.depop(.linked)],
            link: .depop(.linked),
            polls: [MarketplaceLink.depop(.linked).with(readOnly: true)],
        )
        let model = makeModel(service)
        await model.load()
        let depop = try #require(model.links.first)
        #expect(depop.canSetReadOnly)
        #expect(!depop.readOnly)

        await model.requestReadOnly(depop, true)

        #expect(await service.readOnlyChanges == [.init(marketplace: "depop", readOnly: true)])
        #expect(model.confirmingWritable == nil)
        #expect(model.links.first?.readOnly == true)
        #expect(model.progress.isEmpty)
    }

    @Test
    func `asks before Listora may change a read-only account again`() async throws {
        let readOnly = MarketplaceLink.depop(.linked).with(readOnly: true)
        let service = FakeSessionService(
            list: [readOnly],
            link: readOnly,
            polls: [MarketplaceLink.depop(.linked)],
        )
        let model = makeModel(service)
        await model.load()
        let depop = try #require(model.links.first)

        await model.requestReadOnly(depop, false)
        #expect(model.confirmingWritable == depop)
        #expect(await service.readOnlyChanges.isEmpty)
        // Keeping it read only changes nothing.
        model.cancelWritable()
        #expect(model.confirmingWritable == nil)
        #expect(model.links.first?.readOnly == true)

        await model.requestReadOnly(depop, false)
        await model.confirmWritable(depop)
        #expect(await service.readOnlyChanges == [.init(marketplace: "depop", readOnly: false)])
        #expect(model.links.first?.readOnly == false)
    }

    @Test
    func `keeps the setting and says why when the change did not go through`() async throws {
        let service = FakeSessionService(
            list: [.depop(.linked)],
            link: .depop(.linked),
            polls: [],
            readOnlyFailure: .networkUnavailable,
        )
        let model = makeModel(service)
        await model.load()
        let depop = try #require(model.links.first)

        await model.requestReadOnly(depop, true)

        #expect(model.progress["depop"] == .readOnlyFailed(.networkUnavailable))
        #expect(model.links.first?.readOnly == false)
    }

    @Test
    func `offers no switch for a marketplace that is not linked`() async throws {
        let service = FakeSessionService(list: [.depop(.notLinked)], link: .depop(.notLinked), polls: [])
        let model = makeModel(service)
        await model.load()
        let depop = try #require(model.links.first)
        #expect(!depop.canSetReadOnly)
        await model.requestReadOnly(depop, true)
        #expect(await service.readOnlyChanges.isEmpty)
    }

    private func makeModel(_ service: FakeSessionService) -> LinkAccountsModel {
        LinkAccountsModel(
            service: service,
            makeIdempotencyKey: { UUID().uuidString },
            pollInterval: .zero,
            maxPolls: 1,
            sleep: { _ in },
        )
    }
}
