import ListoraAPI

/// The quick filters in the row above Inventory: one tap to the items that need the seller, the
/// drafts, what is not listed yet, what is listed, what sold, and what was put away.
enum InventoryFilter: String, CaseIterable, Identifiable, Sendable {
    case all
    /// A listing whose newest change failed or waits for the seller (`attention` on `listItems`).
    case needsYou
    case drafts
    case ready
    case listed
    case sold
    case archived

    var id: String {
        rawValue
    }

    var title: String {
        switch self {
        case .all: "All"
        case .needsYou: "Needs you"
        case .drafts: "Drafts"
        case .ready: "Ready to list"
        case .listed: "Listed"
        case .sold: "Sold"
        case .archived: "Archived"
        }
    }

    var systemImage: String? {
        switch self {
        case .needsYou: "exclamationmark.circle.fill"
        default: nil
        }
    }

    /// The item statuses the API is asked for; empty for every status.
    var statuses: [Components.Schemas.KnownItemStatus] {
        switch self {
        case .all, .needsYou: []
        case .drafts: [.draft]
        case .ready: [.ready]
        case .listed: [.listed]
        case .sold: [.soldPendingDelist, .sold, .shipped]
        case .archived: [.archived]
        }
    }

    var needsAttention: Bool {
        self == .needsYou
    }
}
