import Foundation
import ListoraAPI
import Testing
@testable import MarketplacesFeature

struct MarketplaceRowTests {
    @Test
    func `a connected marketplace shows the server's label and offers nothing`() throws {
        let row = try MarketplaceRow(connection: connection(
            status: "connected",
            tone: "success",
            label: "Connected",
            detail: "Signed in as listora_seller.",
            displayName: "listora_seller",
        ))
        #expect(row.id == "ebay")
        #expect(row.name == "eBay")
        #expect(row.statusLabel == "Connected")
        #expect(row.statusDetail == "Signed in as listora_seller.")
        #expect(row.tone == .success)
        #expect(row.usesAPI)
        #expect(row.modeLabel == "API")
        #expect(row.action == nil)
    }

    @Test
    func `a marketplace that is not connected offers to connect it`() throws {
        let row = try MarketplaceRow(connection: connection(
            status: "not_connected",
            tone: "neutral",
            label: "Not connected",
            actions: ["connect"],
        ))
        #expect(row.tone == .neutral)
        #expect(row.action == .connect)
        #expect(row.actionTitle == "Connect eBay")
    }

    @Test(arguments: [
        ("reauth_required", "action_needed", "Reconnect needed"),
        ("revoked", "action_needed", "Access removed"),
        ("connected", "action_needed", "Reconnect within 12 days"),
    ])
    func `a connection that needs the seller offers to reconnect`(status: String, tone: String, label: String) throws {
        let row = try MarketplaceRow(connection: connection(
            status: status,
            tone: tone,
            label: label,
            actions: ["reconnect"],
        ))
        #expect(row.statusLabel == label)
        #expect(row.tone == .actionNeeded)
        #expect(row.action == .reconnect)
        #expect(row.actionTitle == "Reconnect eBay")
    }

    @Test
    func `a degraded connection offers Retry check first, then reconnecting`() throws {
        let row = try MarketplaceRow(connection: connection(
            status: "degraded",
            tone: "checking",
            label: "Connection problem",
            detail: "eBay had a problem. Try again soon. Listora keeps checking.",
            actions: ["check", "reconnect"],
        ))
        #expect(row.tone == .checking)
        #expect(row.statusDetail == "eBay had a problem. Try again soon. Listora keeps checking.")
        #expect(row.actions == [.check, .reconnect])
        #expect(row.action == .check)
        #expect(row.actionTitle == "Retry check")
        #expect(row.title(for: .reconnect) == "Reconnect eBay")
    }

    @Test
    func `a check in progress offers nothing`() throws {
        let row = try MarketplaceRow(connection: connection(
            status: "degraded",
            tone: "checking",
            label: "Checking...",
        ))
        #expect(row.statusLabel == "Checking...")
        #expect(row.actions.isEmpty)
    }

    @Test
    func `automation mode shows by name`() throws {
        let row = try MarketplaceRow(connection: connection(
            marketplace: "poshmark",
            mode: "automation",
            status: "connected",
            tone: "success",
            label: "Connected",
            connect: "none",
        ))
        #expect(row.mode == .automation)
        #expect(row.modeLabel == "Automation")
        #expect(!row.usesAPI)
    }

    @Test(arguments: ["depop", "poshmark", "mercari"])
    func `assisted marketplaces show assisted mode and no connect button`(marketplace: String) throws {
        let row = try MarketplaceRow(connection: connection(
            marketplace: marketplace,
            mode: "assisted",
            status: "not_connected",
            tone: "neutral",
            label: "Not linked",
            connect: "none",
        ))
        #expect(!row.usesAPI)
        #expect(row.modeLabel == "Assisted")
        #expect(row.statusLabel == "Not linked")
        #expect(row.action == nil)
        #expect(["Depop", "Poshmark", "Mercari"].contains(row.name))
    }

    @Test
    func `eBay that cannot be connected yet shows coming soon without a button`() throws {
        let row = try MarketplaceRow(connection: connection(
            status: "not_connected",
            tone: "neutral",
            label: "Coming soon",
            connect: "none",
        ))
        #expect(row.statusLabel == "Coming soon")
        #expect(row.action == nil)
    }

    @Test
    func `values added after this version show generically and offer nothing`() throws {
        let row = try MarketplaceRow(connection: connection(
            marketplace: "vinted",
            status: "waitlisted",
            tone: "sparkly",
            label: "Coming soon",
            actions: ["join_waitlist", "connect"],
        ))
        #expect(row.id == "vinted")
        #expect(row.name == "vinted")
        #expect(row.marketplace == nil)
        #expect(row.tone == .neutral)
        // An unknown marketplace cannot be connected from this version, whatever it offers.
        #expect(row.action == nil)

        let known = try MarketplaceRow(connection: connection(
            status: "not_connected",
            tone: "neutral",
            label: "Not connected",
            actions: ["join_waitlist"],
        ))
        #expect(known.action == nil)
    }
}
