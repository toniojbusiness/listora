import Foundation
import Testing
@testable import AddItemFeature

/// A marketplace's comparison row on the card where it shows sold listings (eBay, Mercari):
/// what close matches sold for under its sold label, and its own sold pace.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct ScanComparisonRowTests {
    @Test
    func `shows eBay's sold listings under their label, with eBay's sold pace`() throws {
        let card = try ScanCard(decodeScan(ebaySoldScanJSON(id: "scan-1")))
        let ebay = try #require(card.comparisons.first)
        #expect(ebay.marketplace == "eBay")
        #expect(ebay.status == .read)
        #expect(ebay.label == "eBay: sold $18-$30, 9 like it in the last 14 days")
        #expect(ebay.soldLabel == "Sold listings on eBay")
        #expect(ebay.demand == "Sells fast on eBay")
        #expect(ebay.demandBasedOn == "Sold listings on eBay: 410 in the last 90 days; 320 for sale now")
        // The demand shows with its row, not again among the signals.
        #expect(card.listedSignals.isEmpty)
        #expect(card.basedOn == "Sold listings on eBay: 9 like it in the last 14 days")
    }

    @Test
    func `shows Mercari's sold listings under their label, with its latest sales' pace`() throws {
        let card = try ScanCard(decodeScan(mercariSoldScanJSON(id: "scan-1")))
        let mercari = try #require(card.comparisons.first)
        #expect(mercari.marketplace == "Mercari")
        #expect(mercari.status == .read)
        #expect(mercari.label == "Mercari: sold $20-$28, 7 like it in the last 21 days")
        #expect(mercari.soldLabel == "Sold listings on Mercari")
        #expect(mercari.askingLabel == nil)
        #expect(mercari.demand == "Sells fast on Mercari")
        #expect(mercari.demandBasedOn == "Sold listings on Mercari: 24 of the latest 30 sold in the last 30 days")
        #expect(card.listedSignals.isEmpty)
        #expect(card.basedOn == "Sold listings on Mercari: 7 like it in the last 21 days")
    }
}
