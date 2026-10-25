import Foundation
import UserNotifications

/// One local notification that reminds the user of an urgent task.
public struct TaskReminder: Equatable, Sendable {
    /// `task.<task id>.<n>`: one per reminder time of the task.
    public let id: String
    public let taskID: String
    public let title: String
    public let body: String
    public let fireAt: Date
}

/// The notification interface the task inbox reminds the user through. The app uses
/// ``UserNotificationReminders``; tests use a recording fake.
public protocol TaskReminding: Sendable {
    /// Makes the scheduled task reminders exactly `reminders`: adds the missing ones and removes
    /// those of tasks that are done or no longer urgent. Asks for permission the first time
    /// there is something to remind of; without permission nothing is scheduled.
    func sync(_ reminders: [TaskReminder]) async
}

/// When to remind of an urgent task: 10 and 30 minutes after it was created (when Listora also
/// alerts again, operations.md), then every hour, for the next few hours.
enum ReminderSchedule {
    static let offsets: [TimeInterval] = [10 * 60, 30 * 60, 60 * 60, 2 * 60 * 60, 3 * 60 * 60]

    /// The reminders of the open urgent tasks still to come after `now`.
    static func reminders(for tasks: [UserTask], now: Date) -> [TaskReminder] {
        tasks.filter { $0.status == .open && $0.urgency == .urgent }.flatMap { task in
            offsets.enumerated().compactMap { index, offset -> TaskReminder? in
                let fireAt = task.createdAt.addingTimeInterval(offset)
                guard fireAt > now else { return nil }
                return TaskReminder(
                    id: "task.\(task.id).\(index)",
                    taskID: task.id,
                    title: task.title,
                    body: "Still to do. An item sold, so finish this now.",
                    fireAt: fireAt,
                )
            }
        }
    }
}

/// ``TaskReminding`` with `UNUserNotificationCenter`: time-based local notifications.
public struct UserNotificationReminders: TaskReminding {
    static let prefix = "task."

    public init() {}

    /// Whether this process is an app, which alone has a notification center (a test bundle's
    /// host may not be).
    static var isAvailable: Bool {
        Bundle.main.bundleURL.pathExtension == "app"
    }

    public func sync(_ reminders: [TaskReminder]) async {
        guard Self.isAvailable else { return }
        let center = UNUserNotificationCenter.current()
        let pending = await center.pendingNotificationRequests().map(\.identifier)
            .filter { $0.hasPrefix(Self.prefix) }
        let wanted = Set(reminders.map(\.id))
        let stale = pending.filter { !wanted.contains($0) }
        if !stale.isEmpty {
            center.removePendingNotificationRequests(withIdentifiers: stale)
        }
        let missing = reminders.filter { !pending.contains($0.id) }
        guard !missing.isEmpty, await isAuthorized(center) else { return }
        for reminder in missing {
            let content = UNMutableNotificationContent()
            content.title = reminder.title
            content.body = reminder.body
            content.sound = .default
            content.userInfo = ["taskID": reminder.taskID]
            let trigger = UNTimeIntervalNotificationTrigger(
                timeInterval: max(1, reminder.fireAt.timeIntervalSinceNow),
                repeats: false,
            )
            try? await center.add(UNNotificationRequest(identifier: reminder.id, content: content, trigger: trigger))
        }
    }

    private func isAuthorized(_ center: UNUserNotificationCenter) async -> Bool {
        switch await center.notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return true
        case .notDetermined:
            return await (try? center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        case .denied:
            return false
        @unknown default:
            return false
        }
    }
}
