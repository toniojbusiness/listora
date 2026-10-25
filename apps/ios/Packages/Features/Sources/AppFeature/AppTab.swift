/// The tabs of the root tab bar, in display order.
public enum AppTab: String, CaseIterable, Identifiable, Sendable {
    case inventory
    case sales
    case addItem
    case tasks
    case settings

    public var id: Self {
        self
    }

    public var title: String {
        switch self {
        case .inventory: "Inventory"
        case .sales: "Sales"
        case .addItem: "Add Item"
        case .tasks: "Tasks"
        case .settings: "Settings"
        }
    }

    public var systemImage: String {
        switch self {
        case .inventory: "shippingbox"
        case .sales: "dollarsign.circle"
        case .addItem: "camera"
        case .tasks: "checklist"
        case .settings: "gearshape"
        }
    }
}
