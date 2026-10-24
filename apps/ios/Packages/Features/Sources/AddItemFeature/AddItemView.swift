import DesignSystem
import SwiftUI

/// Photo capture and the AI-drafted item. Placeholder until T-12.
public struct AddItemView: View {
    public init() {}

    public var body: some View {
        NavigationStack {
            EmptyStateView(
                systemImage: "camera",
                title: "Take photos once",
                message: "Photograph an item and Listora drafts one listing you can publish everywhere.",
            )
            .navigationTitle("Add Item")
        }
    }
}

#Preview {
    AddItemView()
}
