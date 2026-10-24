import ListoraAPI

/// What a photo shows. The raw values are the contract's `PhotoRole`, so a draft's roles go to
/// the server unchanged.
enum PhotoRole: String, Codable, CaseIterable, Sendable {
    case front
    case back
    case tag
    case flaw
    case detail

    var title: String {
        switch self {
        case .front: "Front"
        case .back: "Back"
        case .tag: "Tag"
        case .flaw: "Flaw"
        case .detail: "Detail"
        }
    }

    var contract: Components.Schemas.PhotoRole {
        switch self {
        case .front: .front
        case .back: .back
        case .tag: .tag
        case .flaw: .flaw
        case .detail: .detail
        }
    }

    /// The role an imported photo gets from its place in the selection: the first two are usually
    /// the front and back; the user changes any of them in the editor.
    static func defaultRole(forImportAt index: Int) -> PhotoRole {
        switch index {
        case 0: .front
        case 1: .back
        default: .detail
        }
    }
}
