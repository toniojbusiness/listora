import APIClient
import Core
import Foundation
import Observation
import os

/// The sourcing kit on this iPhone (docs/features/thrift-scan.md, "Offline at the bins"): read
/// from Listora while there is signal, kept in a file, and read by the scan's instant call with
/// or without signal, and by "What sells for you". A kit of a format this app does not read is
/// never used.
@MainActor
@Observable
final class SourcingKitCache {
    /// The kit is fetched again at most this often.
    static let refreshInterval: TimeInterval = 15 * 60

    private(set) var kit: SourcingKit?
    private let file: URL?
    private let now: () -> Date
    @ObservationIgnored private var fetchedAt: Date?
    @ObservationIgnored private var fetching: Task<Void, Never>?
    private let log = Logger(subsystem: "com.listora.app", category: "scan")

    /// `file` nil keeps the kit in memory only (tests, previews).
    init(file: URL?, now: @escaping () -> Date = Date.init) {
        self.file = file
        self.now = now
        if let file, let data = try? Data(contentsOf: file) {
            kit = Self.usable(try? JSONDecoder().decode(SourcingKit.self, from: data))
        }
    }

    /// Fetches the kit when it was not fetched lately; a failure keeps the one there is.
    func refresh(from service: any ScanService) async {
        if let fetchedAt, now().timeIntervalSince(fetchedAt) < Self.refreshInterval {
            return
        }
        if let fetching {
            await fetching.value
            return
        }
        let task = Task { [weak self] in
            do {
                let kit = try await service.sourcingKit()
                self?.store(kit)
            } catch {
                let message = (error as? APIFailure)?.message ?? String(describing: error)
                self?.log.error("Fetching the sourcing kit failed: \(message, privacy: .public)")
            }
        }
        fetching = task
        await task.value
        fetching = nil
    }

    private func store(_ fetched: SourcingKit) {
        fetchedAt = now()
        guard let usable = Self.usable(fetched) else {
            log.error("The sourcing kit's format \(fetched.version, privacy: .public) is not one this app reads")
            return
        }
        kit = usable
        guard let file else { return }
        do {
            try FileManager.default.createDirectory(
                at: file.deletingLastPathComponent(),
                withIntermediateDirectories: true,
            )
            try JSONEncoder().encode(usable).write(
                to: file,
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication],
            )
        } catch {
            log.error("Saving the sourcing kit failed: \(String(describing: error), privacy: .public)")
        }
    }

    private static func usable(_ kit: SourcingKit?) -> SourcingKit? {
        kit.flatMap { $0.version == SourcingKit.supportedVersion ? $0 : nil }
    }
}
