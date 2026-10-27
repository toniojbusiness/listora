import APIClient
import Foundation
import Observation

/// The to-ship list: one card per order that still needs a package. Opening it asks for the
/// labels Listora doesn't have yet, which this phone reads from the marketplaces' order pages
/// (only reads), then lists the orders again as the reads come in.
@MainActor
@Observable
final class PackOrdersModel {
    enum Phase: Equatable {
        case loading
        case loaded
        case signedOut
        case failed(message: String)
    }

    private(set) var phase: Phase = .loading
    private(set) var orders: [PackOrder] = []
    /// How many orders' labels this phone is reading now.
    private(set) var readingLabels = 0

    private let service: any PackCheckService
    private let isSignedIn: @MainActor () -> Bool
    /// Runs the marketplace work Listora handed this phone (the label reads).
    private let runPhoneWork: @MainActor () -> Void
    /// Waits between looks while labels are read; tests skip it.
    private let pause: @Sendable (Duration) async -> Void
    /// The looks after asking for label reads, as the phone's reads take seconds each.
    static let readLooks: [Duration] = [.seconds(4), .seconds(8), .seconds(15)]

    init(
        service: any PackCheckService,
        isSignedIn: @escaping @MainActor () -> Bool = { true },
        runPhoneWork: @escaping @MainActor () -> Void = {},
        pause: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) },
    ) {
        self.service = service
        self.isSignedIn = isSignedIn
        self.runPhoneWork = runPhoneWork
        self.pause = pause
    }

    /// The orders not packed yet.
    var unpacked: [PackOrder] {
        orders.filter { $0.pack == nil }
    }

    var packed: [PackOrder] {
        orders.filter { $0.pack != nil }
    }

    func load() async {
        guard isSignedIn() else {
            phase = .signedOut
            return
        }
        if orders.isEmpty { phase = .loading }
        do {
            orders = try await service.orders()
            phase = .loaded
        } catch {
            phase = error.isUnauthenticated ? .signedOut : .failed(message: error.message)
        }
    }

    /// Lists the orders, asks for the labels that are missing, and lists them again as they come.
    func refresh() async {
        await load()
        guard phase == .loaded else { return }
        let reading = (try? await service.refreshLabels()) ?? 0
        guard reading > 0 else { return }
        readingLabels = reading
        runPhoneWork()
        for wait in Self.readLooks {
            await pause(wait)
            await load()
        }
        readingLabels = 0
    }

    /// Puts a changed order (packed, unpacked, with its photo) in its place.
    func replace(_ order: PackOrder) {
        if let index = orders.firstIndex(where: { $0.saleId == order.saleId }) {
            orders[index] = order
        }
    }
}
