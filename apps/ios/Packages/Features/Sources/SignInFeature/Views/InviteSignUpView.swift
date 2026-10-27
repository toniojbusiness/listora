import DesignSystem
import SwiftUI

/// Signing up with an invite: the code from the invite and the person's own email. Continue redeems
/// the invite, then the sign-in goes on with the code emailed to that address, as for anyone. While
/// the address waits for its verification link, the screen says so, and Continue tries again.
struct InviteSignUpView: View {
    @Bindable var signIn: SignInModel
    @Bindable var model: InviteSignUpModel
    @FocusState private var focus: Field?

    private enum Field {
        case code
        case email
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Wordmark(size: 32)
                        .padding(.bottom, Spacing.xs)
                    Text("Sign up with an invite")
                        .font(Typography.title)
                        .foregroundStyle(Palette.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                    Text("Enter the code you were sent and your own email. Your Listora account is yours alone.")
                        .font(Typography.body)
                        .foregroundStyle(Palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                form
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.lg)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Palette.background)
        .bottomActionBar {
            Button("Continue", action: redeem)
                .buttonStyle(.listoraPrimary)
                .disabled(!model.canRedeem || signIn.isWorking)
                .loading(model.isWorking || signIn.isWorking)
                .accessibilityIdentifier("invite.continue")
        }
        .navigationBarTitleDisplayMode(.inline)
        .navigationTitle("Sign up")
        .onAppear { focus = model.code.isEmpty ? .code : .email }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            ListoraTextField("Invite code", hint: "16 letters and digits, like K7QD-3M9P-XW2T-H8RA.") {
                TextField(
                    "Invite code",
                    text: $model.code,
                    prompt: Text(verbatim: "XXXX-XXXX-XXXX-XXXX").foregroundStyle(Palette.textSecondary),
                )
                .font(Typography.code)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .submitLabel(.next)
                .focused($focus, equals: .code)
                .onSubmit { focus = .email }
                .accessibilityIdentifier("invite.code")
            }
            ListoraTextField(
                "Your email",
                hint: "You'll sign in with it. We'll email you a code; no password needed.",
            ) {
                TextField(
                    "Your email",
                    text: $model.email,
                    prompt: Text(verbatim: "you@example.com").foregroundStyle(Palette.textSecondary),
                )
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.continue)
                .focused($focus, equals: .email)
                .onSubmit(redeem)
                .onChange(of: model.email) { model.emailChanged() }
                .accessibilityIdentifier("invite.email")
            }
            if let verification = model.verification {
                Banner(
                    "Verify your email first",
                    message: verification,
                    tone: .actionNeeded,
                    systemImage: "envelope.badge",
                    identifier: "invite.verification",
                )
            }
            if let problem = model.problem ?? signIn.problem?.message {
                Banner(problem, tone: .failed, identifier: "invite.message")
            }
        }
        .cardStyle(.elevated)
    }

    private func redeem() {
        guard model.canRedeem else { return }
        focus = nil
        Task { await model.redeem() }
    }
}
