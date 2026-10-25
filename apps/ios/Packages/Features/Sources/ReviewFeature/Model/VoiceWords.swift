import Foundation

/// The words the voice parser maps to canonical values, by detail.
enum VoiceWords {
    static let conditionPhrases: [String: String] = [
        "new with tags": "new_with_tags", "nwt": "new_with_tags", "brand new with tags": "new_with_tags",
        "with tags": "new_with_tags", "tags attached": "new_with_tags", "tags still on": "new_with_tags",
        "new with tag": "new_with_tags", "new without tags": "new_without_tags", "nwot": "new_without_tags",
        "new no tags": "new_without_tags", "new without tag": "new_without_tags", "never worn": "new_without_tags",
        "unworn": "new_without_tags", "new with defects": "new_with_defects", "nwd": "new_with_defects",
        "excellent": "pre_owned_excellent", "excellent used": "pre_owned_excellent",
        "like new": "pre_owned_excellent", "mint": "pre_owned_excellent", "near mint": "pre_owned_excellent",
        "barely worn": "pre_owned_excellent", "worn once": "pre_owned_excellent", "euc": "pre_owned_excellent",
        "good": "pre_owned_good", "good used": "pre_owned_good", "gently used": "pre_owned_good",
        "gently worn": "pre_owned_good", "lightly worn": "pre_owned_good", "lightly used": "pre_owned_good",
        "great": "pre_owned_good", "very good": "pre_owned_good", "guc": "pre_owned_good",
        "fair": "pre_owned_fair", "fair used": "pre_owned_fair", "well worn": "pre_owned_fair",
        "well loved": "pre_owned_fair", "heavily worn": "pre_owned_fair", "worn": "pre_owned_fair",
        "pre owned excellent": "pre_owned_excellent", "pre owned good": "pre_owned_good",
        "pre owned fair": "pre_owned_fair",
    ]

    static let letterSizes: [String: String] = [
        "xxs": "XXS", "xx small": "XXS", "extra extra small": "XXS", "double extra small": "XXS", "2xs": "XXS",
        "xs": "XS", "x small": "XS", "extra small": "XS", "small": "S", "medium": "M", "med": "M",
        "large": "L", "xl": "XL", "x large": "XL", "extra large": "XL", "xxl": "XXL", "2xl": "XXL",
        "xx large": "XXL", "extra extra large": "XXL", "double extra large": "XXL", "double xl": "XXL",
        "xxxl": "XXXL", "3xl": "XXXL", "triple xl": "XXXL", "xxx large": "XXXL", "triple extra large": "XXXL",
    ]

    /// Single letters are sizes only after "size": "M" alone could be anything.
    static let letterOnly: [String: String] = ["s": "S", "m": "M", "l": "L"]

    static let oneSize: Set = ["one size", "one size fits all", "os", "osfa", "one size fits most"]

    static let departments: [String: String] = [
        "women": "women", "woman": "women", "women's": "women", "womens": "women", "ladies": "women",
        "ladies'": "women", "womenswear": "women", "female": "women",
        "men": "men", "man": "men", "men's": "men", "mens": "men", "menswear": "men", "male": "men",
        "kids": "kids", "kid's": "kids", "kids'": "kids", "children": "kids", "children's": "kids",
        "childrens": "kids", "boys": "kids", "boy's": "kids", "girls": "kids", "girl's": "kids",
        "toddler": "kids", "baby": "kids", "unisex": "unisex",
    ]

    static let colorNames: [String: String] = [
        "grey": "gray", "navy blue": "navy", "dark blue": "navy", "off white": "cream", "ivory": "cream",
        "khaki": "tan", "camel": "tan", "burgundy": "red", "maroon": "red", "wine": "red", "olive": "green",
        "forest green": "green", "charcoal": "gray", "light gray": "gray", "dark gray": "gray",
        "light grey": "gray", "dark grey": "gray", "light blue": "blue", "baby blue": "blue",
        "sky blue": "blue", "royal blue": "blue", "hot pink": "pink", "blush": "pink", "rose": "pink",
        "lavender": "purple", "lilac": "purple", "violet": "purple", "multi": "multicolor",
        "multicolored": "multicolor", "multi colored": "multicolor", "multi color": "multicolor",
        "multicolour": "multicolor", "rainbow": "multicolor", "golden": "gold", "chocolate": "brown",
    ]

    static let patternNames: [String: String] = [
        "stripes": "striped", "stripe": "striped", "pinstripe": "striped", "pinstriped": "striped",
        "tartan": "plaid", "checked": "plaid", "gingham": "plaid", "flowers": "floral", "flowered": "floral",
        "flower print": "floral", "polka dots": "polka_dot", "polka dotted": "polka_dot", "dotted": "polka_dot",
        "leopard": "animal_print", "leopard print": "animal_print", "cheetah": "animal_print",
        "cheetah print": "animal_print", "zebra": "animal_print", "zebra print": "animal_print",
        "snake print": "animal_print", "snakeskin": "animal_print", "camo": "camouflage",
        "graphic print": "graphic", "tie dyed": "tie_dye", "color block": "colorblock",
        "color blocked": "colorblock",
    ]

    static let materialNames: [String: String] = [
        "merino": "merino_wool", "vegan leather": "faux_leather", "pleather": "faux_leather",
        "sterling": "sterling_silver", "lycra": "spandex", "elastane": "spandex", "poly": "polyester",
        "genuine leather": "leather", "real leather": "leather", "real fur": "fur", "tencel": "lyocell",
    ]

    /// Materials that are also colors or common words; only after "made of" or "material".
    static let materialsNeedingPrefix: Set = ["gold", "metal", "plastic", "rubber", "wood", "down", "other"]

    /// Subcategory names a phrase can be on its own ("sweater", "jeans", "tee"), each with its
    /// path. A name in more than one category is left out, and so are activewear's tops,
    /// bottoms, and sets, which say too little on their own.
    static let categoryNames: [String: String] = {
        var names: [String: String] = [:]
        var ambiguous: Set = ["tops", "top", "bottoms", "bottom", "sets", "set"]
        for path in ItemVocabulary.shared.categoryPaths {
            guard let subcategory = path.split(separator: "/").last.map(String.init), subcategory != "other"
            else { continue }
            let name = subcategory.replacingOccurrences(of: "_", with: " ")
            for form in [name, singular(name)] {
                if names[form] != nil, names[form] != path {
                    ambiguous.insert(form)
                }
                names[form] = path
            }
        }
        for name in ambiguous {
            names[name] = nil
        }
        let synonyms = [
            "tee": "clothing/tops/t_shirts", "tees": "clothing/tops/t_shirts", "t shirt": "clothing/tops/t_shirts",
            "tshirt": "clothing/tops/t_shirts", "hoodie": "clothing/tops/hoodies_sweatshirts",
            "sweatshirt": "clothing/tops/hoodies_sweatshirts", "button up": "clothing/tops/shirts",
            "button down": "clothing/tops/shirts", "jumpsuit": "clothing/dresses/jumpsuits_rompers",
            "romper": "clothing/dresses/jumpsuits_rompers", "purse": "bags/handbags",
            "trainers": "shoes/sneakers", "tank": "clothing/tops/tank_tops",
        ]
        return names.merging(synonyms) { _, synonym in synonym }
    }()

    static func singular(_ name: String) -> String {
        if name.hasSuffix("sses") || name.hasSuffix("shes") || name.hasSuffix("ches") {
            return String(name.dropLast(2))
        }
        if name.hasSuffix("s"), !name.hasSuffix("ss"), !["jeans", "shorts", "pants", "leggings", "joggers"]
            .contains(name)
        {
            return String(name.dropLast())
        }
        return name
    }
}
