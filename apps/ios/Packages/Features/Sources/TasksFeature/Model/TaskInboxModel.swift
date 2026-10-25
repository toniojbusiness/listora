import APIClient
import Foundation
import Observation

/// The Tasks tab: the steps that need the user, urgent ones (a delist after a sale) pinned at the
/// top. It is shared by the tab and its badge, reads the server whenever it is asked to, and keeps
/// the urgent tasks' reminders in step with what is still open.
@MainActor
@Observable
public final class TaskInboxModel {
    enum Phase: Equatable {
        case loading
        case loaded
        /// No session: nothing is asked of the server until the seller signs in.
        case signedOut
        /// The list could not be loaded; `message` is safe to show.
        case failed(message: String)
    }

    private(set) var phase: Phase = .loading
    /// Open tasks, urgent first, then oldest first (the server's order).
    private(set) var tasks: [UserTask] = []

    private let service: any TasksService
    private let reminders: any TaskReminding
    private let isSignedIn: @MainActor () -> Bool
    private let now: @Sendable () -> Date

    init(
        service: any TasksService,
        reminders: any TaskReminding,
        isSignedIn: @escaping @MainActor () -> Bool = { true },
        now: @escaping @Sendable () -> Date = { Date() },
    ) {
        self.service = service
        self.reminders = reminders
        self.isSignedIn = isSignedIn
        self.now = now
    }

    var urgent: [UserTask] {
        tasks.filter { $0.urgency == .urgent }
    }

    var others: [UserTask] {
        tasks.filter { $0.urgency != .urgent }
    }

    /// The Tasks tab's badge: every open task.
    public var openCount: Int {
        tasks.count
    }

    /// Reads the open tasks. Keeps the rows on screen while it loads, and when a refresh fails.
    public func load() async {
        guard isSignedIn() else {
            tasks = []
            phase = .signedOut
            await reminders.sync([])
            return
        }
        if tasks.isEmpty, phase != .loaded {
            phase = .loading
        }
        do {
            tasks = try await service.openTasks(itemID: nil)
            phase = .loaded
            await reminders.sync(ReminderSchedule.reminders(for: tasks, now: now()))
        } catch {
            if error.isUnauthenticated {
                tasks = []
                phase = .signedOut
            } else if tasks.isEmpty {
                phase = .failed(message: error.message)
            }
        }
    }

    /// Reads the server every `interval` while the app is open, so a task created meanwhile (a
    /// delist after a sale) shows up and badges the tab.
    public func follow(every interval: Duration = .seconds(30)) async {
        while !Task.isCancelled {
            await load()
            try? await Task.sleep(for: interval)
        }
    }

    /// Takes a finished task off the list at once; the next load confirms it with the server.
    func remove(taskID: String) {
        tasks.removeAll { $0.id == taskID }
    }
}
