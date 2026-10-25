import Core
import Foundation
import GRDB

/// The seller's checks of a batch's grouping before the items are created: every change is one
/// transaction, and the stacks stay numbered from 0 without gaps.
extension DraftStore {
    // MARK: Grouping

    /// Groups the photos taken since the last grouping (``BatchGrouper``) into new stacks after the
    /// existing ones; the stacks the seller already has never change.
    func groupUngroupedShots(in batchID: String) throws {
        try writer.write { db in
            let shots = try BatchShotRecord
                .filter(BatchShotRecord.Columns.batchID == batchID)
                .filter(BatchShotRecord.Columns.stackID == nil)
                .order(BatchShotRecord.Columns.sequence)
                .fetchAll(db)
            guard !shots.isEmpty else { return }
            var position = try Self.stacks(of: batchID, in: db).count
            let byID = Dictionary(uniqueKeysWithValues: shots.map { ($0.id, $0) })
            for proposal in BatchGrouper.group(shots.map(\.grouperShot)) {
                let stack = BatchStackRecord(
                    id: UUID().uuidString.lowercased(),
                    batchID: batchID,
                    position: position,
                    startConfidence: proposal.startConfidence,
                )
                try stack.insert(db)
                position += 1
                for (index, id) in proposal.shotIDs.enumerated() {
                    guard var shot = byID[id] else { continue }
                    shot.stackID = stack.id
                    shot.stackPosition = index
                    shot.uncertain = proposal.uncertainShotIDs.contains(id)
                    try shot.update(db)
                }
            }
        }
    }

    /// Moves a photo to the end of another stack (the seller dragged it there).
    func moveShot(_ shotID: String, toStack stackID: String) throws {
        try writer.write { db in
            guard var shot = try BatchShotRecord.fetchOne(db, key: shotID),
                  try BatchStackRecord.exists(db, key: stackID), shot.stackID != stackID
            else { return }
            let from = shot.stackID
            shot.stackID = stackID
            shot.stackPosition = try Self.shots(ofStack: stackID, in: db).count
            shot.uncertain = false
            try shot.update(db)
            if let from {
                try Self.tidy(stack: from, in: db)
            }
        }
    }

    /// Starts a new item at `shotID`: it and the photos after it in its stack move to a new stack
    /// right after.
    func split(at shotID: String) throws {
        try writer.write { db in
            guard let shot = try BatchShotRecord.fetchOne(db, key: shotID), let stackID = shot.stackID,
                  let stack = try BatchStackRecord.fetchOne(db, key: stackID)
            else { return }
            let shots = try Self.shots(ofStack: stackID, in: db)
            guard let index = shots.firstIndex(where: { $0.id == shotID }), index > 0 else {
                // The first photo already starts its item.
                try Self.keepTogether(shotID, in: db)
                return
            }
            let new = try Self.insertStack(after: stack, in: db)
            for (offset, var moved) in shots[index...].enumerated() {
                moved.stackID = new.id
                moved.stackPosition = offset
                moved.uncertain = false
                try moved.update(db)
            }
        }
    }

    /// Moves one photo into a new item of its own, right after its stack.
    func moveShotToNewItem(_ shotID: String) throws {
        try writer.write { db in
            guard var shot = try BatchShotRecord.fetchOne(db, key: shotID), let stackID = shot.stackID,
                  let stack = try BatchStackRecord.fetchOne(db, key: stackID)
            else { return }
            let new = try Self.insertStack(after: stack, in: db)
            shot.stackID = new.id
            shot.stackPosition = 0
            shot.uncertain = false
            try shot.update(db)
            try Self.tidy(stack: stackID, in: db)
        }
    }

    /// Merges a stack into the one before it: they are one item.
    func mergeIntoPrevious(_ stackID: String) throws {
        try writer.write { db in
            guard let stack = try BatchStackRecord.fetchOne(db, key: stackID), stack.position > 0 else { return }
            let stacks = try Self.stacks(of: stack.batchID, in: db)
            guard let previous = stacks.last(where: { $0.position < stack.position }) else { return }
            var next = try Self.shots(ofStack: previous.id, in: db).count
            for var shot in try Self.shots(ofStack: stackID, in: db) {
                shot.stackID = previous.id
                shot.stackPosition = next
                shot.uncertain = false
                next += 1
                try shot.update(db)
            }
            try Self.tidy(stack: stackID, in: db)
        }
    }

    /// The seller checked a close-call boundary: the stack is an item of its own.
    func keepApart(_ stackID: String) throws {
        try writer.write { db in
            guard var stack = try BatchStackRecord.fetchOne(db, key: stackID) else { return }
            stack.startReviewed = true
            try stack.update(db)
        }
    }

    /// The seller checked a photo the grouper was unsure about: it belongs where it is.
    func keepTogether(_ shotID: String) throws {
        try writer.write { db in try Self.keepTogether(shotID, in: db) }
    }

    // MARK: Helpers

    static func stacks(of batchID: String, in db: Database) throws -> [BatchStackRecord] {
        try BatchStackRecord
            .filter(BatchStackRecord.Columns.batchID == batchID)
            .order(BatchStackRecord.Columns.position)
            .fetchAll(db)
    }

    static func shots(ofStack stackID: String, in db: Database) throws -> [BatchShotRecord] {
        try BatchShotRecord
            .filter(BatchShotRecord.Columns.stackID == stackID)
            .order(BatchShotRecord.Columns.stackPosition)
            .fetchAll(db)
    }

    /// A new, checked stack right after `stack`; the ones after it move down one place.
    static func insertStack(after stack: BatchStackRecord, in db: Database) throws -> BatchStackRecord {
        for var later in try stacks(of: stack.batchID, in: db).reversed() where later.position > stack.position {
            later.position += 1
            try later.update(db)
        }
        let new = BatchStackRecord(
            id: UUID().uuidString.lowercased(),
            batchID: stack.batchID,
            position: stack.position + 1,
            startConfidence: 1,
            startReviewed: true,
        )
        try new.insert(db)
        return new
    }

    /// Renumbers a stack's photos, or removes the stack once it has none and renumbers the others.
    static func tidy(stack stackID: String, in db: Database) throws {
        guard let stack = try BatchStackRecord.fetchOne(db, key: stackID) else { return }
        let shots = try shots(ofStack: stackID, in: db)
        if shots.isEmpty {
            try stack.delete(db)
            for (position, var other) in try stacks(of: stack.batchID, in: db).enumerated()
                where other.position != position
            {
                other.position = position
                try other.update(db)
            }
            return
        }
        for (position, var shot) in shots.enumerated() where shot.stackPosition != position {
            shot.stackPosition = position
            try shot.update(db)
        }
    }

    static func keepTogether(_ shotID: String, in db: Database) throws {
        guard var shot = try BatchShotRecord.fetchOne(db, key: shotID), shot.uncertain else { return }
        shot.uncertain = false
        try shot.update(db)
    }
}
