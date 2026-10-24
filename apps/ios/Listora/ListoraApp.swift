import AppFeature
import SwiftUI

@main
struct ListoraApp: App {
    private let dependencies: AppDependencies

    init() {
        do {
            dependencies = try AppDependencies(bundle: .main)
        } catch {
            // A build with broken configuration must not start; the message names the key.
            fatalError(error.description)
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView(dependencies: dependencies)
        }
    }
}
