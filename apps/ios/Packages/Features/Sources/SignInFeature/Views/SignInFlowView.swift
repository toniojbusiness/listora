import DesignSystem
import SwiftUI

/// The app's root while nobody is signed in: the welcome screen with the email, then the code
/// screen pushed over it. Signing up with an invite pushes its screen first, and the code screen
/// over that. Going back from the code screen starts over with the email (or the invite).
public struct SignInFlowView: View {
    @Bindable private var model: SignInModel

    public init(model: SignInModel) {
        self.model = model
    }

    private enum Step: Hashable {
        case invite
        case code
    }

    public var body: some View {
        NavigationStack(path: path) {
            WelcomeView(model: model)
                .navigationDestination(for: Step.self) { step in
                    switch step {
                    case .invite:
                        if let invite = model.invite {
                            InviteSignUpView(signIn: model, model: invite)
                        }
                    case .code:
                        CodeEntryView(model: model)
                    }
                }
        }
        .tint(Palette.brand.color)
    }

    /// The screens follow the model: the invite screen while it is open, the code screen while a
    /// code is awaited. Going back closes them in the model too.
    private var path: Binding<[Step]> {
        Binding(
            get: {
                (model.showsInvite && model.invite != nil ? [Step.invite] : [])
                    + (model.stage == .enterCode ? [Step.code] : [])
            },
            set: { steps in
                if !steps.contains(.code), model.stage == .enterCode {
                    model.startOver()
                }
                if !steps.contains(.invite) {
                    model.showsInvite = false
                }
            },
        )
    }
}
