import BackgroundTasks
import Core
import Foundation
import OSLog
import UIKit
import UserNotifications

/// When the phone runs its marketplace work with the app closed (docs/features/phone-execution.md):
/// background app refresh, which iOS grants at its own pace, and an overnight processing run that
/// waits for power and a network, for larger batches (relists, price drops) while the phone
/// charges. Neither is promised: the app also runs the work whenever it opens, and a sale's
/// delists run when its notification is tapped. Both identifiers are in the app's Info.plist
/// (`BGTaskSchedulerPermittedIdentifiers`).
@MainActor
public enum PhoneBackgroundWork {
    public static let refreshIdentifier = "com.listora.phone-work.refresh"
    public static let processingIdentifier = "com.listora.phone-work.processing"
    private static let logger = Logger(subsystem: "com.listora.app", category: "phone-background")

    /// Registers the tasks' handlers; call before the app finishes launching.
    public static func register(_ runner: @escaping @MainActor () -> PhoneRunner?) {
        for (identifier, reason) in [
            (refreshIdentifier, PhoneWorkReason.backgroundRefresh),
            (processingIdentifier, PhoneWorkReason.processing),
        ] {
            BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
                MainActor.assumeIsolated {
                    let work = Task { @MainActor in
                        await runner()?.runUntilDone(reason)
                    }
                    task.expirationHandler = { work.cancel() }
                    Task { @MainActor in
                        await work.value
                        schedule()
                        task.setTaskCompleted(success: true)
                    }
                }
            }
        }
    }

    /// Asks iOS for the next refresh and the next overnight run; call when the app goes to the
    /// background and after each background run.
    public static func schedule() {
        let refresh = BGAppRefreshTaskRequest(identifier: refreshIdentifier)
        refresh.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        let processing = BGProcessingTaskRequest(identifier: processingIdentifier)
        processing.requiresExternalPower = true
        processing.requiresNetworkConnectivity = true
        processing.earliestBeginDate = Date(timeIntervalSinceNow: 60 * 60)
        for request in [refresh, processing] as [BGTaskRequest] {
            do {
                try BGTaskScheduler.shared.submit(request)
            } catch {
                // The simulator and a device with Background App Refresh off refuse; the app
                // still runs the work when it opens.
                logger.info("background task not scheduled: \(error.localizedDescription, privacy: .public)")
            }
        }
    }
}

/// The APNs environment this build's device tokens belong to: `sandbox` for a development
/// build (its provisioning profile says `aps-environment` `development`), `production`
/// otherwise (TestFlight and the App Store embed no profile).
public enum PushEnvironmentDetector {
    public static func current(bundle: Bundle = .main) -> String {
        guard let url = bundle.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1)
        else {
            return "production"
        }
        let compact = text.replacingOccurrences(of: "\\s", with: "", options: .regularExpression)
        return compact.contains("<key>aps-environment</key><string>development</string>") ? "sandbox" : "production"
    }

    /// An APNs token as the server keeps it: lowercase hex.
    public static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }
}

/// Tells the seller, while the app is in the background, that a marketplace stopped a run at a
/// check only they can complete; opening the app shows it.
public struct CheckNeededNotifier: Sendable {
    public init() {}

    public func notify(marketplace: String) async {
        guard Bundle.main.bundleURL.pathExtension == "app" else { return }
        let center = UNUserNotificationCenter.current()
        guard await center.notificationSettings().authorizationStatus == .authorized else { return }
        let content = UNMutableNotificationContent()
        let name = HandOffRequest.displayName(marketplace)
        content.title = "\(name) wants to check it's you"
        content.body = "Open Listora to finish it. Listora stopped there and never completes checks for you."
        content.sound = .default
        content.userInfo = ["phoneWork": "check", "marketplace": marketplace]
        // One a marketplace: a newer one replaces it.
        let request = UNNotificationRequest(identifier: "phone.check.\(marketplace)", content: content, trigger: nil)
        try? await center.add(request)
    }
}
