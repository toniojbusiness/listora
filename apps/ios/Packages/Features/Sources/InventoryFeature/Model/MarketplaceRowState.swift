import Foundation
import ListoraAPI

/// One marketplace on the item screen: the item's listing there (if any), its status exactly as
/// the server words it, and what the seller can do now. The app never decides on its own that a
/// change worked: "Active (confirmed by eBay)" appears only when the server says so.
struct MarketplaceRowState: Identifiable, Equatable, Sendable {
    /// How a status is styled; an unknown tone looks neutral.
    enum Tone: Equatable, Sendable {
        case success
        case inProgress
        case checking
        case failed
        case actionNeeded
        case neutral
    }

    /// What the seller can do on this marketplace now.
    enum Action: Equatable, Hashable, Sendable {
        /// Open the List flow (no listing yet, or a draft that was never sent).
        case list
        case changePrice
        case end
        case relist
        case check
        /// Retry the failed operation.
        case retry(operationID: String)
        /// Open the task the assisted operation waits on, in the task inbox.
        case openTask(operationID: String)

        var title: String {
            switch self {
            case .list: "List"
            case .changePrice: "Change price"
            case .end: "End listing"
            case .relist: "Relist"
            case .check: "Check status"
            case .retry: "Retry"
            case .openTask: "Open task"
            }
        }

        /// The UI tests' handle: `marketplace.ebay.action.end`.
        var identifier: String {
            switch self {
            case .list: "list"
            case .changePrice: "changePrice"
            case .end: "end"
            case .relist: "relist"
            case .check: "check"
            case .retry: "retry"
            case .openTask: "openTask"
            }
        }
    }

    /// The marketplace id (`ebay`).
    let id: String
    let name: String
    let listing: Listing?
    let statusLabel: String
    let statusDetail: String?
    let tone: Tone
    /// "Through eBay's API" or "Assisted": how Listora works with this marketplace.
    let modeLabel: String
    /// The listing's own price ("$39.00"), which can differ from the item's list price.
    let priceLabel: String?
    let actions: [Action]

    init(marketplace: KnownMarketplace, listing: Listing?, connection: Connection?) {
        id = marketplace.rawValue
        name = Formatting.marketplaceName(marketplace.rawValue)
        self.listing = listing
        modeLabel = switch (listing?.mode ?? connection?.mode)?.value1 {
        case .api: "Through \(name)'s API"
        case .automation: "Automated in your \(name) session"
        case .assisted, nil: "Assisted - you finish each step in the \(name) app"
        }
        priceLabel = listing?.variant.map { Formatting.money($0.price) }
        if let listing {
            statusLabel = listing.statusDisplay.label
            statusDetail = listing.statusDisplay.detail
            tone = Self.tone(of: listing.statusDisplay.tone)
            actions = Self.actions(of: listing)
        } else {
            statusLabel = "Not listed"
            tone = .neutral
            let canList = Self.canList(marketplace: marketplace, connection: connection)
            actions = canList ? [.list] : []
            // Without a usable connection (only eBay needs one) the card says how to list here.
            statusDetail = canList ? nil : connection == nil
                ? "Connect your \(name) account in Settings > Marketplaces to list it here."
                : "Reconnect \(name) in Settings > Marketplaces to list it here."
        }
    }

    /// The listing's newest operation is still running or waiting: its status keeps changing.
    var isWorking: Bool {
        guard let status = listing?.latestOperation?.status.value1 else { return false }
        switch status {
        case .queued, .running, .retrying, .verifying: return true
        case .succeeded, .failed, .needsUserAction, .canceled: return false
        }
    }

    /// The operation whose history the row shows first.
    var latestOperation: Operation? {
        listing?.latestOperation
    }

    /// Whether the item can be listed on the marketplace from here: Listora does it under a
    /// usable API or browser automation connection; otherwise every marketplace but eBay (which
    /// Listora reaches only through its API) is listed assisted, through a task the user
    /// finishes in its app.
    static func canList(marketplace: KnownMarketplace, connection: Connection?) -> Bool {
        if isListoraDone(connection: connection) {
            return true
        }
        return isAssisted(marketplace: marketplace, connection: connection)
    }

    /// Whether a new listing on the marketplace is assisted: Listora can't do it itself (no
    /// usable API or automation connection; an automation session that stopped working falls
    /// back to assisted), and it is not eBay.
    static func isAssisted(marketplace: KnownMarketplace, connection: Connection?) -> Bool {
        !isListoraDone(connection: connection) && marketplace != .ebay
    }

    /// A usable connection through which Listora acts and reads the result back itself.
    private static func isListoraDone(connection: Connection?) -> Bool {
        guard let connection else { return false }
        switch connection.mode.value1 {
        case .api, .automation:
            break
        case .assisted, nil:
            return false
        }
        switch connection.status.value1 {
        case .connected, .degraded: return true
        default: return false
        }
    }

    /// The server's actions, in the order the row shows them, plus Retry for a failed change
    /// and Open task for a step waiting on the user.
    private static func actions(of listing: Listing) -> [Action] {
        var actions: [Action] = []
        if let operation = listing.latestOperation, operation.status.value1 == .needsUserAction {
            actions.append(.openTask(operationID: operation.id))
        }
        if let operation = listing.latestOperation, operation.status.value1 == .failed,
           operation.error?.retryable ?? true
        {
            actions.append(.retry(operationID: operation.id))
        }
        let available = Set(listing.availableActions.compactMap { availability -> Components.Schemas
                .KnownListingAction? in
            guard availability.mode.value1 != nil else { return nil }
            return availability.action.value1
        })
        if available.contains(.publish) {
            actions.append(.list)
        }
        if available.contains(.changePrice) {
            actions.append(.changePrice)
        }
        if available.contains(.relist) {
            actions.append(.relist)
        }
        if available.contains(.end) {
            actions.append(.end)
        }
        if available.contains(.verify) {
            actions.append(.check)
        }
        return actions
    }

    private static func tone(of tone: Components.Schemas.StatusTone) -> Tone {
        switch tone.value1 {
        case .success: .success
        case .inProgress: .inProgress
        case .checking: .checking
        case .failed: .failed
        case .actionNeeded: .actionNeeded
        case .neutral, nil: .neutral
        }
    }
}
