import APIClient
import Core
import PhoneExecutionFeature
import SignInFeature

extension AppDependencies {
    /// The marketplace work this phone runs (docs/features/phone-execution.md). Signing out
    /// removes the marketplace sessions it kept for the account.
    static func makePhone(
        _ apiClient: APIClient,
        _ accessTokens: AccessTokenStore,
        _ version: AppVersion,
        _ configuration: AppConfiguration,
        _ signIn: SignInModel,
    ) -> PhoneExecutionEnvironment {
        let phone = PhoneExecutionEnvironment(
            apiClient: apiClient,
            accessTokens: accessTokens,
            version: version,
            configuration: configuration,
        )
        signIn.onSignOut = { phone.signedOut() }
        return phone
    }
}
