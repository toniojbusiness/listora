import Foundation
import Testing
@testable import AppFeature

/// The first-run guide shows once, right after the first sign-in on this iPhone.
@MainActor
struct GettingStartedTests {
    private let defaults = UserDefaults(suiteName: "GettingStartedTests-\(UUID().uuidString)") ?? .standard

    @Test
    func `shows when the seller signs in while the app runs, and never again once done`() {
        let model = GettingStartedModel(defaults: defaults)
        model.signedInChanged(false)
        #expect(!model.isPresented)

        model.signedInChanged(true)
        #expect(model.isPresented)

        model.finish()
        #expect(!model.isPresented)
        model.signedInChanged(false)
        model.signedInChanged(true)
        #expect(!model.isPresented, "signing out and in again does not repeat it")

        let relaunched = GettingStartedModel(defaults: defaults)
        relaunched.signedInChanged(false)
        relaunched.signedInChanged(true)
        #expect(!relaunched.isPresented, "the flag survives a relaunch")
    }

    @Test
    func `a session that already exists at launch does not show it`() {
        let model = GettingStartedModel(defaults: defaults)
        model.signedInChanged(true)
        model.signedInChanged(true)
        #expect(!model.isPresented)
    }

    @Test
    func `skipping counts as done`() {
        let model = GettingStartedModel(defaults: defaults, showsNow: true)
        #expect(model.isPresented)
        model.finish()
        let again = GettingStartedModel(defaults: defaults)
        again.signedInChanged(false)
        again.signedInChanged(true)
        #expect(!again.isPresented)
    }

    @Test
    func `resetting the local data shows it again after the next sign-in`() {
        let model = GettingStartedModel(defaults: defaults)
        model.finish()
        GettingStartedModel.resetLocalData(defaults: defaults)
        let fresh = GettingStartedModel(defaults: defaults)
        fresh.signedInChanged(false)
        fresh.signedInChanged(true)
        #expect(fresh.isPresented)
    }

    @Test
    func `three short steps: link marketplaces, add the first item, see it listed`() {
        #expect(GettingStartedView.steps.map(\.title) == [
            "Link your marketplaces", "Add your first item", "See it listed",
        ])
    }

    @Test
    func `the screenshot tour's launch switch shows it at once`() {
        #expect(DebugLaunchOptions.from(environment: ["LISTORA_SHOW_GETTING_STARTED": "1"]).showsGettingStarted)
        #expect(!DebugLaunchOptions.from(environment: [:]).showsGettingStarted)
    }
}
