import DesignSystem
import SwiftUI

/// The app's root while nobody is signed in: the welcome screen with the email, then the code
/// screen pushed over it. Going back from the code screen starts over with the email.
public struct SignInFlowView: View {
    @Bindable private var model: SignInModel

    public init(model: SignInModel) {
        self.model = model
    }

    public var body: some View {
        NavigationStack {
            WelcomeView(model: model)
                .navigationDestination(isPresented: codeStepShown) {
                    CodeEntryView(model: model)
                }
        }
        .tint(Palette.brand.color)
    }

    private var codeStepShown: Binding<Bool> {
        Binding(
            get: { model.stage == .enterCode },
            set: { shown in
                if !shown, model.stage == .enterCode {
                    model.startOver()
                }
            },
        )
    }
}
