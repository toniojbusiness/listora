import APIClient
import Core
import DesignSystem
import Foundation

/// Reading: each scan's read, with signal at once, without it from the queue once there is.
extension ScanRunModel {
    /// A new read of the entry (a note or the tag after its last read), under a new key.
    func beginRead(_ entryID: String, replacing scanID: String?) async {
        update(entryID) { entry in
            entry.readKey = UUID().uuidString.lowercased()
            entry.replaces = scanID
        }
        await attemptRead(entryID)
    }

    /// Reads the entry now, or queues the read when there is no signal. `announce` plays the
    /// instant call's haptic when the read has to wait; `late` marks a read from the queue.
    func attemptRead(_ entryID: String, announce: Bool = false, late: Bool = false) async {
        guard let entry = entries.first(where: { $0.id == entryID }) else { return }
        update(entryID) { $0.state = .reading }
        if dependencies.connectivity?.isOnline == false {
            queueRead(entryID, announce: announce)
            return
        }
        do {
            let runID = try await ensureServerRun()
            let request = ScanRequest(
                runID: runID,
                itemJPEG: entry.itemJPEG,
                tagJPEG: entry.tagJPEG,
                tagText: entry.tagText,
                note: entry.note,
                replacesScanID: entry.replaces,
            )
            let scan = try await service.createScan(request, idempotencyKey: entry.readKey)
            await land(entryID, scan, late: late)
        } catch let failure as APIFailure {
            if Self.meansNoSignal(failure) {
                queueRead(entryID, announce: announce)
            } else {
                await fail(entryID, failure)
            }
        } catch {
            queueRead(entryID, announce: announce)
        }
        if let note = notesAfterRead.removeValue(forKey: entryID),
           let read = entries.first(where: { $0.id == entryID }), read.card != nil
        {
            update(entryID) { $0.note = note }
            await beginRead(entryID, replacing: read.scanID)
        }
    }

    /// A failure that says the request never got an answer: no signal, or an answer still on
    /// its way. The read waits and is tried again under the same key.
    static func meansNoSignal(_ failure: APIFailure) -> Bool {
        failure.code == APIFailure.networkUnavailable.code || failure.code == "idempotency_key_in_progress"
    }

    /// Reads the scans waiting for signal, newest first (the one in hand matters most), until one
    /// still finds none. A run ended while kept scans waited finishes once they are saved.
    func drain() async {
        guard !isDraining, !isFinished, dependencies.connectivity?.isOnline != false else { return }
        isDraining = true
        let waiting = entries.filter(\.isWaiting).sorted { $0.number > $1.number }.map(\.id)
        for entryID in waiting {
            guard entries.first(where: { $0.id == entryID })?.isWaiting == true else { continue }
            await attemptRead(entryID, late: true)
            if entries.first(where: { $0.id == entryID })?.isWaiting == true {
                break
            }
        }
        isDraining = false
        await finishIfDone()
    }

    private func land(_ entryID: String, _ scan: ItemScan, late: Bool) async {
        let card = ScanCard(scan)
        let first = entries.first(where: { $0.id == entryID })?.cardAfter == nil
        update(entryID) { entry in
            entry.scanID = scan.id
            entry.scan = scan
            entry.state = .read(card)
            entry.replaces = nil
            entry.readKey = UUID().uuidString.lowercased()
            if late {
                entry.readLate = true
            } else if first {
                // Only a read with signal counts toward the card's seconds from the shutter.
                entry.cardAfter = dependencies.now().timeIntervalSince(entry.shotAt)
            }
        }
        if !late, currentID == entryID, let haptic = card.haptic {
            Haptics.play(haptic)
        }
        startResearch(entryID, scanID: scan.id)
        startComparisons(entryID, scan)
        if !late, first, let cardAfter = entries.first(where: { $0.id == entryID })?.cardAfter {
            log.info("scan card after \(Int(cardAfter * 1000), privacy: .public) ms")
        }
        if entries.first(where: { $0.id == entryID })?.decision == .keepWhenRead {
            await keep(entryID)
        }
    }

    private func queueRead(_ entryID: String, announce: Bool) {
        update(entryID) { $0.state = .waiting }
        guard announce, currentID == entryID,
              let instant = entries.first(where: { $0.id == entryID })?.instant
        else { return }
        if let haptic = OfflineScanCard(instant).haptic {
            Haptics.play(haptic)
        }
    }

    private func fail(_ entryID: String, _ failure: APIFailure) async {
        guard entries.first(where: { $0.id == entryID })?.decision == .keepWhenRead else {
            update(entryID) { $0.state = .failed(message: failure.message, retryable: failure.retryable) }
            return
        }
        // A kept scan is never lost: tried again later while its failure may pass, else saved as
        // an ordinary draft without its read.
        if failure.retryable {
            update(entryID) { $0.state = .waiting }
        } else {
            log.error("A kept scan can't be read: \(failure.message, privacy: .public)")
            update(entryID) { $0.state = .failed(message: failure.message, retryable: false) }
            await keepWithoutRead(entryID)
        }
    }

    /// The server run, created once under the run's key; a failed creation is tried again by the
    /// next read.
    func ensureServerRun() async throws -> String {
        if let runID = record.serverRunID {
            return runID
        }
        if let serverRun, let runID = try? await serverRun.value {
            return runID
        }
        let service = service
        let key = record.createRunKey
        let place = record.place
        let task = Task { () async throws -> String in
            try await service.createSourcingRun(place: place, idempotencyKey: key)
        }
        serverRun = task
        let runID = try await task.value
        record.serverRunID = runID
        saveRun()
        return runID
    }

    /// Reads the shot's feature print in the background, then warns when it looks like an item
    /// shot earlier in the run (``BatchGrouper/sameItemBelow``, the batch camera's "same item").
    func readFeaturePrint(of entryID: String, _ jpeg: Data) {
        guard let reader = dependencies.signalReader else { return }
        Task { [weak self] in
            let print = try? await reader.signals(of: jpeg).featurePrint
            self?.takeFeaturePrint(print, for: entryID)
        }
    }

    private func takeFeaturePrint(_ print: [Float]?, for entryID: String) {
        guard let print, let entry = entries.first(where: { $0.id == entryID }) else { return }
        let nearest = entries
            .filter { $0.number < entry.number }
            .compactMap { earlier in ShotSignals.distance(print, earlier.featurePrint).map { (earlier.number, $0) } }
            .min { $0.1 < $1.1 }
        update(entryID) { entry in
            entry.featurePrint = print
            entry.duplicateOf = nearest.flatMap { $0.1 <= BatchGrouper.sameItemBelow ? $0.0 : nil }
        }
    }
}
