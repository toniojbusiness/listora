import XCTest

/// A check that failed and ended the test.
struct RequirementFailed: Error, CustomStringConvertible {
    let description: String
}

extension XCTestCase {
    /// Fails the test and ends it when `condition` is false. `continueAfterFailure = false` does
    /// not stop an `async` test: after a failed assertion it runs on, and every later wait then
    /// runs out its timeout. On CI that turned one failed step into a test that hit its 5-minute
    /// allowance, hiding the step that broke. `async` UI tests check their steps with
    /// `try require(...)` instead.
    func require(
        _ condition: Bool,
        _ message: @autoclosure () -> String = "",
        file: StaticString = #filePath,
        line: UInt = #line,
    ) throws {
        guard condition else {
            let message = message()
            XCTFail(message, file: file, line: line)
            throw RequirementFailed(description: message.isEmpty ? "a required check failed" : message)
        }
    }
}
