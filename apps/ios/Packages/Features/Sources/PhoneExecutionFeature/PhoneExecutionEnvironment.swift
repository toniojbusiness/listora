import APIClient
import Core
import Foundation
import UIKit

/// On-phone execution (docs/features/phone-execution.md), built once at launch by
/// `AppDependencies`: the runner that takes the work Listora hands this phone, the hand-off of
/// a check to the seller, and the marketplace sessions this phone keeps.
@MainActor
public final class PhoneExecutionEnvironment {
    public let runner: PhoneRunner
    public let handOff: ChallengeHandOffModel
    public let sessions: any MarketplaceSessionStore

    public convenience init(apiClient: APIClient, accessTokens: AccessTokenStore, version: AppVersion) {
        let sessions = KeychainMarketplaceSessionStore()
        self.init(
            service: APIPhoneWorkService(api: apiClient),
            sessions: sessions,
            isSignedIn: { accessTokens.grant != nil },
            appVersion: version.marketing,
        )
        // The sessions belong to the account that linked them: signing in to another account
        // on this phone removes them.
        Task {
            for await grant in accessTokens.changes() {
                if let grant {
                    sessions.keep(onlyFor: grant.email)
                }
            }
        }
    }

    public init(
        service: any PhoneWorkService,
        sessions: any MarketplaceSessionStore,
        isSignedIn: @escaping @MainActor () -> Bool,
        appVersion: String,
        installationID: @escaping @Sendable () -> String = Installation.id,
    ) {
        let handOff = ChallengeHandOffModel()
        self.handOff = handOff
        self.sessions = sessions
        runner = PhoneRunner(
            service: service,
            runtime: WebPhoneRuntime(sessions: sessions, handOff: handOff) { have in
                // The server's runtime when it can be reached; the app's own otherwise.
                try? await service.runtime(have: have)
            },
            installationID: installationID,
            isSignedIn: isSignedIn,
            device: {
                DeviceRegistration(
                    name: UIDevice.current.name,
                    appVersion: appVersion,
                    runtimeVersion: 0,
                    pushToken: nil,
                    pushEnvironment: nil,
                )
            },
            keepAwake: { UIApplication.shared.isIdleTimerDisabled = $0 },
        )
    }

    /// The device's APNs token arrived (`didRegisterForRemoteNotificationsWithDeviceToken`).
    public func pushTokenArrived(_ token: Data) {
        runner.pushTokenChanged(PushEnvironmentDetector.hex(token), environment: PushEnvironmentDetector.current())
    }
}
