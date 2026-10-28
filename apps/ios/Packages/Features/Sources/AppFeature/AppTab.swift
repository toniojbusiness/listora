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

    /// Inventory is a hanger, where the items hang; Add's camera is printed on the clay tag that
    /// hangs from the tab rail.
    public var systemImage: String {
        switch self {
        case .today: "sun.max"
        case .inventory: "hanger"
        case .addItem: "camera"
        case .tasks: "checklist"
        case .sales: "dollarsign.circle"
        }
    }

    /// Add is the tag hanging from the rail: the app's main way in.
    public var isTag: Bool {
        self == .addItem
    }

    /// How VoiceOver reads the tab's badge of `count`.
    public func badgeDescription(_ count: Int) -> String? {
        switch self {
        case .inventory: "\(count) need you"
        case .tasks: count == 1 ? "1 open task" : "\(count) open tasks"
        case .today, .addItem, .sales: nil
        }
    }
}
