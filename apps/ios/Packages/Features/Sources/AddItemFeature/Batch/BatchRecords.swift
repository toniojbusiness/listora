import Core
import Foundation
import GRDB

/// A haul photographed in one session (docs/features/batch.md). Its photos wait as
/// ``BatchShotRecord``s, grouped into ``BatchStackRecord``s, until the seller confirms the
/// grouping; then each stack becomes a draft of the batch, uploaded by the queue like any draft.
struct BatchRecord: Codable, Equatable, Identifiable, Sendable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "batch"

    var id: String
    var createdAt: Date
    /// The `Idempotency-Key` of this batch's `createItemBatch`, reused on every retry.
    var createBatchKey: String
    var serverBatchID: String?
    /// The position the next confirmed stack gets in the server batch (positions are never reused).
    var nextPosition = 0
    /// The seller's measured interaction so far, whole: the server replaces it with every send
    /// (`replaceItemBatchInteraction`).
    var interaction: BatchInteraction?
    /// The server has ``interaction`` as it is now.
    var interactionSynced = false
    var retry = RetryState()

    static func new(now: Date) -> BatchRecord {
        BatchRecord(id: UUID().uuidString.lowercased(), createdAt: now, createBatchKey: UUID().uuidString.lowercased())
    }

    /// The ``InteractionMeter`` session of the batch's shared screens (capture, grouping, the batch).
    var meterSession: String {
        Self.meterSession(id)
    }

    static func meterSession(_ batchID: String) -> String {
        "batch-\(batchID)"
    }
}

/// The interaction the app measured for a batch and its saved items, as the server records it.
struct BatchInteraction: Codable, Equatable, Sendable {
    struct Totals: Codable, Equatable, Sendable {
        var activeMs: Int64
        var waitingMs: Int64
        var taps: Int

        init(activeMs: Int64, waitingMs: Int64, taps: Int) {
            self.activeMs = activeMs
            self.waitingMs = waitingMs
            self.taps = taps
        }

        init(active: TimeInterval, waiting: TimeInterval, taps: Int) {
            self.init(
                activeMs: Int64((active * 1000).rounded()),
                waitingMs: Int64((waiting * 1000).rounded()),
                taps: taps,
            )
        }

        static let zero = Totals(activeMs: 0, waitingMs: 0, taps: 0)

        static func + (lhs: Totals, rhs: Totals) -> Totals {
            Totals(
                activeMs: lhs.activeMs + rhs.activeMs,
                waitingMs: lhs.waitingMs + rhs.waitingMs,
                taps: lhs.taps + rhs.taps,
            )
        }
    }

    struct Item: Codable, Equatable, Sendable {
        var serverItemID: String
        var totals: Totals
    }

    /// The whole batch: its shared screens plus every item's review.
    var batch: Totals
    var items: [Item]
}

/// Whether a batch photo's grouping signals have been read on the device.
enum SignalsState: String, Codable, Sendable {
    case pending
    case done
    /// Reading failed; the photo is grouped without them (and the seller asked to check).
    case failed
}

/// One proposed item of a batch, before the seller confirms the grouping.
struct BatchStackRecord: Codable, Equatable, Identifiable, Sendable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "batchStack"

    var id: String
    var batchID: String
    /// Display order, 0 first.
    var position: Int
    /// How sure the grouper was that this stack is an item of its own (``ProposedStack``).
    var startConfidence: Double
    /// The seller kept it apart from the stack before after being asked.
    var startReviewed = false

    enum Columns {
        static let batchID = Column(CodingKeys.batchID)
        static let position = Column(CodingKeys.position)
    }

    /// The boundary before this stack is a close call the seller has not checked yet.
    var startNeedsReview: Bool {
        position > 0 && !startReviewed && startConfidence < BatchGrouper.reviewBelow
    }
}

/// One photo of a batch, in capture order, before the seller confirms the grouping. Its prepared
/// JPEG lives in the photo directory like a draft photo's, and becomes that photo's file once its
/// stack is confirmed.
struct BatchShotRecord: Codable, Equatable, Identifiable, Sendable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "batchShot"

    var id: String
    var batchID: String
    /// Capture order across the batch.
    var sequence: Int
    /// Its stack once the photos are grouped; nil until then.
    var stackID: String?
    /// Order within the stack.
    var stackPosition: Int?
    var fileName: String
    var width: Int
    var height: Int
    var byteSize: Int
    var sha256: String
    var looksBlurry: Bool
    /// When the photo was taken: the camera's time, or the library photo's capture date.
    var capturedAt: Date
    /// The seller tapped Next item before it.
    var startsNewItem: Bool
    var signals: ShotSignals?
    var signalsState: SignalsState = .pending
    /// The grouper asked whether it starts another item; cleared once the seller decides.
    var uncertain = false

    enum Columns {
        static let batchID = Column(CodingKeys.batchID)
        static let sequence = Column(CodingKeys.sequence)
        static let stackID = Column(CodingKeys.stackID)
        static let stackPosition = Column(CodingKeys.stackPosition)
    }

    static func new(
        batchID: String,
        sequence: Int,
        photo: PreparedPhoto,
        capturedAt: Date,
        startsNewItem: Bool,
    ) -> BatchShotRecord {
        let id = UUID().uuidString.lowercased()
        return BatchShotRecord(
            id: id,
            batchID: batchID,
            sequence: sequence,
            fileName: "\(id).jpg",
            width: photo.width,
            height: photo.height,
            byteSize: photo.data.count,
            sha256: photo.sha256,
            looksBlurry: photo.looksBlurry,
            capturedAt: capturedAt,
            startsNewItem: startsNewItem,
        )
    }

    var grouperShot: BatchShot {
        BatchShot(id: id, capturedAt: capturedAt, signals: signals, startsNewItem: startsNewItem)
    }
}

extension DraftDatabase {
    /// Batches: their photos and stacks before confirmation, the drafts' place in their batch, and
    /// what deleting a batch item on the server needs. Registered after v1, never changed.
    static func registerBatchMigration(in migrator: inout DatabaseMigrator) {
        migrator.registerMigration("v2: batches") { db in
            try createBatchTables(db)
            try addBatchColumns(db)
        }
    }

    private static func createBatchTables(_ db: Database) throws {
        try db.create(table: BatchRecord.databaseTableName) { table in
            table.primaryKey("id", .text)
            table.column("createdAt", .datetime).notNull()
            table.column("createBatchKey", .text).notNull()
            table.column("serverBatchID", .text)
            table.column("nextPosition", .integer).notNull()
            table.column("interaction", .jsonText)
            table.column("interactionSynced", .boolean).notNull()
            table.column("retry", .jsonText).notNull()
        }
        try db.create(table: BatchStackRecord.databaseTableName) { table in
            table.primaryKey("id", .text)
            table.column("batchID", .text)
                .notNull()
                .indexed()
                .references(BatchRecord.databaseTableName, onDelete: .cascade)
            table.column("position", .integer).notNull()
            table.column("startConfidence", .double).notNull()
            table.column("startReviewed", .boolean).notNull()
        }
        try db.create(table: BatchShotRecord.databaseTableName) { table in
            table.primaryKey("id", .text)
            table.column("batchID", .text)
                .notNull()
                .indexed()
                .references(BatchRecord.databaseTableName, onDelete: .cascade)
            table.column("sequence", .integer).notNull()
            table.column("stackID", .text)
                .indexed()
                .references(BatchStackRecord.databaseTableName, onDelete: .setNull)
            table.column("stackPosition", .integer)
            table.column("fileName", .text).notNull()
            table.column("width", .integer).notNull()
            table.column("height", .integer).notNull()
            table.column("byteSize", .integer).notNull()
            table.column("sha256", .text).notNull()
            table.column("looksBlurry", .boolean).notNull()
            table.column("capturedAt", .datetime).notNull()
            table.column("startsNewItem", .boolean).notNull()
            table.column("signals", .jsonText)
            table.column("signalsState", .text).notNull()
            table.column("uncertain", .boolean).notNull()
        }
    }

    private static func addBatchColumns(_ db: Database) throws {
        try db.alter(table: DraftRecord.databaseTableName) { table in
            table.add(column: "batchID", .text)
                .references(BatchRecord.databaseTableName, onDelete: .setNull)
            table.add(column: "batchPosition", .integer)
            table.add(column: "submitKey", .text)
            table.add(column: "submittedPhotoIDs", .jsonText)
        }
        try db.create(index: "draft_on_batchID", on: DraftRecord.databaseTableName, columns: ["batchID"])
        try db.alter(table: ServerDeletionRecord.databaseTableName) { table in
            table.add(column: "serverBatchID", .text)
            table.add(column: "batchPosition", .integer)
        }
    }
}
