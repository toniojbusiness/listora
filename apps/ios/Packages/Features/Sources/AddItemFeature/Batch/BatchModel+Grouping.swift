import Core
import Foundation

/// The grouping the seller checks before the items are created: every change goes to the store,
/// whose observation updates the screen.
extension BatchModel {
    /// Groups photos taken since the last grouping (a relaunch mid-capture leaves some), after
    /// reading any signals still missing.
    func groupNewPhotos(reader: any PhotoSignalReader) async {
        do {
            for shot in try store.shotsWaitingForSignals(in: batchID) {
                var signals: ShotSignals?
                if let data = try? Data(contentsOf: store.fileURL(for: shot)) {
                    signals = try? await reader.signals(of: data)
                }
                try store.recordSignals(signals, of: shot.id)
            }
            try store.groupUngroupedShots(in: batchID)
        } catch {
            errorMessage = "Listora couldn't group these photos. Try again."
        }
    }

    func move(_ shotID: String, toStack stackID: String) {
        change { try $0.moveShot(shotID, toStack: stackID) }
    }

    func moveToNewItem(_ shotID: String) {
        change { try $0.moveShotToNewItem(shotID) }
    }

    func split(at shotID: String) {
        change { try $0.split(at: shotID) }
    }

    func mergeIntoPrevious(_ stackID: String) {
        change { try $0.mergeIntoPrevious(stackID) }
    }

    func keepApart(_ stackID: String) {
        change { try $0.keepApart(stackID) }
    }

    func keepTogether(_ shotID: String) {
        change { try $0.keepTogether(shotID) }
    }

    func remove(_ shotID: String) {
        change { try $0.deleteShot(shotID) }
    }

    /// Creates one draft per stack; they upload, and the server analyzes each item, while the
    /// seller keeps going. Returns whether the items were created.
    func confirm() async -> Bool {
        let store = store
        let batchID = batchID
        let result = await Task.detached(priority: .userInitiated) {
            Result { try store.confirmStacks(in: batchID) }
        }.value
        switch result {
        case let .success(drafts):
            // Each item's review is measured on its own, from its draft.
            for draft in drafts {
                meter.begin(draft.id)
            }
            let uploader = uploader
            Task { await uploader.wake() }
            return true
        case .failure(DraftStoreError.tooManyPhotos):
            errorMessage = "An item can have at most \(DraftStore.maxPhotosPerDraft) photos. Split the item first."
            return false
        case .failure:
            errorMessage = "Listora couldn't create the items on this iPhone. Free up some storage and try again."
            return false
        }
    }

    private func change(_ body: (DraftStore) throws -> Void) {
        do {
            try body(store)
        } catch {
            errorMessage = "Listora couldn't save that change on this iPhone. Try again."
        }
    }
}
