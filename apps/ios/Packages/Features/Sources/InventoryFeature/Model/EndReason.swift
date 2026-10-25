import ListoraAPI

/// Why the seller ends a listing.
enum EndReason: String, CaseIterable, Identifiable {
    case soldElsewhere
    case notAvailable

    var id: Self {
        self
    }

    var title: String {
        switch self {
        case .soldElsewhere: "End: sold elsewhere"
        case .notAvailable: "End: no longer available"
        }
    }

    var contract: Components.Schemas.ListingEndReason {
        switch self {
        case .soldElsewhere: .soldElsewhere
        case .notAvailable: .notAvailable
        }
    }
}
