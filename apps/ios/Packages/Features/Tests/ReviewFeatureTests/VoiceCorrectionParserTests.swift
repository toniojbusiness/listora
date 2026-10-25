import Testing
@testable import ReviewFeature

struct VoiceCorrectionParserTests {
    private func parse(_ text: String, _ context: VoiceParseContext = VoiceParseContext()) -> VoiceParse {
        VoiceCorrectionParser.parse(text, context: context)
    }

    private func changes(_ text: String, _ context: VoiceParseContext = VoiceParseContext()) -> [VoiceChange] {
        let parse = parse(text, context)
        #expect(parse.unmatched.isEmpty, "unmatched: \(parse.unmatched)")
        return parse.changes
    }

    private static let medium: [VoiceChange] = [.set(.sizeLabel, .text("M")), .set(.sizeSystem, .text("letter"))]

    // MARK: The captain's example

    @Test
    func `reads the size, the flaw, and the price paid with where it was bought`() {
        let parse = parse("Size medium, small stain on the left cuff, paid four dollars at Goodwill.")
        #expect(parse.changes == Self.medium + [
            .add(.flaws, "Small stain on the left cuff"),
            .cost(400),
            .purchaseSource("Goodwill"),
        ])
        #expect(parse.unmatched.isEmpty)
    }

    @Test
    func `reads the same correction without punctuation, joined by and`() {
        #expect(changes("size medium and small stain on the left cuff and paid $4 at goodwill") == Self.medium + [
            .add(.flaws, "Small stain on the left cuff"),
            .cost(400),
            .purchaseSource("Goodwill"),
        ])
    }

    // MARK: Sizes

    @Test(arguments: [
        ("size medium", "M"), ("Size M", "M"), ("size small", "S"), ("size s", "S"), ("it's a large", "L"),
        ("medium", "M"), ("um it's a medium", "M"), ("size extra large", "XL"), ("size XL", "XL"),
        ("size x-large", "XL"), ("size XXL", "XXL"), ("size 2XL", "XXL"), ("size double extra large", "XXL"),
        ("size extra small", "XS"), ("size XS", "XS"), ("size XXS", "XXS"), ("size 3XL", "XXXL"),
        ("the size is medium", "M"), ("sized large", "L"),
    ])
    func `reads letter sizes`(text: String, label: String) {
        #expect(changes(text) == [.set(.sizeLabel, .text(label)), .set(.sizeSystem, .text("letter"))])
    }

    @Test(arguments: [
        ("size 8", "8", "numeric"), ("size eight", "8", "numeric"), ("size 10 and a half", "10.5", "numeric"),
        ("size 8.5", "8.5", "numeric"), ("size 32 by 30", "32x30", "waist_inseam"),
        ("size thirty two by thirty", "32x30", "waist_inseam"), ("size 34x32", "34x32", "waist_inseam"),
        ("size US 9", "9", "us"), ("size UK 10", "10", "uk"), ("size EU 40", "40", "eu"),
        ("one size", "One size", "one_size"), ("size one size fits all", "One size", "one_size"),
    ])
    func `reads numeric, waist and inseam, regional, and one sizes`(text: String, label: String, system: String) {
        #expect(changes(text) == [.set(.sizeLabel, .text(label)), .set(.sizeSystem, .text(system))])
    }

    @Test
    func `reads a plain number as a US size on shoes`() {
        let shoes = VoiceParseContext(category: "shoes/sneakers")
        #expect(changes("size 9", shoes) == [.set(.sizeLabel, .text("9")), .set(.sizeSystem, .text("us"))])
    }

    @Test
    func `reads the department with the size`() {
        #expect(changes("women's medium") == [.set(.department, .text("women"))] + Self.medium)
        #expect(changes("men's size 32 by 30") == [
            .set(.department, .text("men")),
            .set(.sizeLabel, .text("32x30")),
            .set(.sizeSystem, .text("waist_inseam")),
        ])
        #expect(changes("for kids") == [.set(.department, .text("kids"))])
        #expect(changes("womens") == [.set(.department, .text("women"))])
    }

    @Test
    func `leaves a lone letter or number to the text model, since it could be anything`() {
        #expect(parse("M").unmatched == ["M"])
        #expect(parse("eight").unmatched == ["eight"])
    }

    // MARK: Colors, patterns, materials

    @Test(arguments: [
        ("navy", ["navy"]), ("it's grey", ["gray"]), ("the color is navy blue", ["navy"]),
        ("black and white", ["black", "white"]), ("colors cream, tan and brown", ["cream", "tan", "brown"]),
        ("off-white", ["cream"]), ("burgundy colored", ["red"]), ("multicolored", ["multicolor"]),
        ("Blue/white", ["blue", "white"]),
    ])
    func `reads colors as canonical values that replace the detail's`(text: String, colors: [String]) {
        #expect(changes(text) == [.set(.colors, .list(colors))])
    }

    @Test(arguments: [
        ("striped", "striped"), ("stripes", "striped"), ("the pattern is plaid", "plaid"),
        ("polka dot", "polka_dot"), ("leopard print", "animal_print"), ("camo", "camouflage"),
        ("tie-dye", "tie_dye"), ("floral", "floral"),
    ])
    func `reads patterns`(text: String, pattern: String) {
        #expect(changes(text) == [.set(.pattern, .text(pattern))])
    }

    @Test(arguments: [
        ("100% cotton", ["cotton"]), ("made of wool", ["wool"]), ("cotton and polyester", ["cotton", "polyester"]),
        ("60% cotton 40% polyester", ["cotton", "polyester"]), ("material is denim", ["denim"]),
        ("vegan leather", ["faux_leather"]), ("merino wool", ["merino_wool"]), ("made of gold", ["gold"]),
    ])
    func `reads materials`(text: String, materials: [String]) {
        #expect(changes(text) == [.set(.materials, .list(materials))])
    }

    @Test
    func `reads gold alone as a color, not a material`() {
        #expect(changes("gold") == [.set(.colors, .list(["gold"]))])
    }

    // MARK: Condition and flaws

    @Test(arguments: [
        ("new with tags", "new_with_tags"), ("NWT", "new_with_tags"), ("tags attached", "new_with_tags"),
        ("new without tags", "new_without_tags"), ("NWOT", "new_without_tags"), ("never worn", "new_without_tags"),
        ("new with defects", "new_with_defects"), ("excellent condition", "pre_owned_excellent"),
        ("like new", "pre_owned_excellent"), ("in good condition", "pre_owned_good"),
        ("good used condition", "pre_owned_good"), ("gently used", "pre_owned_good"),
        ("condition is fair", "pre_owned_fair"), ("well worn", "pre_owned_fair"),
    ])
    func `reads condition words`(text: String, condition: String) {
        #expect(changes(text) == [.set(.condition, .text(condition))])
    }

    @Test(arguments: [
        ("small stain on the left cuff", "Small stain on the left cuff"),
        ("there's a tiny hole near the hem", "Tiny hole near the hem"),
        ("it has some pilling under the arms", "Some pilling under the arms"),
        ("missing a button", "Missing a button"),
        ("slight fading on the collar", "Slight fading on the collar"),
        ("the left cuff is frayed", "Left cuff is frayed"),
        ("scuffs on the toe", "Scuffs on the toe"),
    ])
    func `reads a phrase that names a flaw as that flaw`(text: String, flaw: String) {
        #expect(changes(text) == [.add(.flaws, flaw)])
    }

    @Test
    func `splits two flaws joined by and`() {
        #expect(changes("a stain on the sleeve and a hole in the pocket") == [
            .add(.flaws, "Stain on the sleeve"),
            .add(.flaws, "Hole in the pocket"),
        ])
    }

    @Test
    func `reads no flaws as clearing them`() {
        #expect(changes("no flaws") == [.set(.flaws, .list([]))])
        #expect(changes("no stains or holes") == [.set(.flaws, .list([]))])
    }

    // MARK: Money

    @Test(arguments: [
        ("paid four dollars", 400), ("paid $4", 400), ("I paid 4.50", 450), ("paid four fifty", 450),
        ("cost me three bucks", 300), ("paid a dollar", 100), ("paid four dollars and fifty cents", 450),
        ("bought it for twelve ninety nine", 1299), ("paid 25 dollars", 2500), ("paid $1,200", 120_000),
        ("paid fifty cents", 50), ("paid twenty five", 2500), ("spent a hundred", 10000),
    ])
    func `reads the price paid`(text: String, cents: Int64) {
        #expect(changes(text) == [.cost(cents)])
    }

    @Test(arguments: [
        ("price at 30", 3000), ("price it at $29.99", 2999), ("list it for thirty", 3000),
        ("sell for twenty five dollars", 2500), ("asking 40", 4000), ("list price is 18", 1800),
    ])
    func `reads the price to list at`(text: String, cents: Int64) {
        #expect(changes(text) == [.listPrice(cents)])
    }

    @Test
    func `does not read a zero list price`() {
        #expect(parse("price at zero").changes.isEmpty)
    }

    // MARK: Where it was bought

    @Test(arguments: [
        ("from Goodwill", "Goodwill"), ("got it at the salvation army", "Salvation Army"),
        ("bought at an estate sale", "Estate Sale"), ("thrifted it at Savers", "Savers"),
    ])
    func `reads where it was bought`(text: String, source: String) {
        #expect(changes(text) == [.purchaseSource(source)])
    }

    @Test
    func `spells a source the seller used before their way`() {
        let context = VoiceParseContext(recentSources: ["GoodWill Bins"])
        #expect(changes("from goodwill bins", context) == [.purchaseSource("GoodWill Bins")])
    }

    @Test
    func `reads the source and the price in either order`() {
        #expect(changes("got it at goodwill for three dollars") == [.purchaseSource("Goodwill"), .cost(300)])
        #expect(changes("paid 3 from the bins") == [.cost(300), .purchaseSource("Bins")])
    }

    @Test
    func `leaves an era to the text model rather than reading it as a source`() {
        #expect(parse("it's from the nineties").unmatched == ["it's from the nineties"])
    }

    // MARK: Named details

    @Test
    func `reads the brand, capitalizing it when the transcript did not`() {
        #expect(changes("brand Patagonia") == [.set(.brand, .text("Patagonia"))])
        #expect(changes("the brand is free people") == [.set(.brand, .text("Free People"))])
        #expect(changes("made by Levi's") == [.set(.brand, .text("Levi's"))])
        #expect(changes("brand is J.Crew") == [.set(.brand, .text("J.Crew"))])
    }

    @Test
    func `reads the category from the item's kind`() {
        #expect(changes("it's a sweater") == [.set(.category, .text("clothing/tops/sweaters"))])
        #expect(changes("jeans") == [.set(.category, .text("clothing/bottoms/jeans"))])
        #expect(changes("a pair of sneakers") == [.set(.category, .text("shoes/sneakers"))])
        #expect(changes("category is t-shirt") == [.set(.category, .text("clothing/tops/t_shirts"))])
        #expect(changes("dress") == [.set(.category, .text("clothing/dresses/dresses"))])
    }

    @Test
    func `reads details said by name`() {
        #expect(changes("title vintage Levi's 501 jeans") == [.set(.title, .text("Vintage Levi's 501 jeans"))])
        #expect(changes("style number ab 1234") == [.set(.styleNumber, .text("AB1234"))])
        #expect(changes("keywords y2k and streetwear") == [.add(.keywords, "y2k"), .add(.keywords, "streetwear")])
        #expect(changes("notes light wear on the cuffs") == [.set(.conditionNotes, .text("Light wear on the cuffs"))])
        #expect(changes("model name Better Sweater") == [.set(.productName, .text("Better Sweater"))])
    }

    // MARK: Phrases it does not understand

    @Test
    func `returns what it cannot map, as said, and ignores filler`() {
        let parse = parse("Um, size large, the logo has a cool retro vibe, okay that's it.")
        #expect(parse.changes == [.set(.sizeLabel, .text("L")), .set(.sizeSystem, .text("letter"))])
        #expect(parse.unmatched == ["the logo has a cool retro vibe"])
    }

    @Test
    func `keeps a mapped part of a phrase and returns the rest`() {
        let parse = parse("size medium and it's from the eighties")
        #expect(parse.changes == Self.medium)
        #expect(parse.unmatched == ["it's from the eighties"])
    }

    @Test
    func `lets a later change to a detail replace an earlier one`() {
        #expect(changes("size small, no wait, size medium") == Self.medium)
        #expect(changes("paid 3, actually paid 4") == [.cost(400)])
    }

    @Test
    func `answers nothing for silence`() {
        #expect(parse("").changes.isEmpty)
        #expect(parse("  ").unmatched.isEmpty)
        #expect(parse("um, uh").unmatched.isEmpty)
    }
}

struct SpokenAmountTests {
    @Test(arguments: [
        ("4", 400), ("$4", 400), ("4.5", 450), ("$4.99", 499), ("four", 400), ("forty two", 4200),
        ("four dollars", 400), ("4 bucks", 400), ("a buck", 100), ("four fifty", 450),
        ("four dollars fifty", 450), ("four dollars and fifty cents", 450), ("ninety nine cents", 99),
        ("a hundred", 10000), ("one hundred and twenty", 12000), ("two thousand", 200_000), ("1,200", 120_000),
        ("twelve ninety-nine", 1299),
    ])
    func `reads amounts`(text: String, cents: Int64) {
        #expect(SpokenAmount.cents(text) == cents)
    }

    @Test(arguments: ["", "a lot", "four and", "dollars", "4.555", "a hundred thousand", "five five five"])
    func `refuses what is not one amount`(text: String) {
        #expect(SpokenAmount.cents(text) == nil)
    }
}
