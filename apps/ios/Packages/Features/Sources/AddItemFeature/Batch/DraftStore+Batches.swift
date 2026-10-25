import Core
import Foundation
import GRDB

/// A batch with everything about it on this iPhone: its photos not confirmed yet (grouped into
/// stacks, or just taken), and the drafts its confirmed stacks became, in haul order.
struct Batch: Equatable, Identifiable, Sendable {
    struct Stack: Equatable, Identifiable, Sendable {
        let record: BatchStackRecord
        /// In order within the stack; the first is the cover.
        let shots: [BatchShotRecord]

        var id: String {
            record.id
        }
    }

    let record: BatchRecord
    /// The proposed items waiting for the seller to confirm them, in display order.
    let stacks: [Stack]
    /// Photos taken since the last grouping, in capture order.
    let ungrouped: [BatchShotRecord]
    /// The confirmed items, in haul order.
    let drafts: [Draft]

    var id: String {
        record.id
    }

    var unconfirmedShotCount: Int {
        ungrouped.count + stacks.reduce(0) { $0 + $1.shots.count }
    }

    /// Close calls the seller has not checked: boundaries and photos the grouper was unsure about.
    var reviewCount: Int {
        stacks.reduce(0) { count, stack in
            count + (stack.record.startNeedsReview ? 1 : 0) + stack.shots.count(where: \.uncertain)
        }
    }
}

/// Batches on the device. Every change is one transaction; files are written before the rows that
/// name them and removed after, as for drafts.
extension DraftStore {
    /// More photos than any haul needs; it keeps one batch's files within reason.
    static let maxShotsPerBatch = 400

    // MARK: Reading

    /// Every batch, newest first, and then every change to them.
    func observeBatches() -> AsyncValueObservation<[Batch]> {
        ValueObservation
            .tracking { db in try Self.fetchBatches(db, id: nil) }
            .removeDuplicates()
            .values(in: writer)
    }

    /// One batch, nil once it is deleted, and then every change to it.
    func observeBatch(id: String) -> AsyncValueObservation<Batch?> {
        ValueObservation
            .tracking { db in try Self.fetchBatches(db, id: id).first }
            .removeDuplicates()
            .values(in: writer)
    }

    func batch(id: String) throws -> Batch? {
        try writer.read { db in try Self.fetchBatches(db, id: id).first }
    }

    func fileURL(for shot: BatchShotRecord) -> URL {
        database.photosDirectory.appending(path: shot.fileName)
    }

    private static func fetchBatches(_ db: Database, id: String?) throws -> [Batch] {
        var request = BatchRecord.order(Column("createdAt").desc)
        if let id {
            request = request.filter(key: id)
        }
        let batches = try request.fetchAll(db)
        guard !batches.isEmpty else { return [] }
        let ids = batches.map(\.id)
        let stacks = try Dictionary(
            grouping: BatchStackRecord.filter(ids.contains(BatchStackRecord.Columns.batchID))
                .order(BatchStackRecord.Columns.position).fetchAll(db),
        ) { $0.batchID }
        let shots = try BatchShotRecord.filter(ids.contains(BatchShotRecord.Columns.batchID))
            .order(BatchShotRecord.Columns.sequence).fetchAll(db)
        let shotsByStack = Dictionary(grouping: shots.filter { $0.stackID != nil }) { $0.stackID ?? "" }
        let ungrouped = Dictionary(grouping: shots.filter { $0.stackID == nil }) { $0.batchID }
        let drafts = try DraftRecord.filter(ids.contains(DraftRecord.Columns.batchID)).fetchAll(db)
        let photos = try Dictionary(
            grouping: DraftPhotoRecord.filter(drafts.map(\.id).contains(DraftPhotoRecord.Columns.draftID))
                .order(DraftPhotoRecord.Columns.position).fetchAll(db),
        ) { $0.draftID }
        let draftsByBatch = Dictionary(grouping: drafts) { $0.batchID ?? "" }
        return batches.map { batch in
            Batch(
                record: batch,
                stacks: (stacks[batch.id] ?? []).map { stack in
                    Batch.Stack(
                        record: stack,
                        shots: (shotsByStack[stack.id] ?? [])
                            .sorted { ($0.stackPosition ?? 0) < ($1.stackPosition ?? 0) },
                    )
                },
                ungrouped: ungrouped[batch.id] ?? [],
                drafts: (draftsByBatch[batch.id] ?? [])
                    .sorted { ($0.batchPosition ?? 0) < ($1.batchPosition ?? 0) }
                    .map { Draft(record: $0, photos: photos[$0.id] ?? []) },
            )
        }
    }

    // MARK: Capture

    @discardableResult
    func createBatch() throws -> BatchRecord {
        let batch = BatchRecord.new(now: now())
        try writer.write { db in try batch.insert(db) }
        return batch
    }

    /// Saves one photo of the haul, after the ones taken before. Its signals are read afterwards
    /// (``recordSignals(_:of:)``).
    @discardableResult
    func addShot(
        _ photo: PreparedPhoto,
        to batchID: String,
        capturedAt: Date,
        startsNewItem: Bool,
    ) throws -> BatchShotRecord {
        let placeholder = BatchShotRecord.new(
            batchID: batchID,
            sequence: 0,
            photo: photo,
            capturedAt: capturedAt,
            startsNewItem: startsNewItem,
        )
        let url = fileURL(for: placeholder)
        try photo.data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        do {
            return try writer.write { db in
                guard try BatchRecord.exists(db, key: batchID) else { throw DraftStoreError.notFound }
                let shots = BatchShotRecord.filter(BatchShotRecord.Columns.batchID == batchID)
                guard try shots.fetchCount(db) < Self.maxShotsPerBatch else { throw DraftStoreError.tooManyPhotos }
                var shot = placeholder
                shot.sequence = try (Int.fetchOne(db, shots.select(max(BatchShotRecord.Columns.sequence))) ?? -1) + 1
                try shot.insert(db)
                return shot
            }
        } catch {
            try? FileManager.default.removeItem(at: url)
            throw error
        }
    }

    /// Keeps a photo's grouping signals; nil records that reading them failed.
    func recordSignals(_ signals: ShotSignals?, of shotID: String) throws {
        try writer.write { db in
            guard var shot = try BatchShotRecord.fetchOne(db, key: shotID) else { return }
            shot.signals = signals
            shot.signalsState = signals == nil ? .failed : .done
            try shot.update(db)
        }
    }

    /// Photos of the batch whose signals have not been read yet.
    func shotsWaitingForSignals(in batchID: String) throws -> [BatchShotRecord] {
        try writer.read { db in
            try BatchShotRecord
                .filter(BatchShotRecord.Columns.batchID == batchID)
                .filter(Column("signalsState") == SignalsState.pending.rawValue)
                .order(BatchShotRecord.Columns.sequence)
                .fetchAll(db)
        }
    }

    /// Removes a photo of the batch, and its stack if it was the stack's last photo.
    func deleteShot(_ shotID: String) throws {
        let removed = try writer.write { db -> BatchShotRecord? in
            guard let shot = try BatchShotRecord.fetchOne(db, key: shotID) else { return nil }
            try shot.delete(db)
            if let stackID = shot.stackID {
                try Self.tidy(stack: stackID, in: db)
            }
            return shot
        }
        if let removed {
            try? FileManager.default.removeItem(at: fileURL(for: removed))
        }
    }

    // MARK: Confirming

    /// Turns every stack into a draft of the batch, in display order, and returns them. Each
    /// draft's photos keep their files; tag-like photos become tags (read on the device before
    /// upload), the first two others the front and back, the rest details.
    @discardableResult
    func confirmStacks(in batchID: String) throws -> [DraftRecord] {
        try writer.write { db in
            guard var batch = try BatchRecord.fetchOne(db, key: batchID) else { throw DraftStoreError.notFound }
            var drafts: [DraftRecord] = []
            for stack in try Self.stacks(of: batchID, in: db) {
                let shots = try Self.shots(ofStack: stack.id, in: db)
                guard !shots.isEmpty else { continue }
                guard shots.count <= Self.maxPhotosPerDraft else { throw DraftStoreError.tooManyPhotos }
                var draft = DraftRecord.new(now: now())
                draft.batchID = batchID
                draft.batchPosition = batch.nextPosition
                batch.nextPosition += 1
                try draft.insert(db)
                for ((index, shot), role) in zip(shots.enumerated(), Self.roles(for: shots)) {
                    try DraftPhotoRecord.new(draftID: draft.id, position: index, role: role, shot: shot, now: now())
                        .insert(db)
                }
                drafts.append(draft)
            }
            try BatchShotRecord.filter(BatchShotRecord.Columns.batchID == batchID).deleteAll(db)
            try BatchStackRecord.filter(BatchStackRecord.Columns.batchID == batchID).deleteAll(db)
            try batch.update(db)
            return drafts
        }
    }

    /// The roles of a stack's photos: tags for those that look like one, then front, back, and
    /// details in order.
    static func roles(for shots: [BatchShotRecord]) -> [PhotoRole] {
        var garments = 0
        return shots.map { shot in
            if shot.signals?.looksLikeTag == true {
                return .tag
            }
            garments += 1
            return switch garments {
            case 1: .front
            case 2: .back
            default: .detail
            }
        }
    }

    // MARK: Interaction and removal

    /// Keeps the batch's measured interaction for the upload queue to send.
    func setInteraction(_ interaction: BatchInteraction, of batchID: String) throws {
        try writer.write { db in
            guard var batch = try BatchRecord.fetchOne(db, key: batchID),
                  batch.interaction != interaction else { return }
            batch.interaction = interaction
            batch.interactionSynced = false
            try batch.update(db)
        }
    }

    /// Deletes a batch with its photos and drafts; the drafts' server items are deleted by the
    /// upload queue. Returns the removed draft photos so the caller can stop their transfers.
    @discardableResult
    func deleteBatch(_ batchID: String) throws -> [DraftPhotoRecord] {
        let drafts = try writer.read { db in
            try DraftRecord.filter(DraftRecord.Columns.batchID == batchID).fetchAll(db)
        }
        var removed: [DraftPhotoRecord] = []
        for draft in drafts {
            removed += try deleteDraft(draft.id)
        }
        let shots = try writer.write { db -> [BatchShotRecord] in
            let shots = try BatchShotRecord.filter(BatchShotRecord.Columns.batchID == batchID).fetchAll(db)
            _ = try BatchRecord.deleteOne(db, key: batchID)
            return shots
        }
        for shot in shots {
            try? FileManager.default.removeItem(at: fileURL(for: shot))
        }
        return removed
    }

    /// Removes a batch that has nothing left on this iPhone: no photos, no drafts, and no
    /// interaction waiting to be sent. Returns whether it did.
    @discardableResult
    func removeBatchIfFinished(_ batchID: String) throws -> Bool {
        try writer.write { db in
            guard let batch = try BatchRecord.fetchOne(db, key: batchID),
                  batch.interaction == nil || batch.interactionSynced,
                  try DraftRecord.filter(DraftRecord.Columns.batchID == batchID).isEmpty(db),
                  try BatchShotRecord.filter(BatchShotRecord.Columns.batchID == batchID).isEmpty(db)
            else { return false }
            return try batch.delete(db)
        }
    }
}

extension DraftPhotoRecord {
    /// A confirmed batch photo as a draft photo: the same file, with its role.
    static func new(
        draftID: String,
        position: Int,
        role: PhotoRole,
        shot: BatchShotRecord,
        now: Date,
    ) -> DraftPhotoRecord {
        DraftPhotoRecord(
            id: UUID().uuidString.lowercased(),
            draftID: draftID,
            position: position,
            role: role,
            fileName: shot.fileName,
            width: shot.width,
            height: shot.height,
            byteSize: shot.byteSize,
            sha256: shot.sha256,
            looksBlurry: shot.looksBlurry,
            tagReadState: role == .tag ? .pending : .notNeeded,
            createdAt: now,
            sessionKey: UUID().uuidString.lowercased(),
            attachKey: UUID().uuidString.lowercased(),
        )
    }
}
