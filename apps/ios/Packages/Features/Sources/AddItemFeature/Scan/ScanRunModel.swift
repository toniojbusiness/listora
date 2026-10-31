import APIClient
import Core
import DesignSystem
import Foundation
import Observation
import os

/// One sourcing run at the store (docs/features/thrift-scan.md): every shot is read at once and
/// lands as a card, while the seller can already shoot the next item. Shooting the next item
/// skips the last one; Keep saves it as a draft on this iPhone, uploaded in the background; the
/// tray keeps every card of the run so a skipped item can still be kept until the run ends.
@MainActor
@Observable
final class ScanRunModel {
    /// The run on this iPhone; its server run is created with the first scan.
    let id: String
    private(set) var entries: [ScanEntry] = []
    /// The card on screen: the last shot, or the one picked in the tray.
    var currentID: String?
    /// The next shot is a close-up of this entry's tag, not a new item.
    var tagShotFor: String?
    /// A note said before the next shot, which rides along with its read.
    private(set) var pendingNote: String?
    private(set) var isEnded = false
    /// The brief line over the camera after the seller kept or put back an item.
    var confirmation: ScanConfirmation?
    /// When the seller last chose Keep or Put back on a card, until the camera was clear again:
    /// the owner's measurement of how soon the next shot can be taken.
    var decidedAt: (entryID: String, at: Date)?
    /// From Keep or Put back to the camera clear for the next shot, for the owner's measurements.
    var readyTimes: [TimeInterval] = []
    /// Where the seller is, as they named it when the run started; nil when they named none.
    let place: String?

    let service: any ScanService
    private let tagReader: any TagReader
    private let saveDraft: ScanDraftSaver
    private let directory: URL
    let now: () -> Date
    let log = Logger(subsystem: "com.listora.app", category: "scan")
    private var serverRun: Task<String, any Error>?
    private let createRunKey = UUID().uuidString.lowercased()
    /// Each entry's upload-sized photo (and tag photo) as it is prepared.
    private var photos: [String: Task<StoredScanPhoto, any Error>] = [:]
    private var tagPhotos: [String: Task<StoredScanPhoto, any Error>] = [:]
    /// A note said while the entry's first read was still running: read again once it lands.
    private var notesAfterRead: [String: String] = [:]
    /// The marketplace comparison lane, where `market_comps` is on (docs/features/thrift-scan.md).
    let comparisons: (any MarketComparisons)?
    /// The comparison reads this run started, by id: each is read once.
    var startedReads: Set<String> = []

    /// The longest the tag text reading may hold up a read; past it the read goes without.
    static let tagReadDeadline: Duration = .milliseconds(400)
    static let tagCloseUpReadDeadline: Duration = .milliseconds(900)

    init(
        service: any ScanService,
        tagReader: any TagReader,
        directory: URL,
        place: String? = nil,
        saveDraft: @escaping ScanDraftSaver,
        comparisons: (any MarketComparisons)? = nil,
        comparing marketplaces: [String] = [],
        now: @escaping () -> Date = Date.init,
    ) {
        let id = UUID().uuidString.lowercased()
        self.id = id
        let place = place?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.place = place?.isEmpty == false ? place : nil
        self.service = service
        self.comparisons = marketplaces.isEmpty ? nil : comparisons
        // The comparison pages load while the seller walks to the bins.
        self.comparisons?.warmUp(marketplaces)
        self.tagReader = tagReader
        self.directory = directory.appending(path: id, directoryHint: .isDirectory)
        self.saveDraft = saveDraft
        self.now = now
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
        let shotAt = now()
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
            number: entries.count + 1,
            shotAt: shotAt,
            itemJPEG: small,
            note: pendingNote,
        )
        pendingNote = nil
        entries.append(entry)
        currentID = entry.id
        storePhoto(capture, for: entry.id, into: \.photos)
        let lines = await ScanTagText.read(small, with: tagReader, within: Self.tagReadDeadline)
        update(entry.id) { $0.tagText = lines }
        await read(entry.id)
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
    /// card's item is read again once with it.
    func addNote(_ text: String) async {
        let note = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !note.isEmpty, !isEnded else { return }
        guard let current, current.decision == .open else {
            pendingNote = note
            return
        }
        let combined = [current.note, note].compactMap(\.self).joined(separator: ". ")
        update(current.id) { $0.note = combined }
        if current.state == .reading {
            notesAfterRead[current.id] = combined
        } else {
            await read(current.id, replacing: current.scanID)
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
        await read(entryID, replacing: entry.scanID)
    }

    // MARK: The run

    /// The owner's measurements of the run (Test mode only): how long each card took from the
    /// shutter, as the plan's speed targets count them.
    var cardTimes: [TimeInterval] {
        entries.compactMap(\.cardAfter)
    }

    // MARK: Reading

    private func read(_ entryID: String, replacing scanID: String? = nil) async {
        guard let entry = entries.first(where: { $0.id == entryID }) else { return }
        update(entryID) { $0.state = .reading }
        do {
            let runID = try await ensureServerRun()
            let request = ScanRequest(
                runID: runID,
                itemJPEG: entry.itemJPEG,
                tagJPEG: entry.tagJPEG,
                tagText: entry.tagText,
                note: entry.note,
                replacesScanID: scanID,
            )
            let scan = try await service.createScan(request, idempotencyKey: UUID().uuidString.lowercased())
            let card = ScanCard(scan)
            let first = entry.cardAfter == nil
            update(entryID) { entry in
                entry.scanID = scan.id
                entry.state = .read(card)
                if first {
                    entry.cardAfter = now().timeIntervalSince(entry.shotAt)
                }
            }
            if currentID == entryID, let haptic = card.haptic {
                Haptics.play(haptic)
            }
            startResearch(entryID, scanID: scan.id)
            startComparisons(entryID, scan)
            if first, let cardAfter = entries.first(where: { $0.id == entryID })?.cardAfter {
                log.info("scan card after \(Int(cardAfter * 1000), privacy: .public) ms")
            }
        } catch let failure as APIFailure {
            update(entryID) { $0.state = .failed(message: failure.message, retryable: failure.retryable) }
        } catch {
            update(entryID) {
                $0.state = .failed(message: APIFailure.networkUnavailable.message, retryable: true)
            }
        }
        if let note = notesAfterRead.removeValue(forKey: entryID),
           let read = entries.first(where: { $0.id == entryID }), read.card != nil
        {
            update(entryID) { $0.note = note }
            await self.read(entryID, replacing: read.scanID)
        }
    }

    /// The server run, created once; a failed creation is tried again by the next read.
    private func ensureServerRun() async throws -> String {
        if let serverRun, let runID = try? await serverRun.value {
            return runID
        }
        let service = service
        let key = createRunKey
        let place = place
        let task = Task { () async throws -> String in
            try await service.createSourcingRun(place: place, idempotencyKey: key)
        }
        serverRun = task
        return try await task.value
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
        storePhoto(capture, for: entryID, into: \.tagPhotos)
        let lines = await ScanTagText.read(small, with: tagReader, within: Self.tagCloseUpReadDeadline)
        update(entryID) { entry in
            entry.tagJPEG = small
            entry.tagText = Array((entry.tagText + lines).prefix(40))
        }
        await read(entryID, replacing: entry.scanID)
    }

    private func storePhoto(
        _ capture: Data,
        for entryID: String,
        into tasks: ReferenceWritableKeyPath<ScanRunModel, [String: Task<StoredScanPhoto, any Error>]>,
    ) {
        let directory = directory
        self[keyPath: tasks][entryID] = Task.detached(priority: .utility) {
            try ScanPhotos.store(capture, in: directory)
        }
    }

    func update(_ entryID: String, _ change: (inout ScanEntry) -> Void) {
        guard let index = entries.firstIndex(where: { $0.id == entryID }) else { return }
        change(&entries[index])
    }
}

/// The run's checkout (`ScanCheckoutModel`): what it sends, and how the run ends with it.
extension ScanRunModel {
    /// A Keep still being saved on this iPhone: checkout waits for it.
    var isKeeping: Bool {
        entries.contains { $0.decision == .keeping }
    }

    /// The run can be checked out once anything was scanned and no Keep is still being saved.
    var canCheckOut: Bool {
        !isEnded && !entries.isEmpty && !isKeeping
    }

    /// The scans kept on this iPhone, in the order shot.
    var keptScanIDs: [String] {
        entries.filter(\.isKept).compactMap(\.scanID)
    }

    /// Ends the run: the items not kept count as skipped, and the shots' files go. The kept
    /// drafts stay, uploading in the background.
    func end() async {
        guard !isEnded else { return }
        finish()
        if let serverRun, let runID = try? await serverRun.value {
            do {
                try await service.endSourcingRun(runID: runID, idempotencyKey: UUID().uuidString.lowercased())
            } catch {
                // The run stays open on the server; its scans were never kept either way.
                log.error("Ending a sourcing run failed: \(error.message, privacy: .public)")
            }
        }
        try? FileManager.default.removeItem(at: directory)
        comparisons?.coolDown()
    }

    /// The run takes no more shots, and its photos still being prepared are dropped.
    private func finish() {
        isEnded = true
        tagShotFor = nil
        for task in photos.values {
            task.cancel()
        }
        for task in tagPhotos.values {
            task.cancel()
        }
    }

    /// The run's server id, creating the run if no read did yet.
    func serverRunID() async throws -> String {
        try await ensureServerRun()
    }

    /// Ends the run once it was checked out: no more shots, and the shots' files go.
    func close() {
        finish()
        try? FileManager.default.removeItem(at: directory)
        comparisons?.coolDown()
    }
}

/// Keeping: the run's other half.
extension ScanRunModel {
    /// Saves the item as a draft on this iPhone at once; the upload queue creates its server item
    /// from the scan in the background. The camera stays open.
    func keep(_ entryID: String) async {
        guard let entry = entries.first(where: { $0.id == entryID }), let scanID = entry.scanID,
              let card = entry.card, entry.decision == .open || isKeepFailed(entry)
        else { return }
        update(entryID) { $0.decision = .keeping }
        do {
            guard let photo = try await photos[entryID]?.value else { throw ScanKeepError.noPhoto }
            var shots = try [(photo.preparedPhoto(), PhotoRole.front)]
            if let tag = try await tagPhotos[entryID]?.value {
                try shots.append((tag.preparedPhoto(), .tag))
            }
            let origin = DraftScanOrigin(scanID: scanID, runID: id, title: card.title)
            guard let draftID = await saveDraft(shots, origin) else { throw ScanKeepError.notSaved }
            update(entryID) { $0.decision = .kept(draftID: draftID) }
            Haptics.play(.success)
        } catch {
            log.error("Keeping a scan failed: \(String(describing: error), privacy: .public)")
            update(entryID) { $0.decision = .keepFailed("Couldn't save it on this iPhone. Try again.") }
            Haptics.play(.failure)
        }
    }

    private func isKeepFailed(_ entry: ScanEntry) -> Bool {
        if case .keepFailed = entry.decision {
            true
        } else {
            false
        }
    }
}

private enum ScanKeepError: Error {
    case noPhoto
    case notSaved
}
