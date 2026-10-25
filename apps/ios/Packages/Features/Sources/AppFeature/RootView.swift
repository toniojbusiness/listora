import AddItemFeature
import APIClient
import Core
import DesignSystem
import InventoryFeature
import MarketplaceLinkingFeature
import MarketplacesFeature
import SalesFeature
import SettingsFeature
import SwiftUI
import TasksFeature

/// The app's root: one tab per top-level area. While a marketplace connection needs attention,
/// Inventory shows the connection banner, which opens Marketplaces in Settings, and the
/// Settings tab has a badge.
public struct RootView: View {
    private let dependencies: AppDependencies
    @State private var selection: AppTab
    @State private var settingsPath: [SettingsDestination] = []
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
                .badge(badgeCount(for: tab))
            }
        }
        // A new palette theme (Dev) redraws every screen in it.
        .id(dependencies.paletteSwitch?.selection)
        .tint(Palette.brand.color)
        .solidBarEdges()
        .background { WindowTapCounter { [meter = dependencies.interactionMeter] in meter.recordTap() } }
        .onChange(of: scenePhase, initial: true) { _, phase in
            dependencies.interactionMeter.setAppActive(phase == .active)
            if phase == .active {
                Task { await dependencies.marketplaces.refreshAttention() }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: TaskNotificationRouter.openTasks)) { _ in
            selection = .tasks
        }
        .task { dependencies.startBackgroundWork() }
        // The badge follows the server while the app is open, and when it comes back.
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            await dependencies.tasks.inbox.follow()
        }
    }

    /// Settings counts the connections that need the seller, Tasks the open tasks.
    private func badgeCount(for tab: AppTab) -> Int {
        switch tab {
        case .settings: dependencies.marketplaces.attention?.count ?? 0
        case .tasks: dependencies.tasks.inbox.openCount
        case .inventory, .sales, .addItem: 0
        }
    }

    @ViewBuilder
    private func screen(for tab: AppTab) -> some View {
        switch tab {
        case .inventory:
            InventoryView(
                environment: dependencies.inventory,
                onAddItem: { selection = .addItem },
                header: {
                    ConnectionAttentionBanner(model: dependencies.marketplaces) {
                        settingsPath = [.marketplaces]
                        selection = .settings
                    }
                },
            )
        case .sales:
            SalesView(environment: dependencies.sales)
        case .addItem:
            AddItemView(environment: dependencies.addItem)
        case .tasks:
            TasksView(environment: dependencies.tasks)
        case .settings:
            SettingsView(
                content: SettingsContent(configuration: dependencies.configuration, version: dependencies.version),
                devSignIn: dependencies.devSignIn,
                path: $settingsPath,
                marketplacesAttention: dependencies.marketplaces.attention == nil ? nil : "Needs attention",
                devPalette: dependencies.paletteSwitch.map { palette in
                    Binding(get: { palette.selection }, set: { palette.select($0) })
                },
            ) {
                MarketplacesView(model: dependencies.marketplaces)
            } linkAccounts: {
                LinkAccountsView(model: dependencies.linkAccounts)
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
