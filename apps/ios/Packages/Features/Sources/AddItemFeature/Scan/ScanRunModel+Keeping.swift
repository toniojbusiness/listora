import Core
import DesignSystem
import Foundation

/// Keeping and ending: the run's other half.
extension ScanRunModel {
    /// Saves the item as a draft on this iPhone at once; the upload queue creates its server item
    /// from the scan in the background. The camera stays open. A scan not read yet (no signal,
    /// or still reading) is kept as soon as it is: its draft needs the scan.
    func keep(_ entryID: String) async {
        guard let entry = entries.first(where: { $0.id == entryID }),
              entry.decision == .open || entry.decision == .keepWhenRead || isKeepFailed(entry)
        else { return }
        guard let scanID = entry.scanID, entry.card != nil else {
            guard entry.decision == .open, entry.isWaiting || entry.state == .reading else { return }
            update(entryID) { $0.decision = .keepWhenRead }
            Haptics.play(.success)
            return
        }
        update(entryID) { $0.decision = .keeping }
        if let draftID = await saveDraft(of: entryID, scanID: scanID) {
            update(entryID) { $0.decision = .kept(draftID: draftID) }
            Haptics.play(.success)
        } else {
            update(entryID) { $0.decision = .keepFailed("Couldn't save it on this iPhone. Try again.") }
            Haptics.play(.failure)
        }
        await finishIfDone()
    }

    /// A kept scan that can never be read is saved as an ordinary draft with its photos, so the
    /// item the seller kept is never lost; its analysis then runs like any draft's.
    func keepWithoutRead(_ entryID: String) async {
        if let draftID = await saveDraft(of: entryID, scanID: nil) {
            update(entryID) { $0.decision = .kept(draftID: draftID) }
        } else {
            update(entryID) { $0.decision = .keepFailed("Couldn't save it on this iPhone. Try again.") }
        }
        await finishIfDone()
    }

    private func saveDraft(of entryID: String, scanID: String?) async -> String? {
        guard let entry = entries.first(where: { $0.id == entryID }) else { return nil }
        do {
            let item = try await storedPhoto(entryID, tasks: photos, stored: storedPhotos, else: entry.itemJPEG)
            var shots = try [(item.preparedPhoto(), PhotoRole.front)]
            if let tagJPEG = entry.tagJPEG {
                let tag = try await storedPhoto(entryID, tasks: tagPhotos, stored: storedTagPhotos, else: tagJPEG)
                try shots.append((tag.preparedPhoto(), .tag))
            }
            let origin = scanID.map { DraftScanOrigin(scanID: $0, runID: id, title: entry.card?.title ?? "") }
            guard let draftID = await dependencies.saveDraft(shots, origin) else { throw ScanKeepError.notSaved }
            return draftID
        } catch {
            log.error("Keeping a scan failed: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    /// The shot's upload-sized photo; when the app closed before it was prepared, one made from
    /// the shot's small JPEG instead, so a kept item always has its photo.
    private func storedPhoto(
        _ entryID: String,
        tasks: [String: Task<StoredScanPhoto, any Error>],
        stored: [String: StoredScanPhoto],
        else small: Data,
    ) async throws -> StoredScanPhoto {
        if let task = tasks[entryID], let photo = try? await task.value {
            return photo
        }
        if let photo = stored[entryID] {
            return photo
        }
        let directory = directory
        return try await Task.detached(priority: .userInitiated) { try ScanPhotos.store(small, in: directory) }.value
    }

    private func isKeepFailed(_ entry: ScanEntry) -> Bool {
        if case .keepFailed = entry.decision {
            true
        } else {
            false
        }
    }

    private func existingServerRun() async -> String? {
        if let runID = record.serverRunID {
            return runID
        }
        return try? await serverRun?.value
    }

    /// Ends the run: the items not kept count as skipped, and their shots go. A kept scan still
    /// waiting for signal stays queued: the run finishes once it is read and saved.
    func end() async {
        guard !isEnded else { return }
        isEnded = true
        tagShotFor = nil
        let skipped = entries.filter { !$0.isKeptOrPending }.map(\.id)
        for entryID in skipped {
            photos.removeValue(forKey: entryID)?.cancel()
            tagPhotos.removeValue(forKey: entryID)?.cancel()
            removeShots(of: entryID)
        }
        entries.removeAll { skipped.contains($0.id) }
        if !entries.contains(where: { $0.id == currentID }) {
            currentID = entries.last?.id
        }
        do {
            try dependencies.queue?.deleteEntries(skipped)
        } catch {
            log.error("Removing a run's skipped scans failed: \(String(describing: error), privacy: .public)")
        }
        record.endRequested = true
        saveRun()
        await finishIfDone()
    }

    /// Finishes an ended run once no kept scan waits: ends it on the server and removes its files
    /// and records. The kept drafts stay, uploading in the background.
    func finishIfDone() async {
        guard isEnded, !isFinished, !entries.contains(where: { $0.decision == .keepWhenRead }) else { return }
        isFinished = true
        // Only a server run that exists (or is being made) is ended; none is made just to end it.
        if let runID = await existingServerRun() {
            do {
                try await service.endSourcingRun(runID: runID, idempotencyKey: UUID().uuidString.lowercased())
            } catch {
                // The run stays open on the server; its scans were never kept either way.
                log.error("Ending a sourcing run failed: \(error.message, privacy: .public)")
            }
        }
        for task in photos.values {
            task.cancel()
        }
        for task in tagPhotos.values {
            task.cancel()
        }
        try? FileManager.default.removeItem(at: directory)
        do {
            try dependencies.queue?.deleteRun(id)
        } catch {
            log.error("Removing a finished run failed: \(String(describing: error), privacy: .public)")
        }
        onFinished?(self)
    }
}

private enum ScanKeepError: Error {
    case notSaved
}
