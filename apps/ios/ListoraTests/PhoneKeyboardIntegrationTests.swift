import Foundation
import Testing
import UIKit
import WebKit
@testable import PhoneExecutionFeature

/// Runs inside the app, with its window: the hidden web views Listora works in on the seller's
/// marketplaces never bring up the keyboard, even when their page focuses a field, because they
/// live in a window that can never become the key window, which the keyboard follows.
@MainActor
struct PhoneKeyboardIntegrationTests {
    @Test
    func `a marketplace page focusing a field in the background never takes the key window`() async throws {
        let keyBefore = Self.keyWindow()
        let webView = WKWebView(frame: .zero)
        WebViewShelf.shared.keep(webView)
        let shelf = try #require(webView.window)
        #expect(!shelf.canBecomeKey)
        #expect(shelf !== keyBefore)

        webView.loadHTMLString("<!doctype html><input id=\"title\" type=\"text\">", baseURL: nil)
        try await Self.waitForLoad(webView)
        let focused = try await webView.evaluateJavaScript(
            "document.getElementById('title').focus(); document.activeElement.id",
        )
        #expect(focused as? String == "title")
        // Even asked outright, the shelf's window does not become key.
        shelf.makeKey()
        try await Task.sleep(for: .milliseconds(200))

        #expect(!shelf.isKeyWindow)
        #expect(Self.keyWindow() === keyBefore)
        webView.removeFromSuperview()
    }

    private static func keyWindow() -> UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)
    }

    private static func waitForLoad(_ webView: WKWebView) async throws {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            let state = try? await webView.evaluateJavaScript("document.readyState")
            if !webView.isLoading, state as? String == "complete" {
                return
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        Issue.record("the page did not load")
    }
}
