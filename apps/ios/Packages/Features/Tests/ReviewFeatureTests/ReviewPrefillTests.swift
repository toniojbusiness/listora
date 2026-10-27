import APIClient
import Foundation
import ListoraAPI
import Testing
@testable import ReviewFeature

/// The marketplace pre-fill on the review: read with the review's details, asked again after an
/// edit of one it reads, its questions answered with one tap, and Continue held until they are.
@MainActor
struct ReviewPrefillTests {
    let harness = ReviewFlowHarness()

    private static func option(_ value: String, _ label: String, path: [String]? = nil) -> Schemas.PrefillOption {
        Schemas.PrefillOption(value: value, label: label, path: path)
    }

    private static func prefill(questions: Int, chosen: String? = nil) -> Schemas.ItemMarketplacePrefill {
        let men = option("Men > Tops > T-shirts", "Men", path: ["Men", "Tops", "T-shirts"])
        let women = option("Women > Tops > T-shirts", "Women", path: ["Women", "Tops", "T-shirts"])
        let value = chosen == women.value ? women : (questions > 0 ? nil : men)
        let category = Schemas.PrefillField(
            key: .init(value1: .category, value2: "category"),
            label: "Category",
            value: value,
            options: [men, women],
            source: value == nil ? nil : .init(
                value1: chosen == nil ? ._default : .you,
                value2: chosen == nil ? "default" : "you",
            ),
            needsAnswer: questions > 0,
            note: "Depop has no unisex department, so unisex items go under Men.",
        )
        return Schemas.ItemMarketplacePrefill(
            itemFields: [],
            marketplaces: [
                Schemas.MarketplacePrefill(
                    marketplace: .init(value1: .depop, value2: "depop"),
                    connected: true,
                    ready: questions == 0,
                    fields: [category],
                ),
                Schemas.MarketplacePrefill(
                    marketplace: .init(value1: .mercari, value2: "mercari"),
                    connected: false,
                    ready: true,
                    fields: [],
                ),
            ],
            questions: questions,
        )
    }

    @Test
    func `reads the pre-fill with the review's details and shows the linked marketplaces only`() async throws {
        await harness.scriptHappyPath()
        await harness.service.setPrefill([.success(Self.prefill(questions: 0))])
        let model = harness.model()
        await model.start()

        let reads = await harness.service.prefillReads
        let details = try #require(reads.first)
        #expect(details.category == model.form?.details.category ?? "")
        #expect(model.prefillMarketplaces.map(\.marketplace.id) == ["depop"])
        #expect(model.marketplaceQuestions == 0)
    }

    @Test
    func `asks again after an edit of a detail the pre-fill reads, and not after others`() async {
        await harness.scriptHappyPath()
        await harness.service.setPrefill([.success(Self.prefill(questions: 0))])
        let model = harness.model()
        await model.start()

        model.update(.title, to: .text("A new title"))
        await model.prefillRefresh?.value
        #expect(await harness.service.prefillReads.count == 1)

        model.update(.department, to: .text("women"))
        await model.prefillRefresh?.value
        let reads = await harness.service.prefillReads
        #expect(reads.count == 2)
        #expect(reads.last?.department == "women", "the unsaved edit, before it is saved")
    }

    @Test
    func `holds Continue until the seller taps one of the short list`() async throws {
        await harness.scriptHappyPath()
        await harness.service.setPrefill([.success(Self.prefill(questions: 1))])
        await harness.service.setPrefillAnswers([.success(Self.prefill(
            questions: 0,
            chosen: "Women > Tops > T-shirts",
        ))])
        let model = harness.model()
        await model.start()
        #expect(model.marketplaceQuestions == 1)

        await model.answerPrefill(field: .category, marketplace: "depop", value: "Women > Tops > T-shirts")
        let answer = try #require(await harness.service.prefillAnswers.first)
        #expect(answer.marketplace == .depop)
        #expect(answer.field == .category)
        #expect(answer.value == "Women > Tops > T-shirts")
        #expect(model.marketplaceQuestions == 0)
        let category = model.prefillMarketplaces.first?.fields.first
        #expect(category?.value?.label == "Women")
        #expect(category?.source?.value1 == .you)
    }

    @Test
    func `a refused answer shows the server's reason and keeps the question`() async {
        await harness.scriptHappyPath()
        await harness.service.setPrefill([.success(Self.prefill(questions: 1))])
        await harness.service.setPrefillAnswers([
            .failure(.server(
                422,
                "validation_failed",
                "That choice isn’t offered for this item. Pick one from the list.",
            )),
        ])
        let model = harness.model()
        await model.start()

        await model.answerPrefill(field: .category, marketplace: "depop", value: "Women > Hovercraft")
        #expect(model.actionError == "That choice isn’t offered for this item. Pick one from the list.")
        #expect(model.marketplaceQuestions == 1)
    }

    @Test
    func `a pre-fill the server can't give leaves the review as it is`() async {
        await harness.scriptHappyPath()
        await harness.service.setPrefill([.failure(.server(500, "internal_error", "Something went wrong."))])
        let model = harness.model()
        await model.start()
        #expect(model.phase == .reviewing)
        #expect(model.prefill == nil)
        #expect(model.marketplaceQuestions == 0)
        #expect(model.actionError == nil)
    }
}
