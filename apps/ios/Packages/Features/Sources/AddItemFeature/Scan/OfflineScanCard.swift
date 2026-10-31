import Core
import DesignSystem
import Foundation

/// The instant read as its card shows it (docs/features/thrift-scan.md, "Offline at the bins"):
/// the call from the household's own sales of the brand on the tag, under its label, in whole
/// dollars. No AI saw the item, so the card never says what the item is beyond its brand.
struct OfflineScanCard: Equatable {
    let brand: String
    let call: ScanCard.Call
    let callLabel: String
    let confidence: String
    /// "From your sales only".
    let label: String
    let basedOn: String
    /// "$25-$34", absent without enough sales.
    let range: String?
    let payout: String?
    /// "You have 2 Lululemon unsold".
    let unsold: String?

    init(_ read: OfflineScanRead) {
        brand = read.brand
        switch read.call {
        case .buy:
            call = .buy
            callLabel = "Buy"
        case .yourCall:
            call = .yourCall
            callLabel = "Your call"
        case .skip:
            call = .skip
            callLabel = "Skip"
        }
        confidence = switch read.confidence {
        case .high: "High confidence"
        case .medium: "Medium confidence"
        case .low: "Low confidence"
        }
        label = OfflineScanCall.label
        basedOn = read.basedOn
        range = Self.range(read.lowCents, read.highCents)
        if let payout = Self.range(read.conservativePayoutCents, read.optimisticPayoutCents) {
            let marketplace = read.payoutMarketplace.map(Self.marketplaceName) ?? ""
            self.payout = "You'd get about \(payout) after \(marketplace.isEmpty ? "" : "\(marketplace) ")fees"
        } else {
            payout = nil
        }
        unsold = read.unsoldCount > 0 ? "You have \(read.unsoldCount) \(read.brand) unsold" : nil
    }

    /// Felt as the server's card is: two taps for Buy, a long buzz for Skip, nothing for Your call.
    var haptic: Haptics.Event? {
        switch call {
        case .buy: .doubleTap
        case .skip: .longBuzz
        case .yourCall, .other: nil
        }
    }

    var tone: StatusTone {
        switch call {
        case .buy: .success
        case .skip: .failed
        case .yourCall: .actionNeeded
        case .other: .neutral
        }
    }

    private static func range(_ low: Int?, _ high: Int?) -> String? {
        guard let low, let high else { return nil }
        let lowText = dollars(low)
        let highText = dollars(high)
        return lowText == highText ? lowText : "\(lowText)-\(highText)"
    }

    private static func dollars(_ cents: Int) -> String {
        (Decimal(cents) / 100).formatted(.currency(code: "USD").precision(.fractionLength(0)))
    }

    private static func marketplaceName(_ marketplace: String) -> String {
        switch marketplace {
        case "ebay": "eBay"
        case "depop": "Depop"
        case "poshmark": "Poshmark"
        case "mercari": "Mercari"
        default: marketplace
        }
    }
}
