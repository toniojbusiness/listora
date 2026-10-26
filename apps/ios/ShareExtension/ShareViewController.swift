import APIClient
import Core
import DesignSystem
import ShareLinkFeature
import SwiftUI
import UIKit

/// The Share Extension entry point: reads what was shared (only its URLs, text, and title;
/// never the page itself) and shows `ShareLinkView`, which links the listing to an item. While
/// Listora's sign-in page for a marketplace waits for the sign-in link that marketplace emailed
/// (Depop), a share of that link goes to the sign-in page instead (`SignInLinkHandoff`).
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.background.color)
        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        let shared = SharedItems(items)
        Task { @MainActor [weak self] in
            let content = await shared.load()
            self?.show(content)
        }
    }

    private func show(_ content: SharedContent) {
        let close: @MainActor () -> Void = { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
        let root: AnyView
        do {
            let configuration = try Self.configuration()
            let signInLinks = KeychainSignInLinkHandoff(accessGroup: configuration.sessionKeychainGroup)
            if let request = signInLinks.deliver(from: content) {
                root = AnyView(SignInLinkSentView(name: request.name, onClose: close))
            } else {
                root = AnyView(ShareLinkView(model: makeModel(configuration, content: content), onClose: close))
            }
        } catch {
            // The extension must never crash the sharing app: explain instead.
            root = AnyView(NavigationStack {
                EmptyStateView(
                    systemImage: "exclamationmark.triangle",
                    title: "Listora is misconfigured",
                    message: error.description,
                    action: .init("Close", handler: close),
                )
            })
        }
        let host = UIHostingController(rootView: root)
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    private static func configuration() throws(ConfigurationError) -> AppConfiguration {
        var configuration = try AppConfiguration(bundle: .main)
        #if DEBUG
            configuration = DevOverrides.applied(to: configuration)
        #endif
        return configuration
    }

    private func makeModel(_ configuration: AppConfiguration, content: SharedContent) -> ShareLinkModel {
        // The session the app signed in with, from the App Group keychain, renewed with the same
        // Cognito client as the app's (AppDependencies) when its token expires.
        let accessTokens = AccessTokenStore(
            storage: KeychainAccessGrantStorage.session(accessGroup: configuration.sessionKeychainGroup),
            refresher: configuration.cognito.map { CognitoSignInClient(region: $0.region, clientID: $0.clientID) },
        )
        let api = APIClient(baseURL: configuration.apiBaseURL, accessTokens: accessTokens)
        return ShareLinkModel(content: content, service: APIListingLinkService(api: api, accessTokens: accessTokens))
    }
}

/// The shared sign-in link is waiting for Listora's sign-in page: the user goes back to Listora,
/// where it opens. (An extension cannot open its app itself.)
private struct SignInLinkSentView: View {
    let name: String
    let onClose: @MainActor () -> Void

    var body: some View {
        NavigationStack {
            EmptyStateView(
                systemImage: "checkmark.circle",
                title: "Sign-in link sent to Listora",
                message: "Go back to Listora to finish signing in to \(name). It opens there, not in your browser.",
                action: .init("Done", handler: onClose),
            )
            .accessibilityIdentifier("share.signInLinkSent")
        }
    }
}
