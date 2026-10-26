import XCTest

extension XCUIApplication {
    /// The app shows its tabs only while someone is signed in, so a test of the tabs that needs no
    /// server starts with a dev session (Dev builds only) against an address nobody answers at:
    /// every request fails as if offline, and no server can reject the token, which would sign the
    /// app out. An API on the xcconfig's port (another checkout's) is never reached.
    func signInWithoutServer() {
        launchEnvironment["LISTORA_DEV_ACCESS_TOKEN"] = "ui-test-token"
        launchEnvironment["LISTORA_DEV_API_BASE_URL"] = "http://127.0.0.1:9"
    }
}
