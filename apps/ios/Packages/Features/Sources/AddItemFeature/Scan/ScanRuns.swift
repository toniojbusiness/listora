import Core
import Foundation
import Observation
import os

/// The app's scan runs (docs/features/thrift-scan.md): the one going on, and those the seller
/// ended while kept scans still waited for signal. Built once at launch with the Add Item tab's
/// environment, it brings back the runs kept on this iPhone and reads their waiting scans, and
/// refreshes the sourcing kit, whenever there is signal, whichever tab is open.
@MainActor
@Observable
final class ScanRuns {
    /// While scans wait and the path says online, the queue tries again this often: a path can
    /// be up while the store's signal still drops requests.
    static let retryInterval: Duration = .seconds(30)

    private(set) var current: ScanRunModel?
    private(set) var finishing: [ScanRunModel] = []
    let kit: SourcingKitCache

    private let dependencies: ScanRunDependencies
    private let directory: URL
    private var watching: Task<Void, Never>?
    private let log = Logger(subsystem: "com.listora.app", category: "scan")

    init(dependencies: ScanRunDependencies, directory: URL, kit: SourcingKitCache) {
        var dependencies = dependencies
        dependencies.kit = { [kit] in kit.kit }
        self.dependencies = dependencies
        self.directory = directory
        self.kit = kit
        restore()
    }

    /// The run going on, or a new one, comparing on `marketplaces` through `comparisons` from now
    /// on (where `market_comps` is on).
    func startOrResume(
        place: String? = nil,
        comparisons: (any MarketComparisons)? = nil,
        comparing marketplaces: [String] = [],
    ) -> ScanRunModel {
        if let current, !current.isEnded {
            current.compare(with: comparisons, on: marketplaces)
            return current
        }
        let run = ScanRunModel(dependencies: dependencies, directory: directory, place: place)
        run.compare(with: comparisons, on: marketplaces)
        current = run
        Task { await refresh() }
        return run
    }

    /// Ends the run: it finishes now, or once its kept scans waiting for signal are saved.
    func end(_ run: ScanRunModel) async {
        if current === run {
            current = nil
        }
        await run.end()
        if !run.isFinished {
            follow(run)
        }
    }

    /// The run was checked out: it is over at once, whatever its files still need.
    func closed(_ run: ScanRunModel) {
        if current === run {
            current = nil
        }
    }

    /// Refreshes the sourcing kit when there is signal, for "What sells for you" before a run
    /// starts: the seller asked for it, so they are signed in.
    func refreshKit() async {
        guard dependencies.connectivity?.isOnline != false else { return }
        await kit.refresh(from: dependencies.service)
    }

    /// Reads every waiting scan of every run, and refreshes the kit for the run going on, when
    /// there is signal. With no run it asks Listora nothing: the seller may not be signed in, or
    /// scan at all.
    func refresh() async {
        let runs = [current].compactMap(\.self) + finishing
        guard !runs.isEmpty, dependencies.connectivity?.isOnline != false else { return }
        if current != nil {
            await kit.refresh(from: dependencies.service)
        }
        for run in runs {
            await run.drain()
        }
    }

    /// Watches the network: every time it comes back, and every ``retryInterval`` while scans
    /// wait, the queue reads them. Safe to call repeatedly.
    func start() {
        guard watching == nil else { return }
        watching = Task { [weak self] in
            guard let changes = self?.dependencies.connectivity?.changes() else {
                await self?.refresh()
                return
            }
            await withTaskGroup(of: Void.self) { group in
                group.addTask { [weak self] in
                    for await online in changes where online {
                        await self?.refresh()
                    }
                }
                group.addTask { [weak self] in
                    while !Task.isCancelled {
                        try? await Task.sleep(for: Self.retryInterval)
                        guard let self else { return }
                        if await hasWaiting {
                            await refresh()
                        }
                    }
                }
            }
        }
    }

    private var hasWaiting: Bool {
        ([current].compactMap(\.self) + finishing).contains { $0.waitingCount > 0 }
    }

    private func follow(_ run: ScanRunModel) {
        finishing.append(run)
        run.onFinished = { [weak self] finished in
            self?.finishing.removeAll { $0 === finished }
        }
    }

    /// The runs kept on this iPhone: the one not ended goes on, the ended ones finish; a folder no
    /// kept run names is left over from a run that finished, and goes.
    private func restore() {
        let kept: [(run: ScanRunRecord, entries: [ScanEntryRecord])]
        do {
            kept = try dependencies.queue?.runs() ?? []
        } catch {
            log.error("Reading the kept scan runs failed: \(String(describing: error), privacy: .public)")
            kept = []
        }
        for (record, entries) in kept {
            let run = ScanRunModel(
                dependencies: dependencies,
                directory: directory,
                restoring: record,
                entries: entries,
            )
            if run.isEnded {
                follow(run)
            } else if let older = current {
                // Only one run goes on at a time; an older one left open ends.
                current = run
                Task { await end(older) }
            } else {
                current = run
            }
        }
        let names = Set(kept.map(\.run.id))
        let folders = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ??
            []
        for folder in folders where !names.contains(folder.lastPathComponent) {
            try? FileManager.default.removeItem(at: folder)
        }
    }
}
