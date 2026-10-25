import DesignSystem
import SwiftUI

/// Steps that need the seller, such as assisted listings and delist alerts. Placeholder until
/// T-21.
public struct TasksView: View {
    public init() {}

    public var body: some View {
        NavigationStack {
            EmptyStateView(
                systemImage: "checkmark.circle",
                tone: .success,
                title: "You're all caught up",
                message: "Marketplace steps that need you, like finishing a Poshmark listing, show up here.",
            )
            .navigationTitle("Tasks")
        }
    }
}

#Preview {
    TasksView()
}
