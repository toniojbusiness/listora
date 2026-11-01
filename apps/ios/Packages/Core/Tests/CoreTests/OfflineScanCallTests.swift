import Core
import Foundation
import Testing

/// The offline call's golden cases, which the server's test suite runs too
/// (`packages/sourcing/src/offline-call.test.ts` writes them): this app's copy of the rule and of
/// `brandKey` must answer every case as the server's does.
private struct GoldenCase: Decodable {
    let name: String
    let tagText: [String]
    let read: OfflineScanRead?
}

private struct GoldenBrandKey: Decodable {
    let brand: String
    let key: String?
}

private struct Golden: Decodable {
    let kit: SourcingKit
    let cases: [GoldenCase]
    let brandKeys: [GoldenBrandKey]
}

struct OfflineScanCallTests {
    private static func golden() throws -> Golden {
        let url = try #require(Bundle.module.url(
            forResource: "Fixtures/offline-scan-call",
            withExtension: "json",
        ))
        return try JSONDecoder().decode(Golden.self, from: Data(contentsOf: url))
    }

    @Test
    func `answers every golden case as the server's rule does`() throws {
        let golden = try Self.golden()
        #expect(golden.cases.count >= 10)
        for golden in golden.cases {
            let read = try OfflineScanCall.read(kit: Self.golden().kit, tagText: golden.tagText)
            #expect(read == golden.read, "\(golden.name)")
        }
    }

    @Test
    func `keys brands as the server does`() throws {
        let golden = try Self.golden()
        for sample in golden.brandKeys {
            #expect(BrandKey.of(sample.brand) == sample.key, "\(sample.brand)")
        }
        #expect(BrandKey.of(nil) == nil)
    }

    @Test
    func `decodes the server's insights from the golden kit`() throws {
        let insights = try #require(Self.golden().kit.insights)
        #expect(insights.soldCount == 12)
        #expect(insights.lookFor.map(\.brandKey) == ["lululemon"])
        #expect(insights.best.first?.medianDaysToSell == 9)
        #expect(insights.best.first?.medianPayout?.amountCents == 2100)
        #expect(insights.worst.first?.medianDaysToSell == nil)
        #expect(insights.worst.first?.category == "bags/handbags")
    }

    @Test
    func `ignores a kit of a format this app does not read`() throws {
        let kit = try Self.golden().kit
        let older = SourcingKit(version: 1, generatedAt: kit.generatedAt, call: kit.call, buckets: kit.buckets)
        #expect(OfflineScanCall.read(kit: kit, tagText: ["LULULEMON"]) != nil)
        #expect(OfflineScanCall.read(kit: older, tagText: ["LULULEMON"]) == nil)
    }
}
