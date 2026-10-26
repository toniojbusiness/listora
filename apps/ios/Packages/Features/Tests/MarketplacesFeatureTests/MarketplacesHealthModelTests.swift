import APIClient
import Foundation
import ListoraAPI
import Testing
@testable import MarketplacesFeature

/// The connection health summary: the app banner, sale email forwarding, and Retry check.
@MainActor
struct MarketplacesHealthModelTests {
    private func connected() throws -> [Components.Schemas.Connection] {
        try [connection(status: "connected", tone: "success", label: "Connected")]
    }

    private func degraded(
        label: String = "Connection problem",
        actions: [String] = ["check", "reconnect"],
    ) throws -> Components.Schemas.Connection {
        try connection(status: "degraded", tone: "checking", label: label, actions: actions)
    }

    @Test
    func `raises the app banner while a connection needs attention, and drops it once fixed`() async throws {
        let service = try FakeConnectionsService(
            lists: [.success(connected())],
            banners: [
                BannerSpec(tone: "action_needed", label: "Reconnect eBay", detail: "eBay no longer accepts Listora."),
                nil,
            ],
        )
        let model = MarketplacesModel(service: service)
        await model.load()
        #expect(model.attention == AttentionBanner(
            title: "Reconnect eBay",
            message: "eBay no longer accepts Listora.",
            needsAction: true,
            count: 1,
        ))
        #expect(model.saleForwarding?.statusLabel == "Set up when you add a domain")
        await model.load()
        #expect(model.attention == nil)
    }

    @Test
    func `sums every marketplace up in one line for Settings, in the server's words`() async throws {
        let service = try FakeConnectionsService(
            lists: [
                .success([]),
                .success(connected() + [connection(
                    marketplace: "poshmark",
                    status: "not_connected",
                    tone: "neutral",
                    label: "Not linked",
                )]),
                .success([connection(status: "not_connected", tone: "neutral", label: "Not linked")]),
                .success([connection(status: "reconnect_needed", tone: "action_needed", label: "Reconnect needed")]),
                .success(connected()),
            ],
            banners: [nil, nil, nil, nil, BannerSpec(tone: "action_needed", label: "Reconnect eBay", detail: nil)],
        )
        let model = MarketplacesModel(service: service)
        #expect(model.healthLine == nil)
        await model.load()
        #expect(model.healthLine == nil)
        await model.load()
        #expect(model.healthLine == HealthLine(text: "1 working", needsAttention: false))
        await model.load()
        #expect(model.healthLine == HealthLine(text: "None linked yet", needsAttention: false))
        // A connection with a problem is not "none linked", even without the server's banner.
        await model.load()
        #expect(model.healthLine == HealthLine(text: "1 needs attention", needsAttention: true))
        await model.load()
        #expect(model.healthLine == HealthLine(text: "Reconnect eBay", needsAttention: true))
    }

    @Test
    func `a problem Listora keeps checking is a checking banner, and signing out drops it`() async throws {
        let signedOut = APIFailure(statusCode: 401, code: "unauthenticated", message: "Sign in.", retryable: false)
        let service = try FakeConnectionsService(
            lists: [.success([degraded()]), .failure(signedOut)],
            banners: [BannerSpec(tone: "checking", label: "eBay connection problem", detail: nil)],
        )
        let model = MarketplacesModel(service: service)
        await model.load()
        #expect(model.attention?.needsAction == false)
        await model.load()
        #expect(model.attention == nil)
    }

    @Test
    func `retry check shows the server's Checking, then reads again until it has an answer`() async throws {
        let service = try FakeConnectionsService(
            lists: [
                .success([degraded()]),
                .success([degraded(label: "Checking...", actions: [])]),
                .success(connected()),
            ],
            check: .success(degraded(label: "Checking...", actions: [])),
        )
        let model = MarketplacesModel(service: service, pollInterval: .zero, sleep: { _ in })
        await model.load()
        let row = try #require(model.rows.first)
        #expect(row.action == .check)
        await model.check(row)
        #expect(service.checkKeys.count == 1)
        #expect(model.rows.first?.statusLabel == "Connected")
        #expect(model.notice == .init(tone: .success, message: "eBay is connected."))
        #expect(model.requestingCheck == nil)
        #expect(service.listCalls == 3)
    }

    @Test
    func `retry check that the server refuses shows why and reloads`() async throws {
        let refused = APIFailure(
            statusCode: 409,
            code: "invalid_state_transition",
            message: "Listora can't check this eBay connection. Reconnect eBay.",
            retryable: false,
        )
        let service = try FakeConnectionsService(lists: [.success([degraded()])], check: .failure(refused))
        let model = MarketplacesModel(service: service, pollInterval: .zero, sleep: { _ in })
        await model.load()
        try await model.check(#require(model.rows.first))
        #expect(model.notice == .init(
            tone: .failure,
            message: "Listora can't check this eBay connection. Reconnect eBay.",
        ))
        #expect(service.listCalls == 2)
    }

    @Test
    func `retry check gives up reading after its last try, showing what the server said`() async throws {
        let service = try FakeConnectionsService(
            lists: [.success([degraded()]), .success([degraded(label: "Checking...", actions: [])])],
            check: .success(degraded(label: "Checking...", actions: [])),
        )
        let model = MarketplacesModel(service: service, pollInterval: .zero, maxPolls: 3, sleep: { _ in })
        await model.load()
        try await model.check(#require(model.rows.first))
        #expect(model.rows.first?.statusLabel == "Checking...")
        #expect(model.notice == nil)
        #expect(service.listCalls == 4)
    }

    @Test
    func `signed out, the banner asks the API nothing`() async throws {
        let service = try FakeConnectionsService(
            lists: [.success(connected())],
            banners: [BannerSpec(tone: "action_needed", label: "Reconnect eBay", detail: nil)],
        )
        let session = Session()
        let model = MarketplacesModel(service: service, isSignedIn: { session.isSignedIn })
        await model.refreshAttention()
        #expect(service.listCalls == 0)
        #expect(model.attention == nil)
        session.isSignedIn = true
        await model.refreshAttention()
        #expect(model.attention?.title == "Reconnect eBay")
    }
}

/// Whether someone is signed in, changed by a test after the model captured it.
@MainActor
private final class Session {
    var isSignedIn = false
}
