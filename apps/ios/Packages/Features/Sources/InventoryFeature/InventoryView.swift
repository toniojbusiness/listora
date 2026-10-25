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
                message: "Create an item once, and see where it's listed and what sold on every marketplace.",
                steps: [
                    "Take photos of the item",
                    "Check the details Listora suggests",
                    "List it on your marketplaces",
                ],
                action: .init("Add item", systemImage: "camera.fill", handler: onAddItem),
            )
            .navigationTitle("Inventory")
        }
    }
}

#Preview {
    InventoryView {}
}
