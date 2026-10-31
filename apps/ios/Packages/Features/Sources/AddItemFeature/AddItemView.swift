import Core
import DesignSystem
import PhotosUI
import SwiftUI

/// The Add Item tab: start a new item from the camera or the photo library, and the drafts saved
/// on this iPhone with their upload status.
public struct AddItemView: View {
    private let environment: AddItemEnvironment
    @State private var model: AddItemModel?

    public init(environment: AddItemEnvironment) {
        self.environment = environment
        if case let .ready(store, uploader) = environment.state {
            _model = State(initialValue: AddItemModel(
                store: store,
                uploader: uploader,
                activity: environment.activity,
                meter: environment.meter,
            ))
        }
    }

    public var body: some View {
        if let model {
            DraftListView(model: model, environment: environment)
        } else if case let .unavailable(message) = environment.state {
            NavigationStack {
                EmptyStateView(
                    systemImage: "externaldrive.badge.exclamationmark",
                    tone: .failed,
                    title: "Drafts unavailable",
                    message: message,
                )
                .navigationTitle("Add Item")
            }
        }
    }
}

/// The drafts on this iPhone, with the new-item actions pinned at the bottom within thumb reach.
/// With no drafts yet, the screen explains the guided shots instead.
struct DraftListView: View {
    let model: AddItemModel
    let environment: AddItemEnvironment
    @State private var path: [AddItemRoute] = []
    @State private var unloadedPhotos: PickedPhotos<PhotosPickerItem>?
    @State private var camera: OpenCamera?
    @State private var scanSheet: ScanSheet?

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if model.drafts.isEmpty, model.batches.isEmpty {
                    ScrollView {
                        Group {
                            switch mode {
                            case .single:
                                NewItemGuide(
                                    isCameraAvailable: environment.isCameraAvailable,
                                    isSignedIn: environment.activity.isSignedIn,
                                )
                            case .batch: BatchGuide(isCameraAvailable: environment.isCameraAvailable)
                            case .scan:
                                ScanGuide(
                                    isCameraAvailable: environment.isCameraAvailable,
                                    run: model.scanRun,
                                    lastRun: model.lastRunSummary,
                                    isTesting: environment.features?.isTesting(.thriftScan) == true,
                                )
                            }
                        }
                        .padding(Spacing.md)
                    }
                } else {
                    draftList
                }
            }
            .background(Palette.background)
            .navigationTitle("Add Item")
            .bottomActionBar { actions }
            .navigationDestination(for: AddItemRoute.self) { route in
                switch route {
                case let .draft(draftID):
                    DraftEditorView(draftID: draftID, model: model, environment: environment) { request in
                        path.append(.review(request))
                    }
                case let .review(request):
                    environment.reviewDestination?(request) { outcome in
                        finishReview(request, outcome)
                    }
                case let .batch(batchID):
                    BatchScreen(
                        batchID: batchID,
                        model: model,
                        environment: environment,
                        onCheckGrouping: { path.append(.batchGrouping(batchID)) },
                        onKeepShooting: { keepShooting(batchID) },
                        onReview: { path.append(.batchReview(batchID, $0)) },
                        onEditPhotos: { path.append(.draft($0)) },
                        onDeleted: { path = [] },
                    )
                case let .batchGrouping(batchID):
                    BatchGroupingScreen(
                        batchID: batchID,
                        model: model,
                        environment: environment,
                        onConfirmed: { showBatch(batchID) },
                        onKeepShooting: { keepShooting(batchID) },
                    )
                case let .batchReview(batchID, request):
                    environment.batchReviewDestination?(request) { event in
                        finishBatchReview(batchID, event)
                    }
                }
            }
            .task { await model.observeDrafts() }
            .task { await model.observeBatches() }
            .motion(value: model.drafts.map(\.id))
            .fullScreenCover(item: $camera) { session in
                switch session {
                case .single:
                    CameraCaptureView(camera: environment.makeCamera()) { shots in
                        camera = nil
                        if let id = await model.save(shots) {
                            path.append(.draft(id))
                        }
                    }
                case let .batch(batchID):
                    BatchCaptureView(
                        camera: environment.makeCamera(),
                        model: model.captureModel(for: batchID, reader: environment.signalReader),
                    ) { kept in
                        await finishBatchCapture(batchID, kept: kept)
                    }
                    .measuresInteraction(model.meter, session: BatchRecord.meterSession(batchID))
                case let .scan(run):
                    ScanCamera(run: run, model: model, environment: environment) { camera = nil }
                }
            }
            .modifier(ScanSheets(sheet: $scanSheet, camera: $camera, model: model, environment: environment))
            .alert("Couldn't save", isPresented: errorBinding) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(model.errorMessage ?? "")
            }
        }
    }

    private var draftList: some View {
        List {
            if mode == .scan {
                ScanRunSection(model: model)
            }
            if !model.batches.isEmpty {
                Section {
                    ForEach(model.batches) { batch in
                        NavigationLink(value: AddItemRoute.batch(batch.id)) {
                            BatchRow(
                                batch: batch,
                                fileURL: model.store.fileURL(for:),
                                draftFileURL: model.store.fileURL(for:),
                            )
                        }
                        .accessibilityIdentifier("batch.row")
                    }
                } header: {
                    SectionHeader(
                        model.batches.count == 1 ? "1 batch" : "\(model.batches.count) batches",
                        subtitle: "Hauls you shot in one go. Each item uploads and is analyzed on its own.",
                    )
                    .padding(.bottom, Spacing.xxs)
                }
                .listRowBackground(Palette.surface.color)
                .listSectionSeparatorTint(Palette.separator.color)
            }
            if !model.drafts.isEmpty {
                draftSection
            }
        }
        .scrollContentBackground(.hidden)
    }

    private var draftSection: some View {
        Section {
            ForEach(model.drafts) { draft in
                NavigationLink(value: AddItemRoute.draft(draft.id)) {
                    DraftRow(draft: draft, activity: model.activity, fileURL: model.store.fileURL(for:))
                }
                .accessibilityIdentifier("draft.row")
            }
            .onDelete { offsets in
                for index in offsets {
                    model.deleteDraft(model.drafts[index].id)
                }
            }
        } header: {
            SectionHeader(
                model.drafts.count == 1 ? "1 draft" : "\(model.drafts.count) drafts",
                subtitle: "Saved on this iPhone. Uploads keep going in the background.",
            )
            .padding(.bottom, Spacing.xxs)
        }
        .listRowBackground(Palette.surface.color)
        .listSectionSeparatorTint(Palette.separator.color)
    }

    @ViewBuilder
    private var actions: some View {
        Picker("Add", selection: Bindable(model).mode) {
            ForEach(AddItemMode.offered(scan: isScanShown), id: \.self) { mode in
                Text(mode.title).tag(mode)
            }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("addItem.mode")
        UnloadedPhotosNotice(picked: $unloadedPhotos, onPicked: importPhotos)
        switch mode {
        case .single:
            if environment.isCameraAvailable {
                Button {
                    model.beginNewItem()
                    camera = .single
                } label: {
                    Label("Take photos", systemImage: "camera.fill")
                }
                .buttonStyle(.listoraPrimary)
                .accessibilityIdentifier("addItem.takePhotos")
            }
            importButton
        case .batch:
            if environment.isCameraAvailable {
                Button {
                    if let batchID = model.beginBatch() {
                        camera = .batch(batchID)
                    }
                } label: {
                    Label("Shoot a batch", systemImage: "camera.fill")
                }
                .buttonStyle(.listoraPrimary)
                .accessibilityIdentifier("addItem.shootBatch")
            }
            batchImportButton
        case .scan:
            scanActions
        }
    }

    /// Scan mode shows only where the thrift scan is on (docs/features/verified-features.md).
    private var isScanShown: Bool {
        environment.features?.shows(.thriftScan) == true
    }

    /// The mode in effect: a kept choice of Scan falls back to one item where Scan is hidden.
    private var mode: AddItemMode {
        model.mode == .scan && !isScanShown ? .single : model.mode
    }

    @ViewBuilder
    private var scanActions: some View {
        if environment.isCameraAvailable {
            ScanActions(model: model, environment: environment, camera: $camera, sheet: $scanSheet)
        }
    }

    private func importPhotos(_ images: [Data]) async {
        if let id = await model.addPhotos(images) {
            path.append(.draft(id))
        }
    }

    /// A saved item's draft is done: back to the list, without it. Changing the photos, or leaving
    /// the review, goes back to the draft.
    private func finishReview(_ request: ItemReviewRequest, _ outcome: ItemReviewOutcome) {
        switch outcome {
        case let .saved(_, listNow):
            path = []
            model.completeDraft(request.sessionID)
            if listNow {
                environment.onListItem?(request.itemID)
            }
        case .editPhotos, .back:
            if case .review = path.last {
                path.removeLast()
            }
        }
    }

    private var errorBinding: Binding<Bool> {
        Binding(
            get: { model.errorMessage != nil },
            set: {
                if !$0 {
                    model.errorMessage = nil
                }
            },
        )
    }
}

/// Batch mode (docs/features/batch.md): starting a batch, and the batch screens' way back.
extension DraftListView {
    @ViewBuilder
    private var batchImportButton: some View {
        let button = PhotoLibraryButton(
            maxCount: AddItemModel.maxBatchImport,
            fixturePhotosDirectory: environment.fixturePhotosDirectory,
            unloaded: $unloadedPhotos,
            onPicked: importBatch,
            title: environment.isCameraAvailable ? "Import a batch" : "Import a batch from photos",
            systemImage: "photo.stack",
        )
        .disabled(model.isPreparingPhotos)
        .loading(model.isPreparingPhotos)
        .accessibilityIdentifier("addItem.importBatch")
        if environment.isCameraAvailable {
            button.buttonStyle(.listora(.tertiary, size: .large))
        } else {
            button.buttonStyle(.listoraPrimary)
        }
    }

    private func importBatch(_ images: [Data]) async {
        if let batchID = await model.importBatch(images, reader: environment.signalReader) {
            path = [.batch(batchID), .batchGrouping(batchID)]
        }
    }

    /// The camera closed: check the new photos' grouping, or go back where the seller was.
    private func finishBatchCapture(_ batchID: String, kept: Bool) async {
        camera = nil
        guard kept else {
            model.dropBatchIfEmpty(batchID)
            return
        }
        path = [.batch(batchID), .batchGrouping(batchID)]
    }

    private func keepShooting(_ batchID: String) {
        guard environment.isCameraAvailable else { return }
        camera = .batch(batchID)
    }

    /// The items are created: back to the batch, which shows them uploading and analyzing.
    private func showBatch(_ batchID: String) {
        path = [.batch(batchID)]
    }

    private func finishBatchReview(_ batchID: String, _ event: BatchReviewEvent) {
        model.handle(event, batchID: batchID)
        if event == .finished, case .batchReview = path.last {
            path.removeLast()
        }
    }

    @ViewBuilder
    private var importButton: some View {
        let button = PhotoLibraryButton(
            maxCount: DraftStore.maxPhotosPerDraft,
            fixturePhotosDirectory: environment.fixturePhotosDirectory,
            unloaded: $unloadedPhotos,
            onPicked: importPhotos,
            title: environment.isCameraAvailable ? "Import from library" : "Import photos",
            systemImage: "photo.on.rectangle",
        )
        .disabled(model.isPreparingPhotos)
        .loading(model.isPreparingPhotos)
        .accessibilityIdentifier("addItem.importPhotos")
        if environment.isCameraAvailable {
            button.buttonStyle(.listora(.tertiary, size: .large))
        } else {
            button.buttonStyle(.listoraPrimary)
        }
    }
}
