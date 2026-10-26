import APIClient
import DesignSystem
import Foundation
import Testing
@testable import MarketplaceLinkingFeature

/// The Link accounts flow against a scripted service: what the user sees follows the server's
/// answers, never an assumption that linking worked.
@MainActor
struct LinkAccountsModelTests {
    @Test
    func `shows linked only once the server's check passed`() async throws {
        let service = FakeSessionService(
            list: [.poshmark(.notLinked)],
            link: .poshmark(.checking),
            polls: [.poshmark(.checking), .poshmark(.linked)],
        )
        let model = makeModel(service)
        await model.load()
        #expect(model.links.map(\.state) == [.notLinked])

        let poshmark = try #require(model.links.first)
        model.startLinking(poshmark)
        #expect(model.signingIn == poshmark)
        await model.finishSignIn(poshmark, cookies: [
            cookie("jwt", "session-token", domain: ".poshmark.com"),
            cookie("_ga", "tracker", domain: ".google.com"),
        ])

        #expect(model.signingIn == nil)
        #expect(model.links.first?.state == .linked)
        #expect(model.links.first?.statusLabel == "Linked")
        #expect(model.progress.isEmpty)
        // Only Poshmark's own cookie went to Listora.
        let sent = await service.sentLinks
        #expect(sent.count == 1)
        #expect(sent.first?.cookies.map(\.name) == ["jwt"])
        #expect(await service.gets == 2)
    }

    @Test
    func `shows needs relink when the marketplace rejected the session, with one-tap relink`() async throws {
        let service = FakeSessionService(
            list: [.poshmark(.linked)],
            link: .poshmark(.checking),
            polls: [.poshmark(.needsRelink(message: "Poshmark logged Listora out. Sign in again."))],
        )
        let model = makeModel(service)
        await model.load()
        let poshmark = try #require(model.links.first)
        #expect(poshmark.linkActionTitle == "Relink")

        await model.finishSignIn(poshmark, cookies: [cookie("jwt", "token", domain: "poshmark.com")])

        let relink = try #require(model.links.first)
        #expect(relink.state == .needsRelink(message: "Poshmark logged Listora out. Sign in again."))
        #expect(relink.statusLabel == "Sign in again")
        #expect(relink.canLink)
        model.startLinking(relink)
        #expect(model.signingIn == relink)
    }

    @Test
    func `shows a failed check with the server's reason, and links again`() async throws {
        let reason = "Listora couldn't check your Depop sign-in just now."
        let service = FakeSessionService(
            list: [.depop(.notLinked)],
            link: .depop(.checking),
            polls: [.depop(.checking), .depop(.checkFailed(message: reason))],
        )
        let model = makeModel(service)
        await model.load()
        let depop = try #require(model.links.first)
        await model.finishSignIn(depop, cookies: [cookie("access_token", "t", domain: "www.depop.com")])

        let failed = try #require(model.links.first)
        #expect(failed.state == .checkFailed(message: reason))
        #expect(failed.statusTone == .actionNeeded)
        #expect(failed.canLink)
        #expect(failed.linkActionTitle == "Relink")
        #expect(failed.canCheckAgain)
    }

    @Test
    func `checks the session it holds again without a sign-in, and follows that check`() async throws {
        let reason = "Listora's browser didn't start, so it couldn't check your Depop sign-in."
        let service = FakeSessionService(
            list: [.depop(.checkFailed(message: reason))],
            link: .depop(.checking),
            polls: [.depop(.checking), .depop(.checking), .depop(.linked)],
        )
        let model = makeModel(service)
        await model.load()
        let depop = try #require(model.links.first)

        await model.checkAgain(depop)

        #expect(await service.checkRequests.count == 1)
        #expect(await service.sentLinks.isEmpty)
        #expect(model.signingIn == nil)
        #expect(model.links.first?.state == .linked)
        #expect(model.progress.isEmpty)
    }

    @Test
    func `says so when Listora could not be asked to check again, and keeps the row`() async throws {
        let reason = "Listora couldn't check your Depop sign-in just now."
        let service = FakeSessionService(
            list: [.depop(.checkFailed(message: reason))],
            link: .depop(.checking),
            polls: [],
            checkFailure: .networkUnavailable,
        )
        let model = makeModel(service)
        await model.load()
        try await model.checkAgain(#require(model.links.first))

        #expect(model.progress["depop"] == .checkFailed(.networkUnavailable))
        #expect(model.links.first?.state == .checkFailed(message: reason))
        #expect(await service.gets == 0)
    }

    @Test
    func `follows a check for as long as the server may take to decide it`() async {
        // The server decides within 15 minutes; at one read every 3 seconds that is 300 reads.
        let service = FakeSessionService(
            list: [.poshmark(.checking)],
            link: .poshmark(.checking),
            polls: Array(repeating: .poshmark(.checking), count: 300) + [.poshmark(.checkFailed(
                message: "Listora's check of your Poshmark sign-in didn't finish.",
            ))],
        )
        let model = LinkAccountsModel(service: service, sleep: { _ in })
        await model.load()
        #expect(model.links.first?.state == .checkFailed(
            message: "Listora's check of your Poshmark sign-in didn't finish.",
        ))
    }

    @Test
    func `keeps showing checking when it cannot read the check, never linked`() async throws {
        let service = FakeSessionService(
            list: [.poshmark(.notLinked)],
            link: .poshmark(.checking),
            polls: [],
            getFailure: .networkUnavailable,
        )
        let model = makeModel(service, maxPolls: 3)
        await model.load()
        try await model.finishSignIn(
            #require(model.links.first),
            cookies: [cookie("jwt", "t", domain: "poshmark.com")],
        )
        #expect(model.links.first?.state == .checking)
        #expect(model.links.first?.canLink == false)
        #expect(await service.gets == 3)
    }

    @Test
    func `a sign-in that left no marketplace cookies sends nothing and says so`() async throws {
        let service = FakeSessionService(list: [.poshmark(.notLinked)], link: .poshmark(.checking), polls: [])
        let model = makeModel(service)
        await model.load()
        try await model.finishSignIn(
            #require(model.links.first),
            cookies: [cookie("sso", "x", domain: "accounts.example.com")],
        )
        #expect(await service.sentLinks.isEmpty)
        guard case let .failed(error) = model.progress["poshmark"] else {
            Issue.record("expected a failure")
            return
        }
        #expect(error.message.contains("didn't sign you in"))
        #expect(!error.retryable)
        #expect(model.links.first?.state == .notLinked)
    }

    @Test
    func `retries a link that did not reach Listora with the same key and cookies`() async throws {
        let service = FakeSessionService(
            list: [.mercari(.notLinked)],
            link: .mercari(.checking),
            polls: [.mercari(.linked)],
            linkFailures: [.networkUnavailable],
        )
        let model = makeModel(service)
        await model.load()
        try await model.finishSignIn(
            #require(model.links.first),
            cookies: [cookie("_mercari", "t", domain: "www.mercari.com")],
        )
        #expect(model.progress["mercari"] == .failed(.networkUnavailable))
        #expect(model.links.first?.state == .notLinked)

        await model.retry("mercari")
        let sent = await service.sentLinks
        #expect(sent.count == 2)
        #expect(sent[0].key == sent[1].key)
        #expect(sent[0].cookies == sent[1].cookies)
        #expect(model.links.first?.state == .linked)
        #expect(model.progress["mercari"] == nil)
    }

    @Test
    func `does not open sign-in while a check runs or for an API connection`() async {
        let service = FakeSessionService(
            list: [.poshmark(.checking), .depop(.apiConnected)],
            link: .poshmark(.checking),
            polls: [.poshmark(.linked)],
        )
        let model = makeModel(service, maxPolls: 0)
        await model.load()
        for link in model.links {
            model.startLinking(link)
            #expect(model.signingIn == nil)
        }
    }

    @Test
    func `resumes following a check that was running when the screen opened`() async {
        let service = FakeSessionService(
            list: [.poshmark(.checking)],
            link: .poshmark(.checking),
            polls: [.poshmark(.linked)],
        )
        let model = makeModel(service)
        await model.load()
        #expect(model.links.first?.state == .linked)
    }

    @Test
    func `shows a list that could not be read, with Try again`() async {
        let service = FakeSessionService(
            list: [],
            link: .poshmark(.checking),
            polls: [],
            listFailure: .networkUnavailable,
        )
        let model = makeModel(service)
        await model.load()
        #expect(model.loadState == .failed(.networkUnavailable))
    }

    private func makeModel(_ service: FakeSessionService, maxPolls: Int = 10) -> LinkAccountsModel {
        LinkAccountsModel(
            service: service,
            makeIdempotencyKey: { UUID().uuidString },
            pollInterval: .zero,
            maxPolls: maxPolls,
            sleep: { _ in },
        )
    }
}

func cookie(_ name: String, _ value: String, domain: String, expires: Date? = nil) -> HTTPCookie {
    var properties: [HTTPCookiePropertyKey: Any] = [.name: name, .value: value, .domain: domain, .path: "/"]
    if let expires {
        properties[.expires] = expires
    }
    // swiftlint:disable:next force_unwrapping
    return HTTPCookie(properties: properties)!
}

extension MarketplaceLink {
    static func poshmark(_ state: State) -> MarketplaceLink {
        make("poshmark", "Poshmark", "https://poshmark.com/login", "poshmark.com", state)
    }

    static func mercari(_ state: State) -> MarketplaceLink {
        make("mercari", "Mercari", "https://www.mercari.com/login/", "mercari.com", state)
    }

    static func depop(_ state: State, runsOn: RunsOn? = nil) -> MarketplaceLink {
        make("depop", "Depop", "https://www.depop.com/login/", "depop.com", state, runsOn: runsOn)
    }

    private static func make(
        _ marketplace: String,
        _ name: String,
        _ url: String,
        _ domain: String,
        _ state: State,
        runsOn: RunsOn? = nil,
    ) -> MarketplaceLink {
        let (label, tone): (String, StatusLabel.Tone) = switch state {
        case .notLinked: ("Not linked", .neutral)
        case .checking: ("Checking...", .checking)
        case .linked: ("Linked", .success)
        case .needsRelink: ("Sign in again", .actionNeeded)
        case .checkFailed: ("Not confirmed", .actionNeeded)
        case .apiConnected: ("Connected through the \(name) API", .neutral)
        case .unknown: ("Something new", .neutral)
        }
        return MarketplaceLink(
            marketplace: marketplace,
            name: name,
            state: state,
            statusLabel: label,
            statusTone: tone,
            // swiftlint:disable:next force_unwrapping
            loginURL: URL(string: url)!,
            cookieDomains: [domain],
            runsOn: runsOn,
        )
    }
}

/// Answers the list, the link, and then each poll from a script, and records what was sent.
actor FakeSessionService: MarketplaceSessionService {
    struct SentLink: Equatable {
        let marketplace: String
        let cookies: [CapturedCookie]
        let installationID: String?
        let key: String
    }

    private let listed: [MarketplaceLink]
    private let linked: MarketplaceLink
    private var polls: [MarketplaceLink]
    private var linkFailures: [APIFailure]
    private let getFailure: APIFailure?
    private let listFailure: APIFailure?
    private var unlinkFailures: [APIFailure]
    private let checkFailure: APIFailure?
    private(set) var sentLinks: [SentLink] = []
    private(set) var checkRequests: [(marketplace: String, key: String)] = []
    private(set) var gets = 0
    private(set) var unlinked: [String] = []

    init(
        list: [MarketplaceLink],
        link: MarketplaceLink,
        polls: [MarketplaceLink],
        linkFailures: [APIFailure] = [],
        getFailure: APIFailure? = nil,
        listFailure: APIFailure? = nil,
        unlinkFailures: [APIFailure] = [],
        checkFailure: APIFailure? = nil,
    ) {
        listed = list
        linked = link
        self.polls = polls
        self.linkFailures = linkFailures
        self.getFailure = getFailure
        self.listFailure = listFailure
        self.unlinkFailures = unlinkFailures
        self.checkFailure = checkFailure
    }

    func requestCheck(_ marketplace: String, idempotencyKey: String) async throws(APIFailure) {
        checkRequests.append((marketplace, idempotencyKey))
        if let checkFailure {
            throw checkFailure
        }
    }

    func list() async throws(APIFailure) -> [MarketplaceLink] {
        if let listFailure {
            throw listFailure
        }
        return listed
    }

    func get(_ marketplace: String) async throws(APIFailure) -> MarketplaceLink {
        gets += 1
        if let getFailure {
            throw getFailure
        }
        guard !polls.isEmpty else {
            return listed.first { $0.marketplace == marketplace } ?? linked
        }
        return polls.removeFirst()
    }

    func link(
        _ marketplace: String,
        cookies: [CapturedCookie],
        installationID: String?,
        idempotencyKey: String,
    ) async throws(APIFailure) -> MarketplaceLink {
        sentLinks.append(SentLink(
            marketplace: marketplace,
            cookies: cookies,
            installationID: installationID,
            key: idempotencyKey,
        ))
        if !linkFailures.isEmpty {
            throw linkFailures.removeFirst()
        }
        return linked
    }

    func unlink(_ marketplace: String) async throws(APIFailure) {
        unlinked.append(marketplace)
        if !unlinkFailures.isEmpty {
            throw unlinkFailures.removeFirst()
        }
    }
}
