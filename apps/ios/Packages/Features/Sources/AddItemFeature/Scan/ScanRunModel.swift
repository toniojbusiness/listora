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
    private(set) var currentID: String?
    /// The next shot is a close-up of this entry's tag, not a new item.
    private(set) var tagShotFor: String?
    /// A note said before the next shot, which rides along with its read.
    private(set) var pendingNote: String?
    private(set) var isEnded = false

    let service: any ScanService
    private let tagReader: any TagReader
    private let saveDraft: ScanDraftSaver
    private let directory: URL
    private let now: () -> Date
    /// How long a card is on screen before its web research is asked for.
    let researchDwell: Duration
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
    /// How long a card is on screen before its item is looked up on the web. At the bins most
    /// items are skipped within a second or two of their card, by shooting the next one; a
    /// lookup costs about $0.02, so only a card the seller is still looking at gets one. A card
    /// picked again in the tray is looked up at once.
    static let defaultResearchDwell: Duration = .seconds(2)

    init(
        service: any ScanService,
        tagReader: any TagReader,
        directory: URL,
        saveDraft: @escaping ScanDraftSaver,
        comparisons: (any MarketComparisons)? = nil,
        comparing marketplaces: [String] = [],
        now: @escaping () -> Date = Date.init,
        researchDwell: Duration = ScanRunModel.defaultResearchDwell,
    ) {
        let id = UUID().uuidString.lowercased()
        self.id = id
        self.service = service
        self.comparisons = marketplaces.isEmpty ? nil : comparisons
        // The comparison pages load while the seller walks to the bins.
        self.comparisons?.warmUp(marketplaces)
        self.tagReader = tagReader
        self.directory = directory.appending(path: id, directoryHint: .isDirectory)
        self.saveDraft = saveDraft
        self.now = now
        self.researchDwell = researchDwell
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

    /// Starts the server run as the camera opens, so the first shot's read does not wait for it
    /// and finds the connection to Listora already open.
    func prepare() {
        guard !isEnded, serverRun == nil else { return }
        serverRun = makeServerRun()
    }

    /// A shot from the camera: a new item (skipping the last one), or the tag close-up the seller
    /// asked for. `shotAt` is when the shutter was pressed, which the card's time counts from.
    func shoot(_ capture: Data, shotAt: Date? = nil) async {
        guard !isEnded else { return }
        if let target = tagShotFor {
            tagShotFor = nil
            await addTag(capture, to: target)
            return
        }
        let shotAt = shotAt ?? now()
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

    /// Shows the entry's card (a tap in the tray), looked up on the web now if it was not yet.
    func select(_ entryID: String) {
        guard let entry = entries.first(where: { $0.id == entryID }) else { return }
        tagShotFor = nil
        currentID = entryID
        if let scanID = entry.scanID {
            startResearch(entryID, scanID: scanID)
        }
    }

    func retry(_ entryID: String) async {
        guard let entry = entries.first(where: { $0.id == entryID }), case .failed = entry.state else { return }
        await read(entryID, replacing: entry.scanID)
    }

    // MARK: The run

    /// Ends the run: the items not kept count as skipped, and the shots' files go. The kept
    /// drafts stay, uploading in the background.
    func end() async {
        guard !isEnded else { return }
        isEnded = true
        tagShotFor = nil
        for task in photos.values {
            task.cancel()
        }
        for task in tagPhotos.values {
            task.cancel()
        }
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
                // A new scan of the item: the last one's research, if any, was for that one.
                entry.research = .none
                if first {
                    entry.cardAfter = now().timeIntervalSince(entry.shotAt)
                }
            }
            if currentID == entryID, let haptic = card.haptic {
                Haptics.play(haptic)
            }
            scheduleResearch(entryID, scanID: scan.id)
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
        let task = makeServerRun()
        serverRun = task
        return try await task.value
    }

    private func makeServerRun() -> Task<String, any Error> {
        let service = service
        let key = createRunKey
        return Task { () async throws -> String in try await service.createSourcingRun(idempotencyKey: key) }
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
