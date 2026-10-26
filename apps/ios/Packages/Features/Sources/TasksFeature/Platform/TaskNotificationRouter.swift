import Foundation
@preconcurrency import UserNotifications

/// Receives the task reminders' notifications: shows them while the app is open, and opens the
/// Tasks tab when the user taps one (it posts ``openTasks``, which the tab shell observes).
public final class TaskNotificationRouter: NSObject, UNUserNotificationCenterDelegate, Sendable {
    /// Posted on the main queue when the user taps a task reminder.
    public static let openTasks = Notification.Name("ListoraOpenTasks")

    /// Every other notification shown or tapped (a push about a sale), for the app.
    private let onOther: @Sendable () async -> Void

    init(onOther: @escaping @Sendable () async -> Void) {
        self.onOther = onOther
    }

    /// Becomes the notification center's delegate; keep it for the app's lifetime. `onOther`
    /// runs for every notification that is not a task reminder, as it shows or is tapped.
    public static func install(onOther: @escaping @Sendable () async -> Void = {}) -> TaskNotificationRouter {
        let router = TaskNotificationRouter(onOther: onOther)
        UNUserNotificationCenter.current().delegate = router
        return router
    }

    public func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent notification: UNNotification,
    ) async -> UNNotificationPresentationOptions {
        if !notification.request.identifier.hasPrefix(UserNotificationReminders.prefix) {
            // The banner shows at once; what the notification asks for runs meanwhile.
            let onOther = onOther
            Task { await onOther() }
        }
        return [.banner, .list, .sound]
    }

    public func userNotificationCenter(_: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.notification.request.identifier.hasPrefix(UserNotificationReminders.prefix) else {
            await onOther()
            return
        }
        await MainActor.run {
            NotificationCenter.default.post(name: Self.openTasks, object: nil)
        }
    }
}
