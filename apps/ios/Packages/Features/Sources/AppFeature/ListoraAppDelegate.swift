import PhoneExecutionFeature
import UIKit

/// The app delegate, for what only UIKit tells: the device's APNs token, and a push that wakes
/// the app in the background, after which the marketplace work waiting for this phone runs
/// (docs/features/phone-execution.md). iOS may not wake the app for a push; tapping the
/// notification opens it, which runs the work too.
public final class ListoraAppDelegate: NSObject, UIApplicationDelegate {
    /// Set by `AppDependencies.startBackgroundWork()`.
    @MainActor static var phone: PhoneExecutionEnvironment?

    public func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions _: [UIApplication.LaunchOptionsKey: Any]? = nil,
    ) -> Bool {
        // No prompt: the token arrives whether or not the seller allowed alerts, and a build
        // signed without push (a personal team) simply gets none.
        application.registerForRemoteNotifications()
        return true
    }

    public func application(_: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        Task { @MainActor in Self.phone?.pushTokenArrived(token) }
    }

    public func application(_: UIApplication, didFailToRegisterForRemoteNotificationsWithError _: any Error) {}

    public func application(
        _: UIApplication,
        didReceiveRemoteNotification _: [AnyHashable: Any],
    ) async -> UIBackgroundFetchResult {
        guard let runner = await MainActor.run(body: { Self.phone?.runner }) else { return .noData }
        await runner.runUntilDone(.push)
        return .newData
    }
}
