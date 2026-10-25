import APIClient
import Core
import DesignSystem
import ShareLinkFeature
import SwiftUI
import UIKit

/// The Share Extension entry point: reads what was shared (only its URLs, text, and title;
/// never the page itself) and shows `ShareLinkView`, which links the listing to an item.
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
            root = try AnyView(ShareLinkView(model: makeModel(content: content), onClose: close))
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

    private func makeModel(content: SharedContent) throws(ConfigurationError) -> ShareLinkModel {
        var configuration = try AppConfiguration(bundle: .main)
        #if DEBUG
            configuration = DevOverrides.applied(to: configuration)
        #endif
        // The session the app signed in with, from the App Group keychain, renewed with the same
        // Cognito client as the app's (AppDependencies) when its token expires.
        let accessTokens = AccessTokenStore(
            storage: KeychainAccessGrantStorage.session(appGroup: configuration.appGroupIdentifier),
            refresher: configuration.cognito.map { CognitoSignInClient(region: $0.region, clientID: $0.clientID) },
        )
        let api = APIClient(baseURL: configuration.apiBaseURL, accessTokens: accessTokens)
        return ShareLinkModel(content: content, service: APIListingLinkService(api: api, accessTokens: accessTokens))
    }
}
