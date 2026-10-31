import Core
import Foundation

/// The queue: the run and its scans kept on this iPhone (``ScanQueueStore``), written as they
/// change and read back at launch, so no scan waiting for signal is lost with the app.
extension ScanRunModel {
    static func itemFile(_ entryID: String) -> String {
        "\(entryID)-item.jpg"
    }

    static func tagFile(_ entryID: String) -> String {
        "\(entryID)-tag.jpg"
    }

    func writeShot(_ jpeg: Data, to fileName: String) {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try jpeg.write(
                to: directory.appending(path: fileName),
                options: .completeFileProtectionUntilFirstUserAuthentication,
            )
        } catch {
            log.error("Keeping a scan shot failed: \(String(describing: error), privacy: .public)")
        }
    }

    func removeShots(of entryID: String) {
        for file in [Self.itemFile(entryID), Self.tagFile(entryID)] {
            try? FileManager.default.removeItem(at: directory.appending(path: file))
        }
        for photo in [storedPhotos.removeValue(forKey: entryID), storedTagPhotos.removeValue(forKey: entryID)] {
            if let photo {
                try? FileManager.default.removeItem(at: photo.file)
            }
        }
    }

    func saveRun() {
        guard let queue = dependencies.queue else { return }
        do {
            try queue.save(record)
        } catch {
            log.error("Keeping a scan run failed: \(String(describing: error), privacy: .public)")
        }
    }

    func persist(_ entryID: String) {
        guard let queue = dependencies.queue, !isFinished,
              let entry = entries.first(where: { $0.id == entryID })
        else { return }
        do {
            try queue.save(record(of: entry))
        } catch {
            log.error("Keeping a scan failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func record(of entry: ScanEntry) -> ScanEntryRecord {
        var record = ScanEntryRecord(
            id: entry.id,
            runID: id,
            number: entry.number,
            shotAt: entry.shotAt,
            hasTag: entry.tagJPEG != nil,
            tagText: entry.tagText,
            note: entry.note,
            scanID: entry.scanID,
            readKey: entry.readKey,
            replaces: entry.replaces,
            status: .waiting,
            readLate: entry.readLate,
            photo: storedPhotos[entry.id].map(Self.file),
            tagPhoto: storedTagPhotos[entry.id].map(Self.file),
            featurePrint: entry.featurePrint,
            duplicateOf: entry.duplicateOf,
            cardAfter: entry.cardAfter,
        )
        switch entry.state {
        case .read:
            record.status = .read
            record.scan = entry.scan.flatMap { try? Self.encoder.encode($0) }
        case let .failed(message, retryable):
            record.status = .failed
            record.failureMessage = message
            record.failureRetryable = retryable
        case .reading, .waiting:
            // A read cut off with the app is due again.
            record.status = .waiting
        }
        switch entry.decision {
        case .open, .keeping, .keepFailed:
            record.decision = .open
        case .keepWhenRead:
            record.decision = .keepWhenRead
        case let .kept(draftID):
            record.decision = .kept
            record.draftID = draftID
        }
        return record
    }

    /// The scans as they were kept; one whose shot is gone is dropped.
    func restore(_ records: [ScanEntryRecord]) {
        var dropped: [String] = []
        for record in records {
            guard let entry = entry(of: record) else {
                dropped.append(record.id)
                continue
            }
            entries.append(entry)
            storedPhotos[record.id] = record.photo.map(photo)
            storedTagPhotos[record.id] = record.tagPhoto.map(photo)
        }
        currentID = entries.last?.id
        if !dropped.isEmpty {
            try? dependencies.queue?.deleteEntries(dropped)
        }
    }

    private func entry(of record: ScanEntryRecord) -> ScanEntry? {
        guard let item = try? Data(contentsOf: directory.appending(path: Self.itemFile(record.id))) else {
            return nil
        }
        var entry = ScanEntry(id: record.id, number: record.number, shotAt: record.shotAt, itemJPEG: item)
        entry.tagJPEG = record.hasTag
            ? try? Data(contentsOf: directory.appending(path: Self.tagFile(record.id)))
            : nil
        entry.tagText = record.tagText
        entry.note = record.note
        entry.scanID = record.scanID
        entry.readKey = record.readKey
        entry.replaces = record.replaces
        entry.readLate = record.readLate
        entry.featurePrint = record.featurePrint
        entry.duplicateOf = record.duplicateOf
        entry.cardAfter = record.cardAfter
        entry.instant = instantRead(record.tagText)
        let scan = record.scan.flatMap { try? Self.decoder.decode(ItemScan.self, from: $0) }
        switch record.status {
        case .read where scan != nil:
            entry.scan = scan
            entry.state = scan.map { .read(ScanCard($0)) } ?? .waiting
            entry.research = scan?.research == nil ? .none : .done
        case .failed:
            entry.state = .failed(message: record.failureMessage ?? "", retryable: record.failureRetryable)
        case .read, .waiting:
            entry.state = .waiting
        }
        switch record.decision {
        case .open:
            entry.decision = .open
        case .keepWhenRead:
            entry.decision = .keepWhenRead
        case .kept:
            entry.decision = record.draftID.map { .kept(draftID: $0) } ?? .open
        }
        return entry
    }

    private static func file(_ photo: StoredScanPhoto) -> ScanPhotoFile {
        ScanPhotoFile(
            fileName: photo.file.lastPathComponent,
            width: photo.width,
            height: photo.height,
            sha256: photo.sha256,
            sharpness: photo.sharpness,
        )
    }

    private func photo(_ file: ScanPhotoFile) -> StoredScanPhoto {
        StoredScanPhoto(
            file: directory.appending(path: file.fileName),
            width: file.width,
            height: file.height,
            sha256: file.sha256,
            sharpness: file.sharpness,
        )
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
