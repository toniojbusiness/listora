import APIClient
import DesignSystem
import Foundation
import Observation
import UIKit

/// One packing session at the table: one order, or a batch of them in turn. For each order the
/// seller scans the shipping label (and, for an exact match, the item's sticker); the server says
/// what the label is for, and only a match can be packed. A label already on a package, or
/// another order's, is a red stop. At the end, the orders still not packed are named so none is
/// forgotten. Nothing here changes anything on a marketplace.
@MainActor
@Observable
final class PackSessionModel {
    enum Stage: Equatable {
        /// Waiting for the label of the current order.
        case scanLabel
        case checking
        /// What the scanned label means for this package.
        case verdict(PackScan, label: String)
        case packing
        /// The current order is packed.
        case packed
        /// Every order of the session was looked at; the summary shows.
        case finished
    }

    private(set) var orders: [PackOrder]
    private(set) var index = 0
    private(set) var stage: Stage = .scanLabel
    /// The item sticker scanned for the current order, if any.
    private(set) var sticker: String?
    /// The last call's failure, safe to show; the seller can try again.
    private(set) var error: String?
    private(set) var isSavingPhoto = false
    private(set) var photoError: String?

    private let service: any PackCheckService
    /// Hands each changed order back to the to-ship list.
    private let onChange: @MainActor (PackOrder) -> Void
    /// One `Idempotency-Key` per pack attempt of an order and label, kept across retries.
    private var packKeys: [String: String] = [:]
    private var photoKeys: [String: PackPhotoKeys] = [:]

    init(
        orders: [PackOrder],
        service: any PackCheckService,
        onChange: @escaping @MainActor (PackOrder) -> Void = { _ in },
    ) {
        self.orders = orders
        self.service = service
        self.onChange = onChange
        index = orders.firstIndex { $0.pack == nil } ?? 0
        if orders.isEmpty { stage = .finished }
    }

    var current: PackOrder? {
        orders.indices.contains(index) ? orders[index] : nil
    }

    /// "Order 2 of 5", for a batch.
    var progress: String? {
        orders.count > 1 ? "Order \(index + 1) of \(orders.count)" : nil
    }

    /// The session's orders still not packed: the end of a session names them.
    var unpacked: [PackOrder] {
        orders.filter { $0.pack == nil }
    }

    /// The camera (or the typed number) read the label.
    func scannedLabel(_ code: String) async {
        let label = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let order = current, !label.isEmpty else { return }
        await check(label: label, saleID: order.saleId)
    }

    /// The camera read the item's sticker: with a label already scanned, the check runs again with
    /// both, which makes the match exact.
    func scannedSticker(_ code: String) async {
        sticker = code.trimmingCharacters(in: .whitespacesAndNewlines)
        if case let .verdict(_, label) = stage, let order = current {
            await check(label: label, saleID: order.saleId)
        }
    }

    private func check(label: String, saleID: String) async {
        stage = .checking
        error = nil
        do {
            let scan = try await service.check(label: label, sticker: sticker, saleID: saleID)
            stage = .verdict(scan, label: label)
            Self.feedback(for: scan)
        } catch {
            self.error = error.message
            stage = .scanLabel
        }
    }

    /// Packs the current order with the scanned label: after a match, or the seller's photo check
    /// of a label Listora doesn't know.
    func pack(photoCheck: Bool = false) async {
        guard case let .verdict(scan, label) = stage, let order = current else { return }
        guard scan.canPack || (photoCheck && scan.canPhotoCheck) else { return }
        stage = .packing
        error = nil
        let attempt = "\(order.saleId)|\(label)|\(sticker ?? "")|\(photoCheck)"
        let key = packKeys[attempt] ?? UUID().uuidString
        packKeys[attempt] = key
        do {
            let packed = try await service.pack(
                saleID: order.saleId,
                label: label,
                sticker: sticker,
                photoCheck: photoCheck,
                idempotencyKey: key,
            )
            update(packed)
            stage = .packed
            Haptics.play(.success)
        } catch {
            self.error = error.message
            // The server refused (another phone packed it, the label went on another package):
            // the check shows why.
            await check(label: label, saleID: order.saleId)
        }
    }

    /// Scans again, for another label (after a red stop, the right label goes on).
    func scanAgain() {
        stage = .scanLabel
        sticker = nil
        error = nil
    }

    /// Goes to the next order not packed yet, or ends the session.
    func next() {
        sticker = nil
        error = nil
        photoError = nil
        let later = orders.indices.dropFirst(index + 1).first { orders[$0].pack == nil }
        if let later {
            index = later
            stage = .scanLabel
        } else {
            stage = .finished
        }
    }

    /// Skips the current order for now; the summary names it.
    func skip() {
        next()
    }

    /// Ends the session; the summary names what is not packed.
    func finish() {
        stage = .finished
    }

    /// Takes the order off its package, to pack it again.
    func unpack() async {
        guard let order = current else { return }
        error = nil
        do {
            update(try await service.unpack(saleID: order.saleId))
            scanAgain()
        } catch {
            self.error = error.message
        }
    }

    /// Keeps a photo of the open package with its label, for a claim.
    func savePhoto(_ image: UIImage) async {
        guard let order = current, let jpeg = PackPhoto.jpeg(from: image) else {
            photoError = "This photo couldn't be read. Take it again."
            return
        }
        isSavingPhoto = true
        photoError = nil
        defer { isSavingPhoto = false }
        let keys = photoKeys[order.saleId] ?? PackPhotoKeys()
        photoKeys[order.saleId] = keys
        do {
            update(try await service.addPhoto(saleID: order.saleId, jpeg: jpeg, keys: keys))
            photoKeys[order.saleId] = nil
        } catch {
            photoError = error.message
        }
    }

    func removePhoto() async {
        guard let order = current else { return }
        photoError = nil
        do {
            update(try await service.removePhoto(saleID: order.saleId))
        } catch {
            photoError = error.message
        }
    }

    private func update(_ order: PackOrder) {
        if let at = orders.firstIndex(where: { $0.saleId == order.saleId }) {
            orders[at] = order
        }
        onChange(order)
    }

    private static func feedback(for scan: PackScan) {
        switch scan.tone.value1 {
        case .success: Haptics.play(.success)
        case .failed: Haptics.play(.failure)
        case .actionNeeded: Haptics.play(.warning)
        default: break
        }
    }
}
