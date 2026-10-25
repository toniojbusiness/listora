import AddItemFeature
import APIClient
import Core
import DesignSystem
import InventoryFeature
import MarketplacesFeature
import SalesFeature
import SettingsFeature
import SwiftUI
import TasksFeature

/// The app's root: one tab per top-level area.
public struct RootView: View {
    private let dependencies: AppDependencies
    @State private var selection: AppTab
    @Environment(\.scenePhase) private var scenePhase

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
        .background { WindowTapCounter { [meter = dependencies.interactionMeter] in meter.recordTap() } }
        .onChange(of: scenePhase, initial: true) { _, phase in
            dependencies.interactionMeter.setAppActive(phase == .active)
        }
        .task { dependencies.startBackgroundWork() }
    }

    @ViewBuilder
    private func screen(for tab: AppTab) -> some View {
        switch tab {
        case .inventory:
            InventoryView(environment: dependencies.inventory) { selection = .addItem }
        case .sales:
            SalesView(environment: dependencies.sales)
        case .addItem:
            AddItemView(environment: dependencies.addItem)
        case .tasks:
            TasksView()
        case .settings:
            SettingsView(
                content: SettingsContent(configuration: dependencies.configuration, version: dependencies.version),
                devSignIn: dependencies.devSignIn,
            ) {
                MarketplacesView(model: dependencies.marketplaces)
            }
        }
    }
}

#Preview {
    // swiftlint:disable:next force_try
    let configuration = try! AppConfiguration(
        environment: .dev,
        apiBaseURL: URL(string: "http://127.0.0.1:3000")!,
        appGroupIdentifier: "group.com.listora.app.dev",
    )
    RootView(dependencies: AppDependencies(
        configuration: configuration,
        version: AppVersion(marketing: "1.0", build: "1"),
        dataDirectory: URL.temporaryDirectory.appending(path: "ListoraPreview"),
        accessGrantStorage: InMemoryAccessGrantStorage(),
    ))
}
