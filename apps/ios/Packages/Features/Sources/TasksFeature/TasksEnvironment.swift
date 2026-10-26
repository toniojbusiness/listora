import APIClient
import Foundation
import SwiftUI

/// Everything the task inbox needs, built once at launch by `AppDependencies`. Its ``inbox`` is
/// shared by the Tasks tab and the tab's badge.
@MainActor
public final class TasksEnvironment {
    public let inbox: TaskInboxModel
    let service: any TasksService
    let pasteboard: any Pasteboard
    let photoSaver: any PhotoSaving
    /// Opens the sign-in, for a signed-out screen's Sign in button.
    let onSignIn: @MainActor () -> Void

    public convenience init(
        apiClient: APIClient,
        accessTokens: AccessTokenStore,
        onSignIn: @escaping @MainActor () -> Void = {},
    ) {
        self.init(
            service: APITasksService(client: apiClient.client),
            reminders: UserNotificationReminders(),
            pasteboard: SystemPasteboard(),
            photoSaver: PhotoLibrarySaver(),
            isSignedIn: { accessTokens.grant != nil },
            onSignIn: onSignIn,
        )
    }

    init(
        service: any TasksService,
        reminders: any TaskReminding,
        pasteboard: any Pasteboard,
        photoSaver: any PhotoSaving,
        isSignedIn: @escaping @MainActor () -> Bool = { true },
        onSignIn: @escaping @MainActor () -> Void = {},
    ) {
        self.service = service
        self.pasteboard = pasteboard
        self.photoSaver = photoSaver
        self.onSignIn = onSignIn
        inbox = TaskInboxModel(service: service, reminders: reminders, isSignedIn: isSignedIn)
    }

    private var notificationRouter: TaskNotificationRouter?

    /// Shows task reminders while the app is open and opens the Tasks tab when one is tapped;
    /// `onOther` runs for any other notification as it shows or is tapped (a sale's push). Only
    /// an app has a notification center, so test hosts and previews skip it.
    public func startNotifications(onOther: @escaping @Sendable () async -> Void = {}) {
        guard notificationRouter == nil, UserNotificationReminders.isAvailable else { return }
        notificationRouter = TaskNotificationRouter.install(onOther: onOther)
    }

    func makeDetailModel(task: UserTask) -> TaskDetailModel {
        TaskDetailModel(task: task, service: service, pasteboard: pasteboard, photoSaver: photoSaver)
    }

    /// The task an operation waits on, as a sheet's content: the item screen opens it from the
    /// listing's "Open task". `onFinished` runs once the task is done or dismissed.
    public func taskScreen(itemID: String, operationID: String, onFinished: @escaping @MainActor () -> Void)
        -> AnyView
    {
        AnyView(OperationTaskView(environment: self, itemID: itemID, operationID: operationID, onFinished: onFinished))
    }
}
