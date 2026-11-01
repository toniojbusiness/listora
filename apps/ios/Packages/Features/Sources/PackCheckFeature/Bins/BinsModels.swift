import APIClient
import Core
import DesignSystem
import Foundation
import Observation

/// Settings > Storage bins (docs/features/storage-bins.md): every bin, and making one with the
/// next code offered.
@MainActor
@Observable
final class BinsModel {
    enum Phase: Equatable {
        case loading
        case failed(String)
        case loaded
    }

    private(set) var phase: Phase = .loading
    private(set) var bins: [Bin] = []
    private(set) var nextCode = "B-1"
    private let service: any BinsService

    init(service: any BinsService) {
        self.service = service
    }

    func load() async {
        do {
            let list = try await service.bins()
            bins = list.bins
            nextCode = list.nextCode
            phase = .loaded
        } catch {
            if phase != .loaded {
                phase = .failed(error.message)
            }
        }
    }

    /// The form for a new bin, with the next code filled in.
    func makeForm() -> BinFormModel {
        BinFormModel(service: service, editing: nil, suggestedCode: nextCode) { [weak self] _ in
            Task { await self?.load() }
        }
    }
}

/// Making a bin, or renaming one: its code and where it is. Nothing is saved until Listora
/// answered; a taken code or a failure says why, and trying again sends the same bin.
@MainActor
@Observable
final class BinFormModel: Identifiable {
    let id = UUID().uuidString
    let editing: Bin?
    var code: String
    var label: String
    private(set) var isSaving = false
    private(set) var failure: String?
    private let service: any BinsService
    private let onSaved: @MainActor (Bin) -> Void
    /// One bin per form: a retry after a lost answer replays the one that was made.
    private let idempotencyKey = UUID().uuidString.lowercased()

    init(
        service: any BinsService,
        editing: Bin?,
        suggestedCode: String,
        onSaved: @escaping @MainActor (Bin) -> Void,
    ) {
        self.service = service
        self.editing = editing
        self.onSaved = onSaved
        code = editing?.code ?? suggestedCode
        label = editing?.label ?? ""
    }

    var canSave: Bool {
        !isSaving && !BinCode.normalized(code).isEmpty
    }

    /// Saves the bin; true once Listora has it.
    @discardableResult
    func save() async -> Bool {
        guard canSave else { return false }
        isSaving = true
        failure = nil
        defer { isSaving = false }
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = trimmed.isEmpty ? nil : trimmed
        do {
            let bin = if let editing {
                try await service.rename(id: editing.id, code: code, label: label)
            } else {
                try await service.create(code: code, label: label, idempotencyKey: idempotencyKey)
            }
            Haptics.play(.success)
            onSaved(bin)
            return true
        } catch {
            failure = error.message
            Haptics.play(.failure)
            return false
        }
    }
}

/// One bin: what is in it, its sticker, renaming it, deleting it, and taking an item out.
@MainActor
@Observable
final class BinDetailModel {
    enum Phase: Equatable {
        case loading
        case failed(String)
        case loaded
        /// Deleted here, or gone since the list was read.
        case gone
    }

    private(set) var phase: Phase = .loading
    private(set) var detail: BinDetail?
    private(set) var isWorking = false
    var failure: String?
    let binID: String
    private let service: any BinsService
    private let onChange: @MainActor () -> Void

    init(binID: String, service: any BinsService, onChange: @escaping @MainActor () -> Void = {}) {
        self.binID = binID
        self.service = service
        self.onChange = onChange
    }

    func load() async {
        do {
            detail = try await service.bin(id: binID)
            phase = .loaded
        } catch where error.statusCode == 404 {
            phase = .gone
        } catch {
            if detail == nil {
                phase = .failed(error.message)
            } else {
                failure = error.message
            }
        }
    }

    func makeRenameForm() -> BinFormModel? {
        guard let bin = detail?.location else { return nil }
        return BinFormModel(service: service, editing: bin, suggestedCode: bin.code) { [weak self] _ in
            Task {
                await self?.load()
                self?.onChange()
            }
        }
    }

    func delete() async {
        await perform { () async throws(APIFailure) in
            try await service.delete(id: binID)
            phase = .gone
        }
    }

    func takeOut(itemID: String) async {
        await perform { () async throws(APIFailure) in
            detail = try await service.takeOut(itemID: itemID, ofBin: binID)
        }
    }

    private func perform(_ work: () async throws(APIFailure) -> Void) async {
        guard !isWorking else { return }
        isWorking = true
        failure = nil
        defer { isWorking = false }
        do {
            try await work()
            onChange()
        } catch {
            failure = error.message
            Haptics.play(.failure)
        }
    }
}

/// Putting items in a bin (docs/features/storage-bins.md): scan the bin's sticker, or pick it
/// from the list, or make a new one; or take the item out of its bin. The choice shows only once
/// Listora has it; a failure says why and can be tried again.
@MainActor
@Observable
final class BinPickerModel {
    enum Phase: Equatable {
        case loading
        case failed(String)
        case loaded
    }

    let request: BinRequest
    private(set) var phase: Phase = .loading
    private(set) var bins: [Bin] = []
    private(set) var nextCode = "B-1"
    private(set) var isWorking = false
    private(set) var failure: String?
    /// A scanned code no bin has yet, which the seller can make into one.
    private(set) var unknownCode: String?
    private let service: any BinsService
    private let onDone: @MainActor (BinChoice?) -> Void
    /// The same put is retried with the same key, so a lost answer never moves items twice.
    private var putKey = UUID().uuidString.lowercased()
    private var putTarget: String?

    init(request: BinRequest, service: any BinsService, onDone: @escaping @MainActor (BinChoice?) -> Void) {
        self.request = request
        self.service = service
        self.onDone = onDone
    }

    func load() async {
        do {
            let list = try await service.bins()
            bins = list.bins
            nextCode = list.nextCode
            phase = .loaded
        } catch {
            if phase != .loaded {
                phase = .failed(error.message)
            }
        }
    }

    /// A scan read on the bin's sticker (or typed): puts the items in that bin, or offers to
    /// make it when there is none.
    func scanned(_ text: String) async {
        unknownCode = nil
        failure = nil
        guard let code = BinCode.scanned(text) else {
            failure = "That isn't a bin sticker. Scan the QR code on the bin."
            Haptics.play(.failure)
            return
        }
        if phase != .loaded {
            await load()
        }
        if let bin = bins.first(where: { BinCode.normalized($0.code) == code }) {
            await put(in: bin)
        } else {
            unknownCode = code
        }
    }

    /// Puts the items in this bin.
    func put(in bin: Bin) async {
        guard !isWorking else { return }
        if request.current?.id == bin.id {
            onDone(request.current)
            return
        }
        isWorking = true
        failure = nil
        defer { isWorking = false }
        if putTarget != bin.id {
            putTarget = bin.id
            putKey = UUID().uuidString.lowercased()
        }
        do {
            _ = try await service.put(itemIDs: request.itemIDs, inBin: bin.id, idempotencyKey: putKey)
            Haptics.play(.success)
            onDone(BinChoice(id: bin.id, code: bin.code))
        } catch {
            failure = error.message
            Haptics.play(.failure)
        }
    }

    /// The form for a new bin, with the scanned code or the next one filled in; once made, the
    /// items go in it.
    func makeForm() -> BinFormModel {
        BinFormModel(service: service, editing: nil, suggestedCode: unknownCode ?? nextCode) { [weak self] bin in
            Task {
                self?.unknownCode = nil
                await self?.put(in: bin)
                await self?.load()
            }
        }
    }

    /// Takes the item out of the bin it is in.
    func takeOut() async {
        guard let current = request.current, !isWorking else { return }
        isWorking = true
        failure = nil
        defer { isWorking = false }
        do {
            for itemID in request.itemIDs {
                _ = try await service.takeOut(itemID: itemID, ofBin: current.id)
            }
            onDone(nil)
        } catch {
            failure = error.message
            Haptics.play(.failure)
        }
    }

    /// "Put in a bin", or for several, "Put 4 items in a bin".
    var title: String {
        request.itemIDs.count == 1 ? "Put in a bin" : "Put \(request.itemIDs.count) items in a bin"
    }
}
