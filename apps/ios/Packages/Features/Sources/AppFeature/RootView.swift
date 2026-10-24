import AddItemFeature
import Core
import DesignSystem
import InventoryFeature
import SettingsFeature
import SwiftUI
import TasksFeature

/// The app's root: one tab per top-level area.
public struct RootView: View {
    private let dependencies: AppDependencies
    @State private var selection: AppTab

    public init(dependencies: AppDependencies, initialTab: AppTab = .inventory) {
        self.dependencies = dependencies
        _selection = State(initialValue: initialTab)
    }

    public var body: some View {
        TabView(selection: $selection) {
            ForEach(AppTab.allCases) { tab in
                Tab(tab.title, systemImage: tab.systemImage, value: tab) {
                    screen(for: tab)
                }
            }
        }
        .tint(Palette.brand.color)
    }

    @ViewBuilder
    private func screen(for tab: AppTab) -> some View {
        switch tab {
        case .inventory:
            InventoryView { selection = .addItem }
        case .addItem:
            AddItemView()
        case .tasks:
            TasksView()
        case .settings:
            SettingsView(content: SettingsContent(
                configuration: dependencies.configuration,
                version: dependencies.version,
            ))
        }
    }
}

#Preview {
    // swiftlint:disable:next force_try
    let configuration = try! AppConfiguration(environment: .dev, apiBaseURL: URL(string: "http://127.0.0.1:3000")!)
    RootView(dependencies: AppDependencies(
        configuration: configuration,
        version: AppVersion(marketing: "1.0", build: "1"),
    ))
}
