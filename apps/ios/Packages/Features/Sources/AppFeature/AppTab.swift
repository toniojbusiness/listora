/// The tabs of the root tab bar, in display order.
public enum AppTab: String, CaseIterable, Identifiable, Sendable {
    case inventory
    case addItem
    case tasks
    case settings

    public var id: Self {
        self
    }

    public var title: String {
        switch self {
        case .inventory: "Inventory"
        case .addItem: "Add Item"
        case .tasks: "Tasks"
        case .settings: "Settings"
        }
    }

    public var systemImage: String {
        switch self {
        case .inventory: "shippingbox"
        case .addItem: "plus.circle"
        case .tasks: "checklist"
        case .settings: "gearshape"
        }
    }
}
