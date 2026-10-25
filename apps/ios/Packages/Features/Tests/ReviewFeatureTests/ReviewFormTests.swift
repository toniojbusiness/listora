import Core
import ListoraAPI
import Testing
@testable import ReviewFeature

struct ReviewFormTests {
    let form = ReviewForm(item: Fixtures.appliedItem(), result: Fixtures.result())

    @Test
    func `puts the low-confidence details first, the least certain at the top`() {
        // Brand 0.45 and colors 0.55 are below 0.6; condition at 0.7 is not.
        #expect(form.attention == [.brand, .colors])
        #expect(form.sections.map(\.section) == [.attention, .details, .condition, .copy])
        #expect(form.sections.first?.keys == [.brand, .colors])
        #expect(form.sections.dropFirst().allSatisfy { !$0.keys.contains(.brand) && !$0.keys.contains(.colors) })
        let brand = form.field(.brand)
        #expect(brand.isLowConfidence)
        #expect(brand.confidence == 0.45)
        #expect(!form.field(.condition).needsAttention)
    }

    @Test
    func `asks first for what every marketplace needs when it is missing`() {
        var item = Fixtures.appliedItem()
        item.details.category = nil
        item.details.condition = nil
        var result = Fixtures.result()
        result.details.category = nil
        result.details.condition = nil
        let form = ReviewForm(item: item, result: result)
        #expect(form.attention == [.category, .condition, .brand, .colors])
        #expect(form.field(.category).isMissing)
        #expect(form.missing == [.category, .condition])
    }

    @Test
    func `asks for the size of clothing and shoes, which every marketplace needs, and no other item's`() {
        var item = Fixtures.appliedItem()
        item.details.sizeLabel = nil
        var result = Fixtures.result()
        result.details.sizeLabel = nil
        var form = ReviewForm(item: item, result: result)
        #expect(form.attention == [.sizeLabel, .brand, .colors])
        #expect(form.missing == [.sizeLabel])
        #expect(ReviewFieldKey.sizeLabel.inlineTitle == "size")

        form.set(.category, to: .text("shoes/sneakers"))
        #expect(form.missing == [.sizeLabel])
        form.set(.category, to: .text("bags/totes"))
        #expect(form.missing.isEmpty, "a bag has no size to ask for")
        form.set(.category, to: .text("clothing/bottoms/jeans"))
        form.set(.sizeLabel, to: .text("One size"))
        #expect(form.missing.isEmpty)
    }

    @Test
    func `writes a detail's name lowercase inside a sentence, keeping abbreviations`() {
        #expect(ReviewFieldKey.productName.inlineTitle == "product name")
        #expect(ReviewFieldKey.upc.inlineTitle == "UPC")
        #expect(ReviewFieldKey.rnNumber.inlineTitle == "RN number")
    }

    @Test
    func `shows where each value came from`() {
        #expect(form.field(.title).provenance == .ai)
        #expect(form.field(.brand).provenance == .tag)
        #expect(form.field(.upc).provenance == .barcode)
        #expect(form.field(.rnNumber).provenance == nil, "nothing found, nothing entered")
        #expect(ReviewProvenance.tag.label == "Tag")
        #expect(ReviewProvenance.user.label == "You")
    }

    @Test
    func `an edit is the seller's, keeps its place, and loses its highlight`() {
        var form = form
        form.set(.brand, to: .text("Acme"))
        let brand = form.field(.brand)
        #expect(brand.provenance == .user)
        #expect(brand.confidence == nil)
        #expect(!brand.needsAttention)
        #expect(form.attention == [.brand, .colors], "rows never jump while editing")
        #expect(form.hasEdits)

        // Typing the proposal back gives the value its source again.
        form.set(.brand, to: .text("Acme Outfitters"))
        #expect(form.field(.brand).provenance == .tag)
        #expect(form.field(.brand).isLowConfidence)
    }

    @Test
    func `the server's user provenance is never highlighted`() {
        var item = Fixtures.appliedItem()
        item.fieldProvenance?.additionalProperties["colors"] = .init(value1: .user, value2: "user")
        let form = ReviewForm(item: item, result: Fixtures.result())
        #expect(form.field(.colors).provenance == .user)
        #expect(form.attention == [.brand])
    }

    @Test
    func `a source this app does not know is not the seller's, so it is still checked`() {
        var item = Fixtures.appliedItem()
        item.fieldProvenance?.additionalProperties["brand"] = .init(value2: "vision")
        let form = ReviewForm(item: item, result: Fixtures.result())
        #expect(form.field(.brand).provenance == .other("vision"))
        #expect(form.field(.brand).isLowConfidence)
    }

    @Test
    func `keeps an earlier order when rebuilt after saving edits`() {
        var item = Fixtures.appliedItem()
        item.fieldProvenance?.additionalProperties["brand"] = .init(value1: .user, value2: "user")
        item.details.brand = "Acme"
        let rebuilt = ReviewForm(item: item, result: Fixtures.result(), attention: form.attention)
        #expect(rebuilt.attention == [.brand, .colors])
        #expect(rebuilt.field(.brand).provenance == .user)
    }

    @Test
    func `writes edits over newer server details`() {
        var form = form
        form.set(.brand, to: .text("Acme"))
        form.set(.colors, to: FieldValue.parse("red, navy ,", as: .list))
        var newer = Fixtures.appliedItem().details
        newer.title = "Changed elsewhere"
        let merged = form.applyingEdits(to: newer)
        #expect(merged.brand == "Acme")
        #expect(merged.colors == ["red", "navy"])
        #expect(merged.title == "Changed elsewhere")
        form.set(.pattern, to: .text(""))
        #expect(form.applyingEdits(to: newer).pattern == nil, "an empty value is absent")
    }

    @Test
    func `makes Identify harder prominent when the brand is missing or a guess`() {
        #expect(form.identifyHarder(result: Fixtures.result()) == .prominent(reason: "The brand is a guess."))

        var noBrand = Fixtures.appliedItem()
        noBrand.details.brand = nil
        var result = Fixtures.result(needsEscalation: false)
        result.details.brand = nil
        #expect(ReviewForm(item: noBrand, result: result).identifyHarder(result: result)
            == .prominent(reason: "Listora couldn't find the brand."))

        var sure = Fixtures.result(needsEscalation: false)
        sure.details.brand = Fixtures.text("Acme Outfitters", 0.95, .ocr)
        #expect(ReviewForm(item: Fixtures.appliedItem(), result: sure).identifyHarder(result: sure) == .available)

        var asked = sure
        asked.needsEscalation = true
        asked.escalationReason = "Looks vintage."
        #expect(ReviewForm(item: Fixtures.appliedItem(), result: asked).identifyHarder(result: asked)
            == .prominent(reason: "Looks vintage."))
    }

    @Test
    func `every detail reads back what was written, and an empty value is absent`() {
        for key in ReviewFieldKey.allCases {
            var details = Schemas.ItemDetails()
            let value: FieldValue = switch key.kind {
            case .list: .list(["one", "two"])
            case .choice where key == .condition: .text("pre_owned_fair")
            default: .text("value of \(key.rawValue)")
            }
            details.set(key, to: value)
            #expect(details.value(key) == value, "\(key)")
            details.set(key, to: key.kind == .list ? .list([]) : .text(""))
            #expect(details.value(key).isEmpty, "\(key)")
            #expect(details == Schemas.ItemDetails(), "\(key) is absent once empty")
        }
    }

    @Test
    func `shows canonical values in words`() {
        #expect(form.field(.category).displayValue == "Clothing › Tops › Shirts")
        #expect(form.field(.condition).displayValue == "Pre-owned, good")
        #expect(form.field(.sizeSystem).displayValue == "Letter (XS to XXXL)")
        #expect(form.field(.colors).displayValue == "Red, Black")
        #expect(ItemVocabulary.categoryName("clothing/tops/t_shirts") == "Clothing › Tops › T-shirts")
        #expect(ItemVocabulary.categoryName("toys/puzzles") == "Toys › Puzzles", "unknown values still read")
        #expect(ItemVocabulary.shared.categoryPaths.contains("bags/totes"))
        #expect(ItemVocabulary.shared.conditions == Components.Schemas.ItemCondition.allCases.map(\.rawValue))
    }
}

struct MarketplaceCopyTests {
    @Test
    func `merges the analysis's copy with the seller's edits`() {
        let edit = ListingCopyFixture.ebayEdit
        let copies = MarketplaceCopy.copies(result: Fixtures.result(), edits: ["ebay": edit])
        #expect(copies.map(\.marketplace) == ["ebay", "depop"])
        #expect(copies[0].current == edit)
        #expect(copies[1].edited == nil)
        #expect(copies[1].current.hashtags == ["flannel", "plaid"])
        #expect(!copies[1].hasTitle)
    }

    @Test
    func `checks each marketplace's limits`() {
        let long = String(repeating: "x", count: 81)
        #expect(MarketplaceCopy.problems(of: .init(title: long, description: ""), marketplace: "ebay")
            == ["The title is 81 characters; eBay allows 80."])
        // Depop has no title, and its hashtags count toward the description.
        let depop = MarketplaceCopy.problems(
            of: .init(title: long, description: String(repeating: "y", count: 990), hashtags: ["flannel", "plaid"]),
            marketplace: "depop",
        )
        #expect(depop == ["The description with its hashtags is 1007 characters; Depop allows 1000."])
        #expect(MarketplaceCopy.problems(of: .init(title: "Fine", description: "Fine"), marketplace: "mercari").isEmpty)
    }
}

enum ListingCopyFixture {
    static let ebayEdit = ListingCopy(title: "Acme flannel shirt M", description: "Soft flannel, no flaws.")
}
