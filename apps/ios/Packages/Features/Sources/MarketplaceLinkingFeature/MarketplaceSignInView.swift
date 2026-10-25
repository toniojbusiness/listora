import DesignSystem
import SwiftUI
import WebKit

/// The marketplace's own sign-in page inside Listora. The web view has its own data store that
/// is never written to disk and starts empty every time, so each sign-in is fresh and nothing
/// from it outlives the screen except the cookies handed to Listora. The page is the
/// marketplace's: the user types their password and any two-step code into it, and the app
/// never reads the page or runs a script in it. When the user taps "I'm signed in", the app
/// takes the site's cookies from the web view's cookie store.
struct MarketplaceSignInView: View {
    let link: MarketplaceLink
    let onCancel: () -> Void
    let onSignedIn: ([HTTPCookie]) -> Void

    @State private var dataStore = WKWebsiteDataStore.nonPersistent()
    @State private var loading = true
    @State private var collecting = false

    var body: some View {
        NavigationStack {
            SignInWebView(url: link.loginURL, dataStore: dataStore, loading: $loading)
                .accessibilityIdentifier("signIn.webView")
                .overlay(alignment: .top) {
                    if loading {
                        ProgressView()
                            .padding(Spacing.md)
                    }
                }
                .safeAreaInset(edge: .bottom) {
                    Text("Sign in on \(link.name)'s page. Listora keeps the sign-in session, never your password.")
                        .font(Typography.caption)
                        .foregroundStyle(Palette.textSecondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(Spacing.sm)
                        .background(Palette.surface)
                }
                .navigationTitle(link.name)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel", action: onCancel)
                            .accessibilityIdentifier("signIn.cancel")
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("I'm signed in") {
                            collecting = true
                            Task {
                                let cookies = await dataStore.httpCookieStore.allCookies()
                                onSignedIn(cookies)
                            }
                        }
                        .disabled(collecting)
                        .accessibilityIdentifier("signIn.done")
                    }
                }
        }
        .tint(Palette.brand.color)
    }
}

/// A `WKWebView` on `dataStore` that opens `url` and reports whether a page is loading.
private struct SignInWebView: UIViewRepresentable {
    let url: URL
    let dataStore: WKWebsiteDataStore
    @Binding var loading: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator(loading: $loading)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_: WKWebView, context _: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let loading: Binding<Bool>

        init(loading: Binding<Bool>) {
            self.loading = loading
        }

        /// Web pages only: a sign-in page that tries to open another app or a custom scheme is
        /// refused, so the sign-in stays in this web view.
        func webView(
            _: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
        ) async -> WKNavigationActionPolicy {
            let scheme = navigationAction.request.url?.scheme?.lowercased()
            return scheme == "https" || scheme == "http" || scheme == "about" ? .allow : .cancel
        }

        func webView(_: WKWebView, didStartProvisionalNavigation _: WKNavigation?) {
            loading.wrappedValue = true
        }

        func webView(_: WKWebView, didFinish _: WKNavigation?) {
            loading.wrappedValue = false
        }

        func webView(_: WKWebView, didFail _: WKNavigation?, withError _: any Error) {
            loading.wrappedValue = false
        }

        func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation?, withError _: any Error) {
            loading.wrappedValue = false
        }
    }
}
