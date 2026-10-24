import AppFeature
import SwiftUI

@main
struct ListoraApp: App {
    private let dependencies: AppDependencies

    init() {
        do {
            dependencies = try AppDependencies(bundle: .main, launchOptions: .fromProcessEnvironment())
        } catch {
            // A build with broken configuration must not start; the message names the key.
            fatalError(error.description)
        }
        // Started here as well as by the root view: the system may launch the app in the
        // background only to deliver photo upload events.
        dependencies.startBackgroundWork()
    }

    var body: some Scene {
        WindowGroup {
            RootView(dependencies: dependencies)
        }
        .backgroundTask(.urlSession(AppDependencies.backgroundUploadSessionIdentifier)) { [dependencies] in
            await dependencies.handleBackgroundUploadEvents()
        }
    }
}
