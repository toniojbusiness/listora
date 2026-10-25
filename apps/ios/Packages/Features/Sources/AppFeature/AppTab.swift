/// The tabs of the root tab bar, in display order: five, so none goes to a More overflow, with Add
/// in the center. Settings is not a tab; the gear in the Today and Sales headers opens it.
public enum AppTab: String, CaseIterable, Identifiable, Sendable {
    case today
    case inventory
    case addItem
    case tasks
    case sales

    public var id: Self {
        self
    }

    public var title: String {
        switch self {
        case .today: "Today"
        case .inventory: "Inventory"
        case .addItem: "Add"
        case .tasks: "Tasks"
        case .sales: "Sales"
        }
    }

    /// Add's filled camera stands out among the outlined icons.
    public var systemImage: String {
        switch self {
        case .today: "sun.max"
        case .inventory: "shippingbox"
        case .addItem: "camera.circle.fill"
        case .tasks: "checklist"
        case .sales: "dollarsign.circle"
        }
    }
}
