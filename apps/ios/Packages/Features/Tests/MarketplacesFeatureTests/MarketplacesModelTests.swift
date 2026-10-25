import APIClient
import Foundation
import ListoraAPI
import Testing
@testable import MarketplacesFeature

@MainActor
struct MarketplacesModelTests {
    private let attemptID = "0199a1f0-0000-7000-8000-00000000a001"

    private func notConnected() throws -> [Components.Schemas.Connection] {
        try [
            connection(status: "not_connected", tone: "neutral", label: "Not connected", actions: ["connect"]),
            connection(
                marketplace: "poshmark",
                mode: "assisted",
                status: "not_connected",
                tone: "neutral",
                label: "Not linked",
                connect: "none",
            ),
        ]
    }

    private func connected() throws -> [Components.Schemas.Connection] {
        try [
            connection(
                status: "connected",
                tone: "success",
                label: "Connected",
                detail: "Signed in as listora_seller.",
                displayName: "listora_seller",
            ),
        ]
    }

    @Test
    func `loads every marketplace's row from the server`() async throws {
        let model = try MarketplacesModel(service: FakeConnectionsService(lists: [.success(notConnected())]))
        #expect(model.phase == .loading)
        await model.load()
        #expect(model.phase == .loaded)
        #expect(model.rows.map(\.id) == ["ebay", "poshmark"])
        #expect(model.rows.first?.action == .connect)
    }

    @Test
    func `asks to sign in when the session is gone, and shows other failures as they are`() async {
        let unauthenticated = APIFailure(
            statusCode: 401,
            code: "unauthenticated",
            message: "Sign in.",
            retryable: false,
        )
        let model = MarketplacesModel(service: FakeConnectionsService(lists: [.failure(unauthenticated)]))
        await model.load()
        #expect(model.phase == .failed(message: "Sign in to see your marketplaces."))

        let offline = MarketplacesModel(service: FakeConnectionsService(lists: [.failure(.networkUnavailable)]))
        await offline.load()
        #expect(offline.phase == .failed(message: "Can't reach Listora. Check your connection."))
    }

    @Test
    func `connects eBay: consent sheet, then the server's result, then the reloaded list`() async throws {
        let service = try FakeConnectionsService(
            lists: [.success(notConnected()), .success(connected())],
            start: .success(authorization(status: "pending")),
            results: [attemptID: authorization(status: "completed", url: nil, connected: connected()[0])],
        )
        let model = MarketplacesModel(service: service)
        await model.load()
        let row = try #require(model.rows.first)

        var opened: [(URL, String)] = []
        await model.connect(row) { url, scheme in
            opened.append((url, scheme))
            #expect(model.connecting == "ebay")
            return try #require(URL(string: "listora://connections/ebay?authorizationId=\(attemptID)"))
        }

        #expect(opened.map(\.0.absoluteString) == ["https://auth.ebay.com/oauth2/authorize?state=abc"])
        #expect(opened.map(\.1) == ["listora"])
        #expect(service.readIDs == [attemptID])
        #expect(model.notice == .init(tone: .success, message: "eBay is connected as listora_seller."))
        #expect(model.connecting == nil)
        #expect(model.rows.first?.statusLabel == "Connected")
        #expect(service.listCalls == 2)
        #expect(service.startedKeys.count == 1)
    }

    @Test
    func `closing the consent sheet connects nothing and says so`() async throws {
        let service = try FakeConnectionsService(
            lists: [.success(notConnected())],
            start: .success(authorization(status: "pending")),
        )
        let model = MarketplacesModel(service: service)
        await model.load()
        let row = try #require(model.rows.first)
        await model.connect(row) { _, _ in throw WebAuthenticationCanceled() }

        #expect(model.notice == .init(tone: .info, message: "eBay wasn't connected: you closed the sign-in."))
        #expect(service.readIDs.isEmpty)
        #expect(model.rows.first?.statusLabel == "Not connected")
    }

    @Test
    func `a declined consent shows the server's reason`() async throws {
        let service = try FakeConnectionsService(
            lists: [.success(notConnected())],
            start: .success(authorization(status: "pending")),
            results: [attemptID: authorization(
                status: "failed",
                url: nil,
                failure: "You didn't allow Listora to use your eBay account, so nothing changed.",
            )],
        )
        let model = MarketplacesModel(service: service)
        await model.load()
        let row = try #require(model.rows.first)
        await model.connect(row) { _, _ in
            try #require(URL(string: "listora://connections/ebay?authorizationId=\(attemptID)"))
        }
        #expect(model.notice == .init(
            tone: .failure,
            message: "You didn't allow Listora to use your eBay account, so nothing changed.",
        ))
        #expect(model.rows.first?.action == .connect)
    }

    @Test
    func `a callback without an attempt id reads the started attempt and never claims success`() async throws {
        let service = try FakeConnectionsService(
            lists: [.success(notConnected())],
            start: .success(authorization(status: "pending")),
            results: [attemptID: authorization(status: "pending", url: nil)],
        )
        let model = MarketplacesModel(service: service)
        await model.load()
        let row = try #require(model.rows.first)
        await model.connect(row) { _, _ in try #require(URL(string: "listora://connections/ebay")) }

        #expect(service.readIDs == [attemptID])
        #expect(model.notice == .init(tone: .failure, message: "eBay didn't finish connecting. Try again."))
    }

    @Test
    func `an expired attempt asks to try again`() throws {
        let notice = try MarketplacesModel.notice(for: authorization(status: "expired", url: nil), name: "eBay")
        #expect(notice == .init(tone: .failure, message: "The eBay sign-in took too long. Try again."))
    }

    @Test
    func `a refused start shows the server's message and opens nothing`() async throws {
        let refused = APIFailure(
            statusCode: 409,
            code: "marketplace_action_unavailable",
            message: "Listora can't connect eBay accounts yet.",
            retryable: false,
        )
        let service = try FakeConnectionsService(lists: [.success(notConnected())], start: .failure(refused))
        let model = MarketplacesModel(service: service)
        await model.load()
        let row = try #require(model.rows.first)
        var opened = false
        await model.connect(row) { url, _ in
            opened = true
            return url
        }
        #expect(!opened)
        #expect(model.notice == .init(tone: .failure, message: "Listora can't connect eBay accounts yet."))
    }

    @Test
    func `rows without an action cannot be connected`() async throws {
        let service = try FakeConnectionsService(lists: [.success(notConnected())])
        let model = MarketplacesModel(service: service)
        await model.load()
        let poshmark = try #require(model.rows.last)
        await model.connect(poshmark) { url, _ in url }
        #expect(service.startedKeys.isEmpty)
    }

    @Test
    func `reads the attempt id from the app callback URL`() throws {
        let url = try #require(URL(string: "listora://connections/ebay?authorizationId=abc"))
        #expect(MarketplacesModel.authorizationID(in: url) == "abc")
        #expect(try MarketplacesModel.authorizationID(in: #require(URL(string: "listora://connections/ebay"))) == nil)
    }
}
