import Core
import Foundation
import Testing
@testable import MarketplaceLinkingFeature

/// Linking a marketplace that runs on this phone (docs/features/phone-execution.md): the phone
/// keeps the sign-in, Listora knows the phone first, and the phone checks the session at once.
@MainActor
struct LinkAccountsPhoneTests {
    @Test
    func `keeps the sign-in on this phone, which checks it at once when the marketplace runs here`() async throws {
        let here = RunsOn(
            label: "Runs on your iPhone",
            phone: true,
            installationID: "install-1",
            deviceName: nil,
            waiting: 1,
        )
        let service = FakeSessionService(
            list: [.depop(.notLinked)],
            link: .depop(.checking, runsOn: here),
            polls: [.depop(.linked, runsOn: here)],
        )
        let sessions = InMemoryMarketplaceSessionStore()
        let trigger = FakePhoneWork()
        let model = makeModel(service, sessions: sessions, phoneWork: trigger)
        await model.load()
        let depop = try #require(model.links.first)

        await model.finishSignIn(depop, cookies: [
            cookie("access_token", "session-token", domain: ".depop.com"),
            cookie("_ga", "tracker", domain: ".google.com"),
        ])

        // The phone keeps only Depop's own cookies, and the server learns which phone signed in.
        #expect(sessions.cookies(for: "depop").map(\.name) == ["access_token"])
        #expect(await service.sentLinks.map(\.installationID) == ["install-1"])
        // Listora knew this phone before the link named it.
        #expect(trigger.prepared == 1)
        #expect(trigger.reasons == [.userAction])
        let linked = try #require(model.links.first)
        #expect(linked.state == .linked)
        #expect(linked.runsOn?.text(thisInstallation: model.installationID) == "Runs on this iPhone")
    }

    @Test
    func `a marketplace that runs in the cloud is checked there, not on this phone`() async throws {
        let cloud = RunsOn(
            label: "Runs in Listora's cloud",
            phone: false,
            installationID: nil,
            deviceName: nil,
            waiting: 0,
        )
        let service = FakeSessionService(
            list: [.depop(.notLinked)],
            link: .depop(.checking, runsOn: cloud),
            polls: [.depop(.linked, runsOn: cloud)],
        )
        let trigger = FakePhoneWork()
        let model = makeModel(service, sessions: InMemoryMarketplaceSessionStore(), phoneWork: trigger)
        await model.load()
        try await model.finishSignIn(#require(model.links.first), cookies: [
            cookie("access_token", "session-token", domain: ".depop.com"),
        ])

        #expect(trigger.reasons.isEmpty)
        #expect(model.links.first?.runsOn?.text(thisInstallation: model.installationID) == "Runs in Listora's cloud")
    }

    @Test
    func `names the other phone a marketplace runs on`() {
        let there = RunsOn(
            label: "Runs on your iPhone",
            phone: true,
            installationID: "other",
            deviceName: "Sam's iPhone",
            waiting: 0,
        )
        #expect(there.text(thisInstallation: "install-1") == "Runs on Sam's iPhone")
    }

    @Test
    func `unlinking removes the session this phone kept`() async throws {
        let service = FakeSessionService(list: [.depop(.linked)], link: .depop(.linked), polls: [.depop(.notLinked)])
        let kept = StoredCookie(
            name: "access_token",
            value: "session-token",
            domain: ".depop.com",
            path: "/",
            expires: nil,
            secure: true,
            httpOnly: true,
            sameSite: nil,
        )
        let sessions = InMemoryMarketplaceSessionStore(["depop": [kept]])
        let model = makeModel(service, sessions: sessions, phoneWork: FakePhoneWork())
        await model.load()

        try await model.confirmUnlink(#require(model.links.first))

        #expect(await service.unlinked == ["depop"])
        #expect(sessions.cookies(for: "depop").isEmpty)
    }

    private func makeModel(
        _ service: FakeSessionService,
        sessions: any MarketplaceSessionStore,
        phoneWork: FakePhoneWork,
    ) -> LinkAccountsModel {
        LinkAccountsModel(
            service: service,
            sessions: sessions,
            phoneWork: phoneWork,
            installationID: "install-1",
            makeIdempotencyKey: { UUID().uuidString },
            pollInterval: .zero,
            maxPolls: 10,
            sleep: { _ in },
        )
    }
}

/// Records what asked the phone to run its work.
@MainActor
final class FakePhoneWork: PhoneWorkTrigger {
    private(set) var reasons: [PhoneWorkReason] = []
    private(set) var prepared = 0

    func runPhoneWork(_ reason: PhoneWorkReason) {
        reasons.append(reason)
    }

    func prepareForWork() async {
        prepared += 1
    }
}
