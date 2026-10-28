import AddItemFeature
import APIClient
import Core
import DesignSystem
import InventoryFeature
import MarketplaceLinkingFeature
import MarketplacesFeature
import PhoneExecutionFeature
import SalesFeature
import SettingsFeature
import SignInFeature
import SwiftUI
import TasksFeature
import TodayFeature

/// The app's root: the welcome and sign-in screens while nobody is signed in, and once someone is,
/// one tab per top-level area, and Settings over them, opened from the seller's avatar in the Today
/// and Sales headers. The session ending anywhere (sign-out, a `401`, a refresh the pool refuses,
/// expiry) brings the sign-in back. While a marketplace connection needs attention, Inventory shows
/// the connection banner, which opens Marketplaces in Settings, and the avatar has a dot.
public struct RootView: View {
    private let dependencies: AppDependencies
    @State private var selection: AppTab
    @State private var settingsPath: [SettingsDestination] = []
    @State private var showsSettings = false
    /// What to open once the first-run guide has closed (a sheet cannot open while it closes).
    @State private var afterGettingStarted: [SettingsDestination]?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(dependencies: AppDependencies, initialTab: AppTab = .today) {
        self.dependencies = dependencies
        _selection = State(initialValue: initialTab)
    }

    public var body: some View {
        ZStack {
            if dependencies.signIn.isSignedIn {
                tabs
                    .transition(.opacity)
            } else {
                SignInFlowView(model: dependencies.signIn)
                    .transition(.opacity)
            }
        }
        .animation(Motion.animation(Motion.standard, reduceMotion: reduceMotion), value: dependencies.signIn.isSignedIn)
        .solidBarEdges()
        .background { WindowTapCounter { [meter = dependencies.interactionMeter] in meter.recordTap() } }
        .onChange(of: scenePhase, initial: true) { _, phase in
            dependencies.interactionMeter.setAppActive(phase == .active)
            if phase == .active {
                dependencies.signIn.refresh()
            }
        }
        // The first-run guide follows the session from launch, so it shows after a sign-in only.
        .onChange(of: dependencies.signIn.isSignedIn, initial: true) { _, signedIn in
            dependencies.gettingStarted.signedInChanged(signedIn)
        }
        .fullScreenCover(
            isPresented: Bindable(dependencies.gettingStarted).isPresented,
            onDismiss: {
                if let path = afterGettingStarted {
                    afterGettingStarted = nil
                    openSettings(at: path)
                }
            },
            content: { gettingStarted },
        )
        .onChange(of: dependencies.signIn.isSignedIn) { _, signedIn in
            // The next person (or the same one, again) starts on Today with nothing open.
            if !signedIn {
                showsSettings = false
                settingsPath = []
                selection = .today
                dependencies.settings.profile.signedOut()
                dependencies.settings.invites.signedOut()
            }
        }
        // The avatar in the headers shows the seller's own initials or photo.
        .task(id: dependencies.signIn.stage.signedInEmail) {
            if dependencies.signIn.stage.signedInEmail != nil {
                await dependencies.settings.profile.load()
            }
        }
        .task { await dependencies.signIn.follow() }
        // An invite link (`listora://invite/<code>`) opens the sign-up with its code.
        .onOpenURL { url in
            if let code = InviteLink.code(in: url) {
                dependencies.signIn.openInvite(code: code)
            }
        }
        // List it now, after saving an item: the item in Inventory, with List everywhere open.
        .onAppear {
            dependencies.addItem.onListItem = { itemID in
                dependencies.inventory.listItem(id: itemID)
                selection = .inventory
            }
        }
        .task { dependencies.startBackgroundWork() }
    }

    private var tabs: some View {
        TabView(selection: $selection) {
            ForEach(AppTab.allCases) { tab in
                Tab(tab.title, systemImage: tab.systemImage, value: tab) {
                    screen(for: tab)
                }
                .badge(badgeCount(for: tab))
            }
        }
        .tint(Palette.brand.color)
        // Deleting the account keeps its result on screen; closing Settings then shows the sign-in.
        .sheet(isPresented: $showsSettings, onDismiss: { dependencies.signIn.finishSignOut() }, content: { settings })
        .onChange(of: scenePhase, initial: true) { _, phase in
            if phase == .active {
                Task { await dependencies.marketplaces.refreshAttention() }
                Task { await dependencies.inventory.attention.refresh() }
            } else if phase == .background {
                PhoneBackgroundWork.schedule()
            }
        }
        // While the app is open, the phone runs the marketplace work waiting for it (a sale's
        // delists among it) at once, and again whenever Listora says, so work queued or due
        // meanwhile (a check tried again) starts within seconds.
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            await dependencies.phone.runner.follow()
        }
        .onReceive(NotificationCenter.default.publisher(for: TaskNotificationRouter.openTasks)) { _ in
            selection = .tasks
        }
        // The badge follows the server while the app is open, and when it comes back.
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            await dependencies.tasks.inbox.follow()
        }
    }

    /// Tasks counts the open tasks, Inventory the items that need the seller.
    private func badgeCount(for tab: AppTab) -> Int {
        switch tab {
        case .tasks: dependencies.tasks.inbox.openCount
        case .inventory: dependencies.inventory.attention.total
        case .today, .addItem, .sales: 0
        }
    }

    @ViewBuilder
    private func screen(for tab: AppTab) -> some View {
        switch tab {
        case .today:
            TodayView(
                environment: dependencies.today,
                onOpenDrafts: {
                    // The Add Item tab lists this iPhone's drafts; the server's others are in Inventory.
                    if dependencies.addItem.hasDrafts {
                        selection = .addItem
                    } else {
                        dependencies.inventory.showDrafts()
                        selection = .inventory
                    }
                },
                onAddItem: { selection = .addItem },
                settings: { settingsButton },
            )
        case .inventory:
            InventoryView(
                environment: dependencies.inventory,
                onAddItem: { selection = .addItem },
                header: {
                    ConnectionAttentionBanner(model: dependencies.marketplaces) {
                        openSettings(at: [.marketplaces])
                    }
                },
            )
        case .sales:
            SalesView(
                environment: dependencies.sales,
                onOpenInventory: { selection = .inventory },
                settings: { settingsButton },
            )
        case .addItem:
            AddItemView(environment: dependencies.addItem)
        case .tasks:
            TasksView(environment: dependencies.tasks)
        }
    }
}

extension RootView {
    private var settingsButton: some View {
        ProfileButton(
            initials: dependencies.settings.profile.initials,
            photo: dependencies.settings.profile.photo,
            needsAttention: dependencies.marketplaces.attention != nil,
        ) {
            openSettings()
        }
    }

    private func openSettings(at path: [SettingsDestination] = []) {
        settingsPath = path
        showsSettings = true
    }

    /// The first-run guide; each of its ways out ends it for good.
    private var gettingStarted: some View {
        let guide = dependencies.gettingStarted
        return GettingStartedView(
            onLinkAccounts: {
                afterGettingStarted = [.linkAccounts]
                guide.finish()
            },
            onAddItem: {
                guide.finish()
                selection = .addItem
            },
            onSkip: { guide.finish() },
        )
    }

    private var settings: some View {
        SettingsView(
            content: SettingsContent(
                configuration: dependencies.configuration,
                version: dependencies.version,
                installationID: dependencies.linkAccounts.installationID,
            ),
            profile: dependencies.settings.profile,
            account: dependencies.signIn.stage.signedInEmail.map { email in
                SettingsAccount(email: email) { dependencies.signIn.signOut() }
            },
            accountDeletion: dependencies.settings.accountDeletion,
            invites: dependencies.settings.invites,
            screens: SettingsScreens(
                linkAccounts: { AnyView(LinkAccountsView(model: dependencies.linkAccounts)) },
                marketplaces: { AnyView(MarketplacesView(model: dependencies.marketplaces)) },
                imports: { dependencies.importsScreen() },
                notifications: {
                    AnyView(NotificationSettingsView(
                        today: dependencies.today,
                        saleEmails: dependencies.settings.saleEmails,
                    ))
                },
                saleEmails: { AnyView(SaleEmailsView(model: dependencies.settings.saleEmails)) },
                packCheck: { AnyView(dependencies.packCheck.settingsScreen()) },
            ),
            marketplacesSummary: dependencies.marketplaces.healthLine.map {
                SettingsSummary($0.text, needsAttention: $0.needsAttention)
            },
            saleEmailsSummary: dependencies.marketplaces.saleForwarding.map { SettingsSummary($0.statusLabel) },
            path: $settingsPath,
            onDone: { showsSettings = false },
        )
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
