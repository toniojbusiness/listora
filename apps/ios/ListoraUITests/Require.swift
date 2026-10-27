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

extension XCUIElement {
    /// Types `text` into this empty field and checks that the field holds it, typing it again
    /// when it doesn't. CI's simulator keyboard sometimes takes only the first keys of a
    /// `typeText` (a task's link field once held "ht" of a whole URL, so its Done stayed off).
    func typeChecked(_ text: String, attempts: Int = 3) -> Bool {
        for _ in 0 ..< attempts {
            tap()
            let typed = (value as? String) ?? ""
            let placeholder = placeholderValue ?? ""
            if typed != text {
                let length = typed == placeholder ? 0 : typed.count
                typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: length) + text)
            }
            if (value as? String) == text {
                return true
            }
        }
        return false
    }
}
