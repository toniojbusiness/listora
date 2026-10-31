import APIClient
import Core
import DesignSystem
import Foundation
import Observation
import os

/// What a scan run works with: the API, the device's readers, and the queue that keeps it.
struct ScanRunDependencies {
    let service: any ScanService
    let tagReader: any TagReader
    /// Reads each shot's feature print for the duplicate warning; nil reads none.
    var signalReader: (any PhotoSignalReader)?
    /// Nil counts as always online: every read is tried at once.
    var connectivity: (any ScanConnectivity)?
    /// Keeps the run and its scans on this iPhone; nil keeps them in memory only.
    var queue: ScanQueueStore?
    /// The sourcing kit for the instant read, when this iPhone has one.
    var kit: @MainActor () -> SourcingKit? = { nil }
    let saveDraft: ScanDraftSaver
    var now: () -> Date = Date.init
}

/// One sourcing run at the store (docs/features/thrift-scan.md): every shot is read at once and
/// lands as a card, while the seller can already shoot the next item. Shooting the next item
/// skips the last one; Keep saves it as a draft on this iPhone, uploaded in the background; the
/// tray keeps every card of the run so a skipped item can still be kept until the run ends.
///
/// With no signal (docs/features/thrift-scan.md, "Offline at the bins") each shot gets the
/// instant read from the household's own sales and its read waits in the queue, which keeps the
/// run and its scans across a relaunch; ``drain()`` reads them, newest first, once there is
/// signal again.
@MainActor
@Observable
final class ScanRunModel {
    /// The run on this iPhone; its server run is created with the first read.
    let id: String
    var entries: [ScanEntry] = []
    /// The card on screen: the last shot, or the one picked in the tray.
    var currentID: String?
    /// The next shot is a close-up of this entry's tag, not a new item.
    var tagShotFor: String?
    /// A note said before the next shot, which rides along with its read.
    var pendingNote: String?
    /// The seller ended the run; kept scans still waiting for signal finish it later.
    var isEnded = false
    /// Ended, every kept scan saved, and its files gone.
    var isFinished = false
    /// Called once the run is finished.
    var onFinished: (@MainActor (ScanRunModel) -> Void)?
    /// Where the seller is, as they named it when the run started; nil when they named none.
    var place: String? {
        record.place
    }

    let dependencies: ScanRunDependencies
    /// The run's folder: each shot's small JPEG, tag close-up, and upload-sized photos.
    let directory: URL
    let log = Logger(subsystem: "com.listora.app", category: "scan")
    var record: ScanRunRecord
    var serverRun: Task<String, any Error>?
    /// Each entry's upload-sized photo (and tag photo) as it is prepared, and once it is.
    var photos: [String: Task<StoredScanPhoto, any Error>] = [:]
    var tagPhotos: [String: Task<StoredScanPhoto, any Error>] = [:]
    var storedPhotos: [String: StoredScanPhoto] = [:]
    var storedTagPhotos: [String: StoredScanPhoto] = [:]
    /// A note said while the entry's first read was still running: read again once it lands.
    var notesAfterRead: [String: String] = [:]
    var isDraining = false
    /// The marketplace comparison lane, where `market_comps` is on (docs/features/thrift-scan.md).
    private(set) var comparisons: (any MarketComparisons)?
    /// The comparison reads this run started, by id: each is read once.
    var startedReads: Set<String> = []

    /// The longest the tag text reading may hold up a read; past it the read goes without.
    static let tagReadDeadline: Duration = .milliseconds(400)
    static let tagCloseUpReadDeadline: Duration = .milliseconds(900)

    /// A new run, at the place the seller named (nil: none).
    init(dependencies: ScanRunDependencies, directory: URL, place: String? = nil) {
        let id = UUID().uuidString.lowercased()
        self.id = id
        self.dependencies = dependencies
        self.directory = directory.appending(path: id, directoryHint: .isDirectory)
        record = ScanRunRecord(
            id: id,
            startedAt: dependencies.now(),
            createRunKey: UUID().uuidString.lowercased(),
            place: place.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 },
        )
        saveRun()
    }

    /// A run kept on this iPhone, as it was when the app last closed.
    init(dependencies: ScanRunDependencies, directory: URL, restoring run: ScanRunRecord, entries: [ScanEntryRecord]) {
        id = run.id
        self.dependencies = dependencies
        self.directory = directory.appending(path: run.id, directoryHint: .isDirectory)
        record = run
        isEnded = run.endRequested
        restore(entries)
    }

    convenience init(
        service: any ScanService,
        tagReader: any TagReader,
        directory: URL,
        place: String? = nil,
        saveDraft: @escaping ScanDraftSaver,
        comparisons: (any MarketComparisons)? = nil,
        comparing marketplaces: [String] = [],
        now: @escaping () -> Date = Date.init,
    ) {
        self.init(
            dependencies: ScanRunDependencies(service: service, tagReader: tagReader, saveDraft: saveDraft, now: now),
            directory: directory,
            place: place,
        )
        compare(with: comparisons, on: marketplaces)
    }

    /// Compares each read on these marketplaces from now on (where `market_comps` is on): their
    /// pages load at once, while the seller walks to the bins.
    func compare(with lane: (any MarketComparisons)?, on marketplaces: [String]) {
        comparisons = marketplaces.isEmpty ? nil : lane
        comparisons?.warmUp(marketplaces)
    }

    var service: any ScanService {
        dependencies.service
    }

    /// The ``InteractionMeter`` session of the run's camera.
    var meterSession: String {
        KeptScanRun.meterSession(id)
    }

    var current: ScanEntry? {
        currentID.flatMap { id in entries.first { $0.id == id } }
    }

    var keptCount: Int {
        entries.count(where: \.isKept)
    }

    /// Scans whose read waits for signal.
    var waitingCount: Int {
        entries.count(where: \.isWaiting)
    }

    /// Kept scans whose draft is saved once they are read.
    var keptWaitingCount: Int {
        entries.count { $0.decision == .keepWhenRead }
    }

    // MARK: Shooting

    /// A shot from the camera: a new item (skipping the last one), or the tag close-up the seller
    /// asked for.
    func shoot(_ capture: Data) async {
        guard !isEnded else { return }
        if let target = tagShotFor {
            tagShotFor = nil
            await addTag(capture, to: target)
            return
        }
        let shotAt = dependencies.now()
        let small: Data
        do {
            small = try await Task.detached(priority: .userInitiated) { try ScanPhotos.small(capture) }.value
        } catch {
            log.error("Preparing a scan shot failed: \(String(describing: error), privacy: .public)")
            Haptics.play(.failure)
            return
        }
        let entry = ScanEntry(
            id: UUID().uuidString.lowercased(),
            number: (entries.map(\.number).max() ?? 0) + 1,
            shotAt: shotAt,
            itemJPEG: small,
            note: pendingNote,
        )
        pendingNote = nil
        writeShot(small, to: Self.itemFile(entry.id))
        entries.append(entry)
        currentID = entry.id
        persist(entry.id)
        storePhoto(capture, for: entry.id, into: \.photos)
        readFeaturePrint(of: entry.id, small)
        let lines = await ScanTagText.read(small, with: dependencies.tagReader, within: Self.tagReadDeadline)
        update(entry.id) { entry in
            entry.tagText = lines
            entry.instant = self.instantRead(lines)
        }
        await attemptRead(entry.id, announce: true)
    }

    /// The next shot is a close-up of the card's tag.
    func startTagShot() {
        guard let current, current.decision == .open else { return }
        tagShotFor = current.id
    }

    func cancelTagShot() {
        tagShotFor = nil
    }

    /// What the seller said: before a shot it rides along with the shot's read; after it, the
    /// card's item is read again once with it (when there is signal).
    func addNote(_ text: String) async {
        let note = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !note.isEmpty, !isEnded else { return }
        guard let current, current.decision == .open else {
            pendingNote = note
            return
        }
        let combined = [current.note, note].compactMap(\.self).joined(separator: ". ")
        update(current.id) { $0.note = combined }
        switch current.state {
        case .reading:
            notesAfterRead[current.id] = combined
        case .waiting, .failed:
            // Nothing was read yet: the read due carries the note, as a new request.
            update(current.id) { $0.readKey = UUID().uuidString.lowercased() }
        case .read:
            await beginRead(current.id, replacing: current.scanID)
        }
    }

    /// Shows the entry's card (a tap in the tray).
    func select(_ entryID: String) {
        guard entries.contains(where: { $0.id == entryID }) else { return }
        tagShotFor = nil
        currentID = entryID
    }

    func retry(_ entryID: String) async {
        guard let entry = entries.first(where: { $0.id == entryID }), case .failed = entry.state else { return }
        await attemptRead(entryID)
    }

    /// The owner's measurements of the run (Test mode only): how long each card took from the
    /// shutter, as the plan's speed targets count them.
    var cardTimes: [TimeInterval] {
        entries.compactMap(\.cardAfter)
    }

    /// The instant read of a tag's text from the household's own sales, when this iPhone has a kit.
    func instantRead(_ tagText: [String]) -> OfflineScanRead? {
        dependencies.kit().flatMap { OfflineScanCall.read(kit: $0, tagText: tagText) }
    }

    private func addTag(_ capture: Data, to entryID: String) async {
        guard let entry = entries.first(where: { $0.id == entryID }), entry.decision == .open else { return }
        let small: Data
        do {
            small = try await Task.detached(priority: .userInitiated) { try ScanPhotos.small(capture) }.value
        } catch {
            Haptics.play(.failure)
            return
        }
        currentID = entryID
        writeShot(small, to: Self.tagFile(entryID))
        storePhoto(capture, for: entryID, into: \.tagPhotos)
        let lines = await ScanTagText.read(small, with: dependencies.tagReader, within: Self.tagCloseUpReadDeadline)
        update(entryID) { entry in
            entry.tagJPEG = small
            entry.tagText = Array((entry.tagText + lines).prefix(40))
            entry.instant = self.instantRead(entry.tagText)
        }
        await beginRead(entryID, replacing: entry.scanID)
    }

    func storePhoto(
        _ capture: Data,
        for entryID: String,
        into tasks: ReferenceWritableKeyPath<ScanRunModel, [String: Task<StoredScanPhoto, any Error>]>,
    ) {
        let directory = directory
        let task = Task.detached(priority: .utility) {
            try ScanPhotos.store(capture, in: directory)
        }
        self[keyPath: tasks][entryID] = task
        let isTag = tasks == \ScanRunModel.tagPhotos
        Task { [weak self] in
            guard let photo = try? await task.value else { return }
            self?.photoStored(photo, for: entryID, isTag: isTag)
        }
    }

    private func photoStored(_ photo: StoredScanPhoto, for entryID: String, isTag: Bool) {
        if isTag {
            storedTagPhotos[entryID] = photo
        } else {
            storedPhotos[entryID] = photo
        }
        persist(entryID)
    }

    func update(_ entryID: String, _ change: (inout ScanEntry) -> Void) {
        guard let index = entries.firstIndex(where: { $0.id == entryID }) else { return }
        change(&entries[index])
        persist(entryID)
    }
}

/// The run's checkout (`ScanCheckoutModel`): what it sends, and how the run ends with it.
extension ScanRunModel {
    /// A Keep still being saved on this iPhone: checkout waits for it.
    var isKeeping: Bool {
        entries.contains { $0.decision == .keeping }
    }

    /// The run can be checked out once anything was scanned, no Keep is still being saved, and no
    /// kept scan still waits to be read (its draft, and so the haul's item, comes with the read).
    var canCheckOut: Bool {
        !isEnded && !entries.isEmpty && !isKeeping && keptWaitingCount == 0
    }

    /// The scans kept on this iPhone, in the order shot.
    var keptScanIDs: [String] {
        entries.filter(\.isKept).compactMap(\.scanID)
    }

    /// The run's server id, creating the run if no read did yet.
    func serverRunID() async throws -> String {
        try await ensureServerRun()
    }

    /// Ends the run once it was checked out (the server ended it): no more shots, and the run's
    /// files and records go. The kept drafts stay.
    func close() {
        guard !isFinished else { return }
        isEnded = true
        tagShotFor = nil
        record.endRequested = true
        // Checked out on the server: nothing is left to end there.
        record.serverRunID = nil
        serverRun = nil
        Task { await finishIfDone() }
    }
}
