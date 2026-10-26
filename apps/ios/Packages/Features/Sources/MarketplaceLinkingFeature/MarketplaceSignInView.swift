import DesignSystem
import SwiftUI
import WebKit

/// The marketplace's own sign-in page inside Listora. The web view has its own data store that
/// is never written to disk and starts empty every time, so each sign-in is fresh and nothing
/// from it outlives the screen except the cookies handed to Listora. The page is the
/// marketplace's: the user types their password and any two-step code into it, and the app
/// never reads the page or runs a script in it. When the user taps "I'm signed in", the app
/// takes the site's cookies from the web view's cookie store.
///
/// A marketplace that signs in with a link it emails (Depop) gets the steps to bring that link
/// here instead of tapping it, which would sign in the phone's default browser: copy it and tap
/// Paste (the system's paste button, so iOS asks no permission), or share it to Listora. The
/// link opens in this same page (`MarketplaceSignInModel`).
struct MarketplaceSignInView: View {
    let onCancel: () -> Void
    let onSignedIn: ([HTTPCookie]) -> Void

    @State private var model: MarketplaceSignInModel
    @State private var dataStore = WKWebsiteDataStore.nonPersistent()
    @State private var loading = true
    @State private var collecting = false
    @Environment(\.scenePhase) private var scenePhase

    init(
        model: MarketplaceSignInModel,
        onCancel: @escaping () -> Void,
        onSignedIn: @escaping ([HTTPCookie]) -> Void,
    ) {
        _model = State(initialValue: model)
        self.onCancel = onCancel
        self.onSignedIn = onSignedIn
    }

    private var link: MarketplaceLink {
        model.link
    }

    var body: some View {
        NavigationStack {
            SignInWebView(navigation: model.navigation, dataStore: dataStore, loading: $loading)
                .accessibilityIdentifier("signIn.webView")
                .overlay(alignment: .top) {
                    if loading {
                        ProgressView()
                            .padding(Spacing.md)
                    }
                }
                .safeAreaInset(edge: .bottom) {
                    VStack(spacing: Spacing.sm) {
                        if model.rule != nil {
                            EmailedLinkSteps(model: model)
                        }
                        Text("Sign in on \(link.name)'s page. Listora keeps the sign-in session, never your password.")
                            .font(Typography.caption)
                            .foregroundStyle(Palette.textSecondary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                    }
                    .padding(Spacing.sm)
                    .background(Palette.surface)
                    // A hairline edge, so the steps don't run into the marketplace's page.
                    .overlay(alignment: .top) { Divider() }
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
        .onAppear { model.appeared() }
        .onDisappear { model.closed() }
        .onChange(of: scenePhase) { _, phase in
            // Back from sharing the link to Listora: open it.
            if phase == .active {
                model.becameActive()
            }
        }
    }
}

/// How to bring the marketplace's emailed sign-in link into this page, and the Paste button.
private struct EmailedLinkSteps: View {
    let model: MarketplaceSignInModel

    private var name: String {
        model.link.name
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            if model.openedEmailedLink {
                Label(
                    "Opened your sign-in link. Once \(name) shows you're signed in, tap I'm signed in.",
                    systemImage: "checkmark.circle",
                )
                .font(Typography.subheadline)
                .accessibilityIdentifier("signIn.linkOpened")
            } else {
                Text("\(name) emailed you a sign-in link?")
                    .font(Typography.headline)
                Text(
                    "Don't tap it: it would sign you in to your browser, not Listora. "
                        + "Press and hold the \(name) link. If a preview opens, tap Hide preview, then Copy link. "
                        + "Then come back and tap Paste sign-in link.",
                )
                .font(Typography.subheadline)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("signIn.emailedLinkSteps")
            }
            HStack(spacing: Spacing.sm) {
                PasteButton(supportedContentTypes: [.url, .plainText]) { providers in
                    let pasted = PastedText(providers)
                    Task {
                        let texts = await pasted.load()
                        await MainActor.run { model.paste(texts) }
                    }
                }
                .buttonBorderShape(.capsule)
                .labelStyle(.titleAndIcon)
                .accessibilityIdentifier("signIn.pasteLink")
                Text("Paste sign-in link")
                    .font(Typography.subheadline.weight(.semibold))
                    .accessibilityHidden(true)
            }
            Text("Or press and hold the link, tap Share, then Listora.")
                .font(Typography.caption)
                .foregroundStyle(Palette.textSecondary)
            if let problem = model.linkProblem {
                Text(problem)
                    .font(Typography.caption)
                    .foregroundStyle(Palette.danger)
                    .accessibilityIdentifier("signIn.linkProblem")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("signIn.emailedLink")
    }
}

/// The links and text the system's paste button hands over. Item providers are read on their
/// own queues, and only plain strings cross back.
struct PastedText: @unchecked Sendable {
    /// Only read, never changed, after the paste button hands them over.
    private let providers: [NSItemProvider]

    init(_ providers: [NSItemProvider]) {
        self.providers = providers
    }

    func load() async -> [String] {
        var texts: [String] = []
        for provider in providers {
            if provider.canLoadObject(ofClass: URL.self), let url = await Self.loadURL(provider) {
                texts.append(url.absoluteString)
            }
            if provider.canLoadObject(ofClass: String.self), let text = await Self.loadString(provider) {
                texts.append(text)
            }
        }
        return texts
    }

    private static func loadURL(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                continuation.resume(returning: url)
            }
        }
    }

    private static func loadString(_ provider: NSItemProvider) async -> String? {
        await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: String.self) { text, _ in
                continuation.resume(returning: text)
            }
        }
    }
}

/// A `WKWebView` on `dataStore` that opens each `navigation` and reports whether a page is
/// loading.
private struct SignInWebView: UIViewRepresentable {
    let navigation: MarketplaceSignInModel.Navigation
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
        webView.load(URLRequest(url: navigation.url))
        context.coordinator.loaded = navigation.id
        return webView
    }

    /// A new navigation (an emailed sign-in link) opens in the same web view and data store.
    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.loaded != navigation.id else { return }
        context.coordinator.loaded = navigation.id
        webView.load(URLRequest(url: navigation.url))
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let loading: Binding<Bool>
        /// The navigation the web view opened last.
        var loaded: Int?

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
