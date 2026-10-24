import Foundation
import GRDB

/// The SQLite database (GRDB) that keeps drafts, their photos, and pending server deletions on the
/// device, so a draft and its upload progress survive the app being closed. Photo files live next
/// to it in `Photos/`.
///
/// The schema changes only through new migrations appended to ``migrator``; a shipped migration
/// never changes, because installed apps have already run it.
final class DraftDatabase: Sendable {
    let writer: any DatabaseWriter
    /// Where the prepared photo JPEGs are kept, named by ``DraftPhotoRecord/fileName``.
    let photosDirectory: URL

    /// Opens (creating if needed) the database in `directory`.
    init(directory: URL) throws {
        let fileManager = FileManager.default
        photosDirectory = directory.appending(path: "Photos", directoryHint: .isDirectory)
        try fileManager.createDirectory(at: photosDirectory, withIntermediateDirectories: true)
        var configuration = Configuration()
        configuration.foreignKeysEnabled = true
        writer = try DatabasePool(
            path: directory.appending(path: "drafts.sqlite").path(percentEncoded: false),
            configuration: configuration,
        )
        try Self.migrator.migrate(writer)
    }

    func fileURL(for photo: DraftPhotoRecord) -> URL {
        photosDirectory.appending(path: photo.fileName)
    }

    static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1: drafts, photos, server deletions") { db in
            try db.create(table: DraftRecord.databaseTableName) { table in
                table.primaryKey("id", .text)
                table.column("createdAt", .datetime).notNull()
                table.column("createItemKey", .text).notNull()
                table.column("createItemSent", .boolean).notNull()
                table.column("serverItemID", .text)
                table.column("sku", .text)
                table.column("syncedPhotoOrder", .jsonText)
                table.column("retry", .jsonText).notNull()
            }
            try db.create(table: DraftPhotoRecord.databaseTableName) { table in
                table.primaryKey("id", .text)
                table.column("draftID", .text)
                    .notNull()
                    .indexed()
                    .references(DraftRecord.databaseTableName, onDelete: .cascade)
                table.column("position", .integer).notNull()
                table.column("role", .text).notNull()
                table.column("fileName", .text).notNull()
                table.column("width", .integer).notNull()
                table.column("height", .integer).notNull()
                table.column("byteSize", .integer).notNull()
                table.column("sha256", .text).notNull()
                table.column("looksBlurry", .boolean).notNull()
                table.column("tagReadState", .text).notNull()
                table.column("tagReads", .jsonText)
                table.column("createdAt", .datetime).notNull()
                table.column("step", .text).notNull()
                table.column("sessionKey", .text).notNull()
                table.column("sessionID", .text)
                table.column("uploadFileID", .text)
                table.column("target", .jsonText)
                table.column("attachKey", .text).notNull()
                table.column("attachRequest", .jsonText)
                table.column("serverPhotoID", .text)
                table.column("serverRole", .text)
                table.column("retry", .jsonText).notNull()
            }
            try db.create(table: ServerDeletionRecord.databaseTableName) { table in
                table.primaryKey("id", .text)
                table.column("kind", .text).notNull()
                table.column("createdAt", .datetime).notNull()
                table.column("serverItemID", .text)
                table.column("createItemKey", .text)
                table.column("serverPhotoID", .text)
                table.column("attachKey", .text)
                table.column("attachRequest", .jsonText)
                table.column("retry", .jsonText).notNull()
            }
        }
        return migrator
    }
}
