import DesignSystem
import SwiftUI

/// The first screen of a signed-out app: what Listora is, and the email to sign in with.
struct WelcomeView: View {
    @Bindable var model: SignInModel
    @FocusState private var emailFocused: Bool
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        ScrollView {
            VStack(spacing: Spacing.xl) {
                header
                if let notice = model.notice {
                    Banner(
                        notice,
                        tone: .actionNeeded,
                        systemImage: "clock.badge.exclamationmark",
                        identifier: "signIn.notice",
                    )
                }
                if model.stage == .unavailable {
                    Banner(
                        "This build can't sign in",
                        message: "It has no Cognito app client (COGNITO_CLIENT_ID in its xcconfig).",
                        tone: .failed,
                        identifier: "signIn.unavailable",
                    )
                } else {
                    form
                }
            }
            .padding(.horizontal, Spacing.lg)
            .padding(.top, typeSize.isAccessibilitySize ? Spacing.md : Spacing.xxl)
            .padding(.bottom, Spacing.xl)
            .frame(maxWidth: Layout.readableWidth)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Palette.background)
        // Pinned above the keyboard, so Continue stays in reach at every text size.
        .bottomActionBar {
            if model.stage != .unavailable {
                Button("Continue", action: requestCode)
                    .buttonStyle(.listoraPrimary)
                    .disabled(!model.canRequestCode)
                    .loading(model.isWorking)
                    .accessibilityIdentifier("signIn.continue")
            }
        }
        .toolbar(.hidden, for: .navigationBar)
    }

    private var header: some View {
        VStack(spacing: Spacing.md) {
            // At the accessibility sizes the art gives its room to the words and the email.
            if !typeSize.isAccessibilitySize {
                IconTile(systemImage: "tag.fill", size: .hero)
            }
            VStack(spacing: Spacing.xs) {
                Text("Listora")
                    .font(Typography.largeTitle)
                    .foregroundStyle(Palette.brand)
                    .accessibilityAddTraits(.isHeader)
                Text("Take photos once, create the item once, and manage it everywhere you sell.")
                    .font(Typography.body)
                    .foregroundStyle(Palette.textSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("signIn.valueStatement")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("signIn.welcome")
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            ListoraTextField("Email", hint: emailHint) {
                TextField(
                    "Email",
                    text: $model.email,
                    prompt: Text(verbatim: "you@example.com").foregroundStyle(Palette.textSecondary),
                )
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.continue)
                .focused($emailFocused)
                .onSubmit(requestCode)
                .accessibilityIdentifier("signIn.email")
            }
            if let problem = model.problem {
                Banner(problem.message, tone: .failed, identifier: "signIn.message")
            }
        }
        .cardStyle(.elevated)
    }

    private func requestCode() {
        guard model.canRequestCode else { return }
        emailFocused = false
        Task { await model.requestCode() }
    }

    private var emailHint: String {
        model.kind == .developer
            ? "Dev build: the code is printed to the local API's log."
            : "The email your Listora account was set up with. We'll email you a code; no password needed."
    }
}
