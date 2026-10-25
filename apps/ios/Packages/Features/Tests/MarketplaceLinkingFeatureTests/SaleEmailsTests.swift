import APIClient
import DesignSystem
import Foundation
import Synchronization
import Testing
@testable import MarketplaceLinkingFeature

/// The sale emails section: the server's forwarding setup as the contract sends it, and the
/// "Ask before delisting" switch, which always shows what the server saved.
@MainActor
struct SaleEmailsTests {
    private actor FakeSaleEmails: SaleEmailsService {
        var current: SaleEmailForwarding
        var failures: [APIFailure] = []
        private(set) var saved: [Bool] = []

        init(_ current: SaleEmailForwarding) {
            self.current = current
        }

        func fail(with failure: APIFailure) {
            failures.append(failure)
        }

        func get() async throws(APIFailure) -> SaleEmailForwarding {
            if !failures.isEmpty {
                throw failures.removeFirst()
            }
            return current
        }

        func setAskBeforeDelist(_ ask: Bool) async throws(APIFailure) -> SaleEmailForwarding {
            saved.append(ask)
            if !failures.isEmpty {
                throw failures.removeFirst()
            }
            current = SaleEmailForwarding(
                address: current.address,
                isAvailable: current.isAvailable,
                statusLabel: current.statusLabel,
                statusTone: current.statusTone,
                askBeforeDelist: ask,
                steps: current.steps,
                filter: current.filter,
            )
            return current
        }
    }

    private static let forwarding = SaleEmailForwarding(
        address: "sales+abcdefghijklmnopqrst@in.listora.test",
        isAvailable: true,
        statusLabel: "Not set up",
        statusTone: .actionNeeded,
        askBeforeDelist: false,
        steps: ["Copy your Listora address."],
        filter: "from:(poshmark.com) subject:(sold)",
    )

    @Test
    func `the switch shows what the server saved, and a failed save keeps the old value`() async {
        let service = FakeSaleEmails(Self.forwarding)
        let model = SaleEmailsModel(service: service)
        await model.load()
        #expect(model.forwarding?.address == "sales+abcdefghijklmnopqrst@in.listora.test")

        await model.setAskBeforeDelist(true)
        #expect(model.forwarding?.askBeforeDelist == true)
        #expect(model.problem == nil)

        await service.fail(with: .networkUnavailable)
        await model.setAskBeforeDelist(false)
        #expect(model.forwarding?.askBeforeDelist == true)
        #expect(model.problem == .networkUnavailable)
        #expect(await service.saved == [true, false])
    }

    @Test
    func `a section that could not be read says so`() async {
        let service = FakeSaleEmails(Self.forwarding)
        await service.fail(with: .networkUnavailable)
        let model = SaleEmailsModel(service: service)
        await model.load()
        #expect(model.forwarding == nil)
        #expect(model.problem == .networkUnavailable)
        await model.load()
        #expect(model.forwarding != nil)
        #expect(model.problem == nil)
    }

    /// One canned answer for every request, on a host only this test uses.
    private final class CannedServer: StubServer {
        let host = "\(UUID().uuidString.lowercased()).sale-emails.test"
        private let reply: StubReply

        init(body: String) {
            reply = StubReply(status: 200, body: Data(body.utf8))
        }

        func reply(to _: StubRequest) -> StubReply? {
            reply
        }
    }

    @Test
    func `reads the server's forwarding setup, and only an https confirmation link`() async throws {
        let server = CannedServer(body: """
        {"address":"sales+abcdefghijklmnopqrst@in.listora.test","status":"confirming",
         "statusDisplay":{"tone":"action_needed","label":"Confirm forwarding","detail":"Enter the code."},
         "askBeforeDelist":true,"steps":["Copy your Listora address.","Add it in Gmail."],
         "filter":"from:(poshmark.com) subject:(sold)",
         "confirmation":{"provider":"Gmail","code":"418273645","url":"https://mail-settings.google.com/mail/vf-x",
                         "receivedAt":"2026-10-24T12:00:00Z"},
         "lastEmailAt":"2026-10-24T12:00:00Z"}
        """)
        StubURLProtocol.register(server, hosts: [server.host])
        let grant = AccessGrant(accessToken: "token", expiresAt: .distantFuture, email: "a@b.c")
        let api = try APIClient(
            baseURL: #require(URL(string: "https://\(server.host)")),
            accessTokens: AccessTokenStore(storage: InMemoryAccessGrantStorage(grant)),
            session: URLSession(configuration: StubURLProtocol.configuration()),
        )
        let forwarding = try await APISaleEmailsService(api: api).get()
        #expect(forwarding.isAvailable)
        #expect(forwarding.statusLabel == "Confirm forwarding")
        #expect(forwarding.statusTone == .actionNeeded)
        #expect(forwarding.askBeforeDelist)
        #expect(forwarding.steps.count == 2)
        #expect(forwarding.confirmation == SaleEmailForwarding.Confirmation(
            provider: "Gmail",
            code: "418273645",
            url: URL(string: "https://mail-settings.google.com/mail/vf-x"),
        ))
    }
}
