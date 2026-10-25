import Foundation
@preconcurrency import UserNotifications

/// Receives the task reminders' notifications: shows them while the app is open, and opens the
/// Tasks tab when the user taps one (it posts ``openTasks``, which the tab shell observes).
public final class TaskNotificationRouter: NSObject, UNUserNotificationCenterDelegate, Sendable {
    /// Posted on the main queue when the user taps a task reminder.
    public static let openTasks = Notification.Name("ListoraOpenTasks")

    /// Becomes the notification center's delegate; keep it for the app's lifetime.
    public static func install() -> TaskNotificationRouter {
        let router = TaskNotificationRouter()
        UNUserNotificationCenter.current().delegate = router
        return router
    }

    public func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent _: UNNotification,
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    public func userNotificationCenter(_: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.notification.request.identifier.hasPrefix(UserNotificationReminders.prefix) else { return }
        await MainActor.run {
            NotificationCenter.default.post(name: Self.openTasks, object: nil)
        }
    }
}
