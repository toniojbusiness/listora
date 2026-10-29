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
    private let runtime: WebPhoneRuntime

    /// `configuration` names the keychain group the sessions are kept in and Listora's photo
    /// hosts, the only ones a run fetches a listing's photos from.
    public convenience init(
        apiClient: APIClient,
        accessTokens: AccessTokenStore,
        version: AppVersion,
        configuration: AppConfiguration,
    ) {
        let sessions = KeychainMarketplaceSessionStore(accessGroup: configuration.phoneKeychainGroup)
        sessions.moveIntoAccessGroup()
        self.init(
            service: APIPhoneWorkService(api: apiClient),
            sessions: sessions,
            isSignedIn: { accessTokens.grant != nil },
            appVersion: version.marketing,
            photoHosts: [configuration.apiBaseURL] + (configuration.mediaBaseURL.map { [$0] } ?? []),
        )
        // The sessions belong to the account that linked them, by its sign-in identity: signing
        // in to another account on this phone removes them. An earlier build named the account by
        // its email, which still names it once; a session that names no identity keeps nothing.
        Task {
            for await grant in accessTokens.changes() {
                guard let grant else { continue }
                if let identity = grant.identity {
                    sessions.keep(onlyFor: identity, formerly: grant.email)
                } else {
                    sessions.removeAll()
                }
            }
        }
    }

    public init(
        service: any PhoneWorkService,
        sessions: any MarketplaceSessionStore,
        isSignedIn: @escaping @MainActor () -> Bool,
        appVersion: String,
        photoHosts: [URL] = [],
        installationID: @escaping @Sendable () -> String = Installation.id,
    ) {
        let handOff = ChallengeHandOffModel()
        self.handOff = handOff
        self.sessions = sessions
        let runtime = WebPhoneRuntime(sessions: sessions, handOff: handOff, photoHosts: photoHosts) { have in
            // The server's runtime when it can be reached; the app's own otherwise.
            try? await service.runtime(have: have)
        }
        self.runtime = runtime
        runner = PhoneRunner(
            service: service,
            runtime: runtime,
            installationID: installationID,
            isSignedIn: isSignedIn,
            isAppOpen: { UIApplication.shared.applicationState == .active },
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

    /// The seller signed out of Listora (`SignInModel.onSignOut`): the marketplace sessions this
    /// phone kept for them go, from the Keychain and from every web view. Which accounts this
    /// phone holds read only stays, for when they sign in again.
    public func signedOut() {
        sessions.removeAll()
        runtime.signedOut()
    }

    /// The device's APNs token arrived (`didRegisterForRemoteNotificationsWithDeviceToken`).
    public func pushTokenArrived(_ token: Data) {
        runner.pushTokenChanged(PushEnvironmentDetector.hex(token), environment: PushEnvironmentDetector.current())
    }
}
