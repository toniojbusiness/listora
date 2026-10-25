import Foundation
import ListoraAPI

/// How a task reads and what it lets the user do, from its kind. The server words the title and
/// instructions; this decides the steps and buttons. A kind this build does not know shows the
/// server's words and its link, and asks the user to update the app instead of offering Done.
struct TaskPresentation: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        /// Post a new listing by hand: copy-assist, photos, link, then paste the listing's URL.
        case list
        /// Change a listing by hand: copy-assist, link.
        case edit
        /// Remove a listing by hand: open it, remove it.
        case delist
        case confirmSale
        case reconnect
        case reviewMatch
        /// An item sold twice: cancel the later order on its marketplace.
        case resolveDoubleSale
        /// A kind added after this build.
        case unknown
    }

    let kind: Kind
    /// "Poshmark", or "the marketplace" when the task names none.
    let marketplaceName: String
    let isUrgent: Bool

    init(_ task: UserTask) {
        kind = switch task.kind.value1 {
        case .listManually: .list
        case .editManually: .edit
        case .delistManually: .delist
        case .confirmSale: .confirmSale
        case .reconnect: .reconnect
        case .reviewMatch: .reviewMatch
        case .resolveDoubleSale: .resolveDoubleSale
        case nil: .unknown
        }
        marketplaceName = task.marketplace.map { Self.name(of: $0) } ?? "the marketplace"
        isUrgent = task.urgency == .urgent
    }

    /// The confirmation button. A delist says what the user did, so it is never mistaken for
    /// Listora having removed it; nil when this build cannot finish the task.
    var doneTitle: String? {
        switch kind {
        case .list: "Done - I posted it"
        case .edit: "Done - I saved the change"
        case .delist: "Done - I removed it"
        case .reconnect: "Done"
        case .resolveDoubleSale: "Done - I canceled it"
        case .confirmSale, .reviewMatch, .unknown: nil
        }
    }

    /// The button that opens the marketplace's app or site.
    var openTitle: String {
        switch kind {
        case .list: "Open \(marketplaceName)"
        case .edit, .delist: "Open the listing on \(marketplaceName)"
        case .resolveDoubleSale: "Open the order on \(marketplaceName)"
        case .confirmSale, .reconnect, .reviewMatch, .unknown: "Open \(marketplaceName)"
        }
    }

    /// Whether Done takes the new listing's link (pasted, or shared from the marketplace app).
    var takesListingLink: Bool {
        kind == .list
    }

    /// One numbered step of the task screen.
    enum Step: Hashable, Sendable {
        case savePhotos
        case copyDetails
        /// Opens the marketplace's app or site, or the listing itself.
        case open(title: String)
        case pasteLink
        case removeListing
    }

    /// The task screen's steps, in order: a list task saves the photos, copies the details,
    /// opens the marketplace, and takes the listing's link; a delist opens the exact listing and
    /// has it removed.
    func steps(hasPhotos: Bool, hasFields: Bool, hasLink: Bool) -> [Step] {
        switch kind {
        case .list:
            (hasPhotos ? [.savePhotos] : []) + (hasFields ? [.copyDetails] : [])
                + [.open(title: "Post it on \(marketplaceName)"), .pasteLink]
        case .edit:
            (hasFields ? [.copyDetails] : []) + [.open(title: "Change it on \(marketplaceName)")]
        case .delist:
            [.open(title: "Open the listing"), .removeListing]
        case .resolveDoubleSale:
            hasLink ? [.open(title: "Cancel the order")] : []
        case .confirmSale, .reconnect, .reviewMatch, .unknown:
            hasLink ? [.open(title: "Open \(marketplaceName)")] : []
        }
    }

    /// The SF Symbol of the task's row.
    var systemImage: String {
        switch kind {
        case .list: "square.and.arrow.up"
        case .edit: "pencil"
        case .delist: "xmark.bin"
        case .confirmSale: "dollarsign.circle"
        case .reconnect: "link"
        case .reviewMatch: "questionmark.circle"
        case .resolveDoubleSale: "exclamationmark.2"
        case .unknown: "exclamationmark.circle"
        }
    }

    /// The marketplace's own spelling; an id this app does not know shows as sent.
    static func name(of marketplace: Components.Schemas.Marketplace) -> String {
        switch marketplace.value1 {
        case .ebay: "eBay"
        case .depop: "Depop"
        case .poshmark: "Poshmark"
        case .mercari: "Mercari"
        case nil: marketplace.value2 ?? "the marketplace"
        }
    }
}
