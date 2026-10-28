import APIClient
import Core
import Foundation
import SwiftUI

/// Pack check (docs/features/pack-check.md): an optional mode, off until the seller turns it on
/// in Settings, that checks each package's shipping label before it ships. Built once at launch
/// by `AppDependencies`, which hands its screens to Settings, the Sales tab, and the item screen.
@MainActor
public final class PackCheckEnvironment {
    let service: any PackCheckService
    let isSignedIn: @MainActor () -> Bool
    let runPhoneWork: @MainActor () -> Void
    let scanSource: ScanSource
    /// On or off; the Sales tab shows "Pack orders" while it is on.
    public let settings: PackCheckSettingsModel

    /// `phoneWork` reads the labels Listora asks this phone for; `scannedCodes` stands in for the
    /// camera in UI tests (`LISTORA_SCANNED_CODES`).
    public convenience init(
        apiClient: APIClient,
        accessTokens: AccessTokenStore,
        phoneWork: (any PhoneWorkTrigger)? = nil,
        scannedCodes: [String]? = nil,
        defaults: UserDefaults = .standard,
    ) {
        let run: @MainActor () -> Void = { [weak phoneWork] in phoneWork?.runPhoneWork(.userAction) }
        self.init(
            service: APIPackCheckService(client: apiClient.client),
            isSignedIn: { accessTokens.grant != nil },
            runPhoneWork: run,
            scanSource: scannedCodes.map { .scripted(ScriptedScans($0)) } ?? .camera,
            defaults: defaults,
        )
    }

    init(
        service: any PackCheckService,
        isSignedIn: @escaping @MainActor () -> Bool = { true },
        runPhoneWork: @escaping @MainActor () -> Void = {},
        scanSource: ScanSource = .camera,
        defaults: UserDefaults = .standard,
    ) {
        self.service = service
        self.isSignedIn = isSignedIn
        self.runPhoneWork = runPhoneWork
        self.scanSource = scanSource
        settings = PackCheckSettingsModel(service: service, defaults: defaults, onEnabled: runPhoneWork)
    }

    /// Settings > Pack check: the switch, and what it does.
    public func settingsScreen() -> some View {
        PackCheckSettingsView(environment: self)
    }

    /// The to-ship list, where packing starts (the Sales tab's "Pack orders").
    public func ordersScreen() -> some View {
        PackOrdersScreen(environment: self)
    }

    /// Printing an item's sticker (the item screen, and after listing).
    public func stickerScreen(_ request: StickerRequest) -> some View {
        StickerPrintView(stickers: [request])
    }

    func makeOrdersModel() -> PackOrdersModel {
        PackOrdersModel(service: service, isSignedIn: isSignedIn, runPhoneWork: runPhoneWork)
    }

    /// Refreshes the setting the Sales tab shows the way in by.
    public func refreshSetting() async {
        guard isSignedIn() else { return }
        await settings.load()
    }

    public static func resetLocalData(defaults: UserDefaults) {
        PackCheckSettingsModel.resetLocalData(defaults: defaults)
    }
}

/// Holds the list's model for as long as the screen shows.
private struct PackOrdersScreen: View {
    let environment: PackCheckEnvironment
    @State private var model: PackOrdersModel

    init(environment: PackCheckEnvironment) {
        self.environment = environment
        _model = State(initialValue: environment.makeOrdersModel())
    }

    var body: some View {
        PackOrdersView(environment: environment, model: model)
    }
}
