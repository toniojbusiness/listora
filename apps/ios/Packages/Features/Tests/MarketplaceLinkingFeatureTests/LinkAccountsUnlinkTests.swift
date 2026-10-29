import APIClient
import Foundation
import Testing
@testable import MarketplaceLinkingFeature

/// Unlinking from Link accounts against the scripted service (`FakeSessionService`): it waits for
/// the confirmation, and shows a marketplace as not linked only once the server unlinked it.
@MainActor
struct LinkAccountsUnlinkTests {
    @Test
    func `unlinks only after the user confirms, then shows the server's state`() async throws {
        let service = FakeSessionService(
            list: [.poshmark(.linked)],
            link: .poshmark(.checking),
            polls: [.poshmark(.notLinked)],
        )
        let model = makeModel(service)
        await model.load()
        let poshmark = try #require(model.links.first)
        #expect(poshmark.canUnlink)

        model.requestUnlink(poshmark)
        #expect(model.confirmingUnlink == poshmark)
        model.cancelUnlink()
        #expect(model.confirmingUnlink == nil)
        #expect(await service.unlinked.isEmpty)

        model.requestUnlink(poshmark)
        // Dismissing the confirmation clears it before its button acts.
        model.cancelUnlink()
        await model.confirmUnlink(poshmark)
        #expect(await service.unlinked == ["poshmark"])
        #expect(model.confirmingUnlink == nil)
        #expect(model.progress.isEmpty)
        #expect(model.links.first?.state == .notLinked)
        #expect(model.links.first?.canUnlink == false)
    }

    @Test
    func `the confirmation says plainly what goes and what stays`() {
        let message = MarketplaceLink.poshmark(.linked).unlinkMessage
        #expect(message.contains("removes everything it has from Poshmark"))
        #expect(message.contains("your Poshmark listings, items that came only from Poshmark"))
        #expect(message.contains("Poshmark sales and offers with their Pack check orders"))
        #expect(message.contains("Items you made in Listora or listed elsewhere stay"))
        #expect(message.contains("Nothing changes on Poshmark itself"))
        #expect(!message.contains("sales stay"))
    }

    @Test
    func `keeps showing linked when the unlink failed, and retries it`() async throws {
        let service = FakeSessionService(
            list: [.mercari(.needsRelink(message: "Mercari logged Listora out."))],
            link: .mercari(.checking),
            polls: [.mercari(.notLinked)],
            unlinkFailures: [.networkUnavailable],
        )
        let model = makeModel(service)
        await model.load()
        let mercari = try #require(model.links.first)
        model.requestUnlink(mercari)
        await model.confirmUnlink(mercari)

        #expect(model.progress["mercari"] == .unlinkFailed(.networkUnavailable))
        #expect(model.links.first?.state == .needsRelink(message: "Mercari logged Listora out."))
        await model.retryUnlink("mercari")
        #expect(await service.unlinked == ["mercari", "mercari"])
        #expect(model.progress.isEmpty)
        #expect(model.links.first?.state == .notLinked)
    }

    @Test
    func `shows not linked after a confirmed unlink even when the fresh read fails`() async throws {
        let service = FakeSessionService(
            list: [.depop(.linked)],
            link: .depop(.checking),
            polls: [],
            getFailure: .networkUnavailable,
        )
        let model = makeModel(service)
        await model.load()
        let depop = try #require(model.links.first)
        model.requestUnlink(depop)
        await model.confirmUnlink(depop)
        #expect(model.links.first?.state == .notLinked)
        #expect(model.links.first?.statusLabel == "Not linked")
    }

    @Test
    func `offers no unlink for a marketplace that is not linked`() async throws {
        let service = FakeSessionService(list: [.depop(.notLinked)], link: .depop(.checking), polls: [])
        let model = makeModel(service)
        await model.load()
        let depop = try #require(model.links.first)
        #expect(!depop.canUnlink)
        model.requestUnlink(depop)
        #expect(model.confirmingUnlink == nil)
    }

    private func makeModel(_ service: FakeSessionService) -> LinkAccountsModel {
        LinkAccountsModel(service: service, pollInterval: .zero, maxPolls: 10, sleep: { _ in })
    }
}
