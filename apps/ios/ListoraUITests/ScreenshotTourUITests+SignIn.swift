import XCTest

/// The signed-out screens: welcome, the code, and a wrong code, against the stub's dev sign-in.
extension ScreenshotTourUITests {
    /// A fresh install: the welcome screen, the code screen, and a wrong code.
    func signInTour(server: StubAPIServer) throws {
        app.launchEnvironment = [
            "LISTORA_RESET_LOCAL_DATA": "1",
            "LISTORA_DEV_API_BASE_URL": server.baseURL,
        ]
        app.launchQuietly()
        let email = app.textFields["signIn.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        try shot("00a-sign-in-welcome")
        // At the largest text sizes the email is below the fold.
        if !email.isHittable {
            app.swipeUp()
        }
        email.tap()
        email.typeText("seller@listora.test")
        app.buttons["signIn.continue"].tap()
        let code = app.textFields["signIn.code"]
        XCTAssertTrue(code.waitForExistence(timeout: 10))
        try shot("00b-sign-in-code")
        code.typeText("000000")
        app.buttons["signIn.signIn"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["signIn.message"].waitForExistence(timeout: 10))
        try shot("00c-sign-in-wrong-code")
        app.terminate()
    }
}
