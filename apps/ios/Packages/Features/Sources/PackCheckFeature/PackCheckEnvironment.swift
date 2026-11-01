import APIClient
import Core
import Foundation
import ListoraAPI
import SwiftUI

/// Pack check (docs/features/pack-check.md): an optional mode, off until the seller turns it on
/// in Settings, that checks each package's shipping label before it ships. Built once at launch
/// by `AppDependencies`, which hands its screens to Settings, the Sales tab, and the item screen.
@MainActor
public final class PackCheckEnvironment {
    let service: any PackCheckService
    /// Storage bins (docs/features/storage-bins.md), which share Pack check's scanner and
    /// sticker printing.
    let bins: any BinsService
    let isSignedIn: @MainActor () -> Bool
    let runPhoneWork: @MainActor () -> Void
    let scanSource: ScanSource
    /// Where an order's label comes from to print it, and the printer.
    let labelFiles: any LabelFileSource
    let printer: any LabelPrinter
    /// Whether the seller saw "How Pack check works", which the to-ship list shows once.
    let defaults: UserDefaults
    /// On or off; the Sales tab shows "Pack orders" while it is on.
    public let settings: PackCheckSettingsModel

    /// `phoneWork` reads the labels Listora asks this phone for, and `sessions` are the
    /// marketplace sessions it downloads a label to print through; `scannedCodes` stands in for
    /// the camera in UI tests (`LISTORA_SCANNED_CODES`), and `scriptedPrinting` for the
    /// marketplace's label and the print sheet (`LISTORA_SCRIPTED_PRINTING`).
    public convenience init(
        apiClient: APIClient,
        accessTokens: AccessTokenStore,
        phoneWork: (any PhoneWorkTrigger)? = nil,
        sessions: any MarketplaceSessionStore,
        allowsLocalHTTP: Bool = false,
        scannedCodes: [String]? = nil,
        scriptedPrinting: Bool = false,
        defaults: UserDefaults = .standard,
    ) {
        let run: @MainActor () -> Void = { [weak phoneWork] in phoneWork?.runPhoneWork(.userAction) }
        self.init(
            service: APIPackCheckService(client: apiClient.client),
            bins: APIBinsService(client: apiClient.client),
            isSignedIn: { accessTokens.grant != nil },
            runPhoneWork: run,
            scanSource: scannedCodes.map { .scripted(ScriptedScans($0)) } ?? .camera,
            labelFiles: scriptedPrinting
                ? ScriptedLabelFiles()
                : SessionLabelFiles(sessions: sessions, allowsLocalHTTP: allowsLocalHTTP),
            printer: scriptedPrinting ? ScriptedPrinter() : AirPrinter(),
            defaults: defaults,
        )
    }

    init(
        service: any PackCheckService,
        bins: any BinsService = UnavailableBins(),
        isSignedIn: @escaping @MainActor () -> Bool = { true },
        runPhoneWork: @escaping @MainActor () -> Void = {},
        scanSource: ScanSource = .camera,
        labelFiles: any LabelFileSource = ScriptedLabelFiles(),
        printer: any LabelPrinter = ScriptedPrinter(),
        defaults: UserDefaults = .standard,
    ) {
        self.service = service
        self.bins = bins
        self.isSignedIn = isSignedIn
        self.runPhoneWork = runPhoneWork
        self.scanSource = scanSource
        self.labelFiles = labelFiles
        self.printer = printer
        self.defaults = defaults
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

    /// One sale's order as Pack check sees it, for the sale's screen; `nil` when it has none.
    public func saleOrder(saleID: String) async throws(APIFailure) -> Components.Schemas.PackOrder? {
        try await service.saleOrder(saleID: saleID)
    }

    /// Packing one order from its sale's screen: the same flow as the to-ship list's, for that
    /// order alone (its label and stickers print from it). A packed order opens on its package.
    public func salePackScreen(
        _ order: Components.Schemas.PackOrder,
        onClose: @escaping @MainActor () -> Void,
    ) -> some View {
        SalePackScreen(environment: self, order: order, onClose: onClose)
    }

    /// Printing an item's sticker (the item screen, and after listing).
    public func stickerScreen(_ request: StickerRequest) -> some View {
        StickerPrintView(stickers: [request])
    }

    /// Settings > Storage bins: every bin, making one, and each bin's items and sticker.
    public func binsScreen() -> some View {
        BinsView(environment: self)
    }

    /// Putting items in a bin (the item screen, a saved item, a run's kept items): scan the
    /// bin's sticker or pick one. `onDone` gets the bin they are in once Listora has it, or nil
    /// when the item was taken out of its bin.
    public func binPicker(
        _ request: BinRequest,
        onDone: @escaping @MainActor (BinChoice?) -> Void,
    ) -> some View {
        BinPickerView(environment: self, request: request, onDone: onDone)
    }

    func makeOrdersModel() -> PackOrdersModel {
        PackOrdersModel(service: service, isSignedIn: isSignedIn, runPhoneWork: runPhoneWork)
    }

    /// Printing an order's label with its stickers.
    func makeLabelPrint(_ order: PackOrder, onChange: @escaping @MainActor (PackOrder) -> Void) -> LabelPrintModel {
        LabelPrintModel(order: order, service: service, files: labelFiles, printer: printer, onChange: onChange)
    }

    /// Refreshes the setting the Sales tab shows the way in by.
    public func refreshSetting() async {
        guard isSignedIn() else { return }
        await settings.load()
    }

    public static func resetLocalData(defaults: UserDefaults) {
        PackCheckSettingsModel.resetLocalData(defaults: defaults)
        PackCheckExplainer.resetLocalData(defaults: defaults)
    }
}

/// Holds one order's packing session for as long as its cover shows.
private struct SalePackScreen: View {
    let environment: PackCheckEnvironment
    let onClose: @MainActor () -> Void
    @State private var session: PackSessionModel

    init(environment: PackCheckEnvironment, order: PackOrder, onClose: @escaping @MainActor () -> Void) {
        self.environment = environment
        self.onClose = onClose
        _session = State(initialValue: PackSessionModel(orders: [order], service: environment.service))
    }

    var body: some View {
        PackSessionView(model: session, environment: environment, onClose: onClose)
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
