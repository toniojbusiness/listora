import DesignSystem
import SwiftUI

/// The seller's items and their status on every marketplace. Placeholder until T-19.
public struct InventoryView: View {
    private let onAddItem: @MainActor () -> Void

    public init(onAddItem: @escaping @MainActor () -> Void) {
        self.onAddItem = onAddItem
    }

    public var body: some View {
        NavigationStack {
            EmptyStateView(
                systemImage: "shippingbox",
                title: "No items yet",
                message: "Create an item once and see its status on every marketplace.",
                action: .init("Add item", handler: onAddItem),
            )
            .navigationTitle("Inventory")
        }
    }
}

#Preview {
    InventoryView {}
}
