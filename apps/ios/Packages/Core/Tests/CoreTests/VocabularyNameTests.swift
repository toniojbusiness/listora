import Core
import Testing

struct VocabularyNameTests {
    @Test
    func `reads a category path as words`() {
        #expect(VocabularyName.category("clothing/tops/t_shirts") == "Clothing › Tops › T-shirts")
        #expect(VocabularyName.category("shoes/dress_shoes") == "Shoes › Dress shoes")
    }

    @Test
    func `humanizes an id, with the overrides for awkward ones`() {
        #expect(VocabularyName.humanize("tank_tops") == "Tank tops")
        #expect(VocabularyName.humanize("hoodies_sweatshirts") == "Hoodies & sweatshirts")
    }

    @Test
    func `names a category's item type for a phrase, the level above for other`() {
        #expect(VocabularyName.itemType("clothing/bottoms/leggings") == "leggings")
        #expect(VocabularyName.itemType("clothing/tops/t_shirts") == "t-shirts")
        #expect(VocabularyName.itemType("bags/other") == "bags")
        #expect(VocabularyName.itemType("other/other") == "other")
    }
}
