import DesignSystem
import SwiftUI
import UIKit

/// The Share Extension entry point. Placeholder until T-22 links a shared marketplace listing to
/// an item; for now it explains that and closes.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: SharePlaceholderView { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        })
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }
}

private struct SharePlaceholderView: View {
    let onDone: @MainActor () -> Void

    var body: some View {
        NavigationStack {
            EmptyStateView(
                systemImage: "link",
                title: "Coming soon",
                message: "Share a marketplace listing here to link it to an item in Listora.",
            )
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: onDone)
                }
            }
        }
        .tint(Palette.brand.color)
    }
}
