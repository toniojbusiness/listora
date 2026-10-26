import Core
import Foundation
import Testing
@testable import MarketplaceLinkingFeature

/// Depop's emailed sign-in link, pasted or shared to Listora, opens in the same sign-in page,
/// so the session lands in Listora rather than in the phone's browser; nothing else opens there.
@MainActor
struct MarketplaceSignInModelTests {
    nonisolated private static let start = Date(timeIntervalSince1970: 1_800_000_000)
    private let link = "https://www.depop.com/login/magic-link/?token=abc123"

    private func depop(emailsSignInLinks: Bool = true) -> MarketplaceLink {
        MarketplaceLink(
            marketplace: "depop",
            name: "Depop",
            state: .notLinked,
            statusLabel: "Not linked",
            statusTone: .neutral,
            loginURL: URL(string: "https://www.depop.com/login/")!,
            cookieDomains: ["depop.com"],
            emailsSignInLinks: emailsSignInLinks,
        )
    }

    private func page(
        _ link: MarketplaceLink,
        handoff: InMemorySignInLinkHandoff = InMemorySignInLinkHandoff(),
        now: @escaping @Sendable () -> Date = { start },
    ) -> MarketplaceSignInModel {
        MarketplaceSignInModel(link: link, handoff: handoff, now: now)
    }

    @Test
    func `opens the sign-in page first`() {
        let model = page(depop())
        #expect(model.navigation.url.absoluteString == "https://www.depop.com/login/")
        #expect(model.rule != nil)
        #expect(!model.openedEmailedLink)
    }

    @Test
    func `opens a pasted Depop sign-in link in the same page`() {
        let model = page(depop())
        let first = model.navigation
        model.paste([link])
        #expect(model.navigation.url.absoluteString == link)
        #expect(model.navigation.id != first.id)
        #expect(model.openedEmailedLink)
        #expect(model.linkProblem == nil)
    }

    @Test
    func `finds the link among the pasted texts`() {
        let model = page(depop())
        model.paste(["Log in to Depop", "Tap to log in: \(link)"])
        #expect(model.navigation.url.absoluteString == link)
    }

    @Test
    func `opens the same link again when pasted again`() {
        let model = page(depop())
        model.paste([link])
        let opened = model.navigation
        model.paste([link])
        #expect(model.navigation.url == opened.url)
        #expect(model.navigation.id != opened.id)
    }

    @Test(arguments: [
        "https://notdepop.com/login/magic-link/?token=abc",
        "https://depop.com.evil.example/login/magic-link/?token=abc",
        "http://www.depop.com/login/magic-link/?token=abc",
        "depop://login?token=abc",
        "my password is hunter2",
    ])
    func `never opens anything but a Depop sign-in link`(_ pasted: String) {
        let model = page(depop())
        let before = model.navigation
        model.paste([pasted])
        #expect(model.navigation == before)
        #expect(!model.openedEmailedLink)
        #expect(model
            .linkProblem == "That isn't a Depop sign-in link. Copy the link in Depop's email and paste it again.")
    }

    @Test
    func `says how to copy the link when there was nothing to paste`() {
        let model = page(depop())
        model.paste([" "])
        #expect(model.linkProblem?.hasPrefix("Nothing to paste.") == true)
        // A good paste clears it.
        model.paste([link])
        #expect(model.linkProblem == nil)
    }

    @Test
    func `opens a link shared to Listora once the user comes back`() throws {
        let handoff = InMemorySignInLinkHandoff()
        let model = page(depop(), handoff: handoff)
        model.appeared()

        // The Share Extension, given the link from Depop's email.
        let request = try handoff.deliver(from: SharedContent(urls: [#require(URL(string: link))]), now: Self.start)
        #expect(request?.marketplace == "depop")
        #expect(request?.name == "Depop")

        model.becameActive()
        #expect(model.navigation.url.absoluteString == link)
        #expect(model.openedEmailedLink)
        // It opens once.
        let opened = model.navigation
        model.becameActive()
        #expect(model.navigation == opened)
    }

    @Test
    func `takes no shared link after the page closed`() throws {
        let handoff = InMemorySignInLinkHandoff()
        let model = page(depop(), handoff: handoff)
        model.appeared()
        model.closed()
        #expect(try handoff.deliver(from: SharedContent(urls: [#require(URL(string: link))]), now: Self.start) == nil)
    }

    @Test
    func `takes no shared link once the page has been open too long`() throws {
        let handoff = InMemorySignInLinkHandoff()
        let model = page(depop(), handoff: handoff)
        model.appeared()
        let later = Self.start.addingTimeInterval(MarketplaceSignInModel.shareWindow + 1)
        #expect(try handoff.deliver(from: SharedContent(urls: [#require(URL(string: link))]), now: later) == nil)
    }

    @Test
    func `a marketplace that emails no sign-in link takes none`() {
        let handoff = InMemorySignInLinkHandoff()
        let model = page(depop(emailsSignInLinks: false), handoff: handoff)
        #expect(model.rule == nil)
        model.appeared()
        #expect(handoff.expected(now: Self.start) == nil)
        model.paste([link])
        #expect(model.navigation.url.absoluteString == "https://www.depop.com/login/")
        #expect(model.linkProblem == nil)
    }

    @Test
    func `the Link accounts screen hands its sign-in page the handoff`() {
        let handoff = InMemorySignInLinkHandoff()
        let model = LinkAccountsModel(
            service: FakeSessionService(list: [], link: depop(), polls: []),
            signInLinks: handoff,
        )
        let signIn = model.signInPage(for: depop())
        signIn.appeared()
        #expect(handoff.expected(now: Date())?.marketplace == "depop")
    }
}
