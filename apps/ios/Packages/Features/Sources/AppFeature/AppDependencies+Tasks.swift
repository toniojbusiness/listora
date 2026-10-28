import APIClient
import PhoneExecutionFeature
import TasksFeature

/// The Tasks tab's place in the app.
extension AppDependencies {
    /// Tasks, whose offers' answers run at once on this phone (docs/features/offers.md).
    static func makeTasks(
        _ apiClient: APIClient,
        _ accessTokens: AccessTokenStore,
        _ showSignIn: @escaping @MainActor () -> Void,
        _ phone: PhoneExecutionEnvironment,
    ) -> TasksEnvironment {
        TasksEnvironment(
            apiClient: apiClient, accessTokens: accessTokens, onSignIn: showSignIn,
            runPhoneWork: { [weak runner = phone.runner] in runner?.runPhoneWork(.userAction) },
        )
    }
}
