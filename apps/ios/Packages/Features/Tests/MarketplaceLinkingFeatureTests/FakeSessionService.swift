import APIClient
import Foundation
@testable import MarketplaceLinkingFeature

/// Answers the list, the link, and then each poll from a script, and records what was sent.
actor FakeSessionService: MarketplaceSessionService {
    struct ReadOnlyChange: Equatable {
        let marketplace: String
        let readOnly: Bool
    }

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
    private let readOnlyFailure: APIFailure?
    private(set) var readOnlyChanges: [ReadOnlyChange] = []
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
        readOnlyFailure: APIFailure? = nil,
    ) {
        self.readOnlyFailure = readOnlyFailure
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

    func setReadOnly(_ marketplace: String, _ readOnly: Bool) async throws(APIFailure) {
        readOnlyChanges.append(ReadOnlyChange(marketplace: marketplace, readOnly: readOnly))
        if let readOnlyFailure {
            throw readOnlyFailure
        }
    }

    func unlink(_ marketplace: String) async throws(APIFailure) {
        unlinked.append(marketplace)
        if !unlinkFailures.isEmpty {
            throw unlinkFailures.removeFirst()
        }
    }
}
