import Core
import ListoraAPI

/// A marketplace's version of the listing before the seller touches it, as the List flow fills
/// its review and List all sends it: the marketplace's draft copy, else the seller's own copy from
/// the review if they edited it, else the analysis's copy for that marketplace, else the item's
/// title and description, with the item's measurements written into the Depop description
/// (``MeasurementCopy``); the price is the draft's, else the item's list price.
struct SuggestedCopy: Equatable, Sendable {
    var title: String
    var description: String
    var priceCents: Int?

    @MainActor
    static func load(
        for marketplace: String,
        item: Item,
        service: any InventoryService,
        listingCopy: ListingCopyStore,
    ) async -> SuggestedCopy {
        if let variant = item.listings.first(where: {
            $0.marketplace.id == marketplace && $0.status.value1 == .draft
        })?.variant {
            return SuggestedCopy(
                title: variant.title,
                description: variant.description,
                priceCents: Int(variant.price.amountCents),
            )
        }
        let edited = listingCopy.edits(itemID: item.id)[marketplace]
        var suggested: Components.Schemas.VariantSuggestion?
        if edited == nil, let analysisID = item.details.acceptedAnalysisId {
            suggested = try? await service.analysisVariants(analysisID: analysisID)
                .first { $0.marketplace.id == marketplace }
        }
        let description = edited?.description ?? suggested?.description ?? item.details.description ?? ""
        return SuggestedCopy(
            title: edited?.title ?? suggested?.title ?? item.details.title ?? "",
            description: MeasurementCopy.marketplaces.contains(marketplace)
                ? MeasurementCopy.written(measurements(of: item), into: description)
                : description,
            priceCents: item.details.listPrice.map { Int($0.amountCents) },
        )
    }

    /// The item's measurements in the order the description lists them.
    private static func measurements(of item: Item) -> [ItemMeasurement] {
        let measurements = (item.details.measurements ?? []).map {
            ItemMeasurement(name: $0.name, value: $0.value, unit: $0.unit == .cm ? .centimeters : .inches)
        }
        return ItemMeasurement.ordered(measurements, category: item.details.category)
    }
}
