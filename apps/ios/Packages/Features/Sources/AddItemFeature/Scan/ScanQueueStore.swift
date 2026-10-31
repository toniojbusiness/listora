import Foundation
import GRDB

/// A scan run kept on this iPhone (docs/features/thrift-scan.md, "Offline at the bins"), so the
/// run and every scan waiting for signal survive the app being closed.
struct ScanRunRecord: Codable, Equatable, Sendable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "scanRun"

    var id: String
    var startedAt: Date
    /// The `Idempotency-Key` of the run's `createSourcingRun`, reused until it is made.
    var createRunKey: String
    var serverRunID: String?
    /// The seller ended the run while kept scans still waited for signal: it finishes once they
    /// are read and saved.
    var endRequested = false

    enum Columns {
        static let startedAt = Column(CodingKeys.startedAt)
    }
}

/// A photo of a scan, as a file in the run's folder.
struct ScanPhotoFile: Codable, Equatable, Sendable {
    var fileName: String
    var width: Int
    var height: Int
    var sha256: String
    var sharpness: Double
}

/// One scan of a run as it is kept: the shot's small JPEG and tag close-up are files in the
/// run's folder (`<id>-item.jpg`, `<id>-tag.jpg`); the card is the server's answer as it came.
struct ScanEntryRecord: Codable, Equatable, Sendable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "scanEntry"

    enum Status: String, Codable, Sendable {
        /// The read is due: waiting for signal, or cut off with the app.
        case waiting
        case read
        case failed
    }

    enum Kept: String, Codable, Sendable {
        case open
        case keepWhenRead
        case kept
    }

    var id: String
    var runID: String
    var number: Int
    var shotAt: Date
    var hasTag = false
    var tagText: [String] = []
    var note: String?
    var scanID: String?
    var readKey: String
    var replaces: String?
    var status: Status
    /// The read's `ItemScan`, as JSON.
    var scan: Data?
    var failureMessage: String?
    var failureRetryable = false
    var readLate = false
    var decision: Kept = .open
    var draftID: String?
    var photo: ScanPhotoFile?
    var tagPhoto: ScanPhotoFile?
    var featurePrint: [Float]?
    var duplicateOf: Int?
    var cardAfter: Double?

    enum Columns {
        static let runID = Column(CodingKeys.runID)
        static let number = Column(CodingKeys.number)
    }
}

/// Reads and writes the kept scan runs, in the drafts database.
final class ScanQueueStore: Sendable {
    let writer: any DatabaseWriter

    init(writer: any DatabaseWriter) {
        self.writer = writer
    }

    /// Every run with its scans in order, the oldest run first.
    func runs() throws -> [(run: ScanRunRecord, entries: [ScanEntryRecord])] {
        try writer.read { db in
            let runs = try ScanRunRecord.order(ScanRunRecord.Columns.startedAt).fetchAll(db)
            let entries = try Dictionary(
                grouping: ScanEntryRecord.order(ScanEntryRecord.Columns.number).fetchAll(db),
            ) { $0.runID }
            return runs.map { ($0, entries[$0.id] ?? []) }
        }
    }

    func save(_ run: ScanRunRecord) throws {
        try writer.write { db in try run.save(db) }
    }

    func save(_ entry: ScanEntryRecord) throws {
        try writer.write { db in try entry.save(db) }
    }

    func deleteEntries(_ ids: [String]) throws {
        _ = try writer.write { db in try ScanEntryRecord.deleteAll(db, keys: ids) }
    }

    /// The run and its scans.
    func deleteRun(_ id: String) throws {
        _ = try writer.write { db in try ScanRunRecord.deleteOne(db, key: id) }
    }
}

extension DraftDatabase {
    /// The thrift scan's queue: runs and their scans, so scans waiting for signal survive a
    /// relaunch.
    static func registerScanQueueMigration(in migrator: inout DatabaseMigrator) {
        migrator.registerMigration("v6: the thrift scan queue") { db in
            try db.create(table: ScanRunRecord.databaseTableName) { table in
                table.primaryKey("id", .text)
                table.column("startedAt", .datetime).notNull()
                table.column("createRunKey", .text).notNull()
                table.column("serverRunID", .text)
                table.column("endRequested", .boolean).notNull()
            }
            try db.create(table: ScanEntryRecord.databaseTableName) { table in
                table.primaryKey("id", .text)
                table.column("runID", .text)
                    .notNull()
                    .indexed()
                    .references(ScanRunRecord.databaseTableName, onDelete: .cascade)
                table.column("number", .integer).notNull()
                table.column("shotAt", .datetime).notNull()
                table.column("hasTag", .boolean).notNull()
                table.column("tagText", .jsonText).notNull()
                table.column("note", .text)
                table.column("scanID", .text)
                table.column("readKey", .text).notNull()
                table.column("replaces", .text)
                table.column("status", .text).notNull()
                table.column("scan", .blob)
                table.column("failureMessage", .text)
                table.column("failureRetryable", .boolean).notNull()
                table.column("readLate", .boolean).notNull()
                table.column("decision", .text).notNull()
                table.column("draftID", .text)
                table.column("photo", .jsonText)
                table.column("tagPhoto", .jsonText)
                table.column("featurePrint", .jsonText)
                table.column("duplicateOf", .integer)
                table.column("cardAfter", .double)
            }
        }
    }
}
